import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
// The client TYPE comes from @brandspace/database, which is the only package
// permitted to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import type { PrismaClient } from '@brandspace/database';
import { AppError, systemClock, type Clock } from '@brandspace/shared';
import { PLATFORM_REALM } from './realms';
import { verifyPassword } from './password';
import { hashRecoveryCode, recoveryCodeMatches, totpVerifier } from './mfa';

/**
 * Platform Admin sessions — docs/SECURITY.md §3, D-27.
 *
 * SERVER-SIDE ENFORCEMENT. Every check here runs on the server against the
 * database. Nothing about a request's admin access is decided by client code,
 * a middleware redirect, or a rendered route: those improve the experience,
 * they are not the control.
 *
 * A session progresses through two states and is USELESS in the first:
 *
 *   1. created at password login  -> mfaVerifiedAt IS NULL -> grants NOTHING
 *   2. after a valid TOTP or recovery code -> mfaVerifiedAt set -> usable
 *
 * `requirePlatformSession()` rejects state 1, so a stolen pre-MFA cookie is
 * worth nothing.
 */

/**
 * Brute-force protection.
 *
 * Ten wrong attempts locks the account for fifteen minutes. Both halves of the
 * sign-in count: a stolen password plus a guessed six-digit code is the
 * realistic attack, and without this the second half is 10^6 attempts against a
 * server that answers as fast as it can.
 *
 * A locked account is refused with the SAME message as a wrong password, so the
 * endpoint still cannot be used to discover which accounts exist.
 */
export const MAX_FAILED_ATTEMPTS = 10;
export const LOCKOUT_MINUTES = 15;

/** Platform roles permitted to reach the Control Center at all. */
export const ADMIN_CAPABLE_ROLES = new Set([
  'platform_owner',
  'platform_admin',
  'support_agent',
  'billing_manager',
  'operations_viewer',
]);

export interface PlatformSessionToken {
  /** Raw token — goes in the cookie ONLY, never stored. */
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

export interface AuthenticatedPlatformActor {
  readonly platformUserId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly name: string | null;
  readonly roleKey: string;
  readonly permissionKeys: readonly string[];
  readonly mfaVerified: boolean;
  readonly stepUpVerifiedAt: Date | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface PlatformAuthOptions {
  /** MUST be the platform pool. Tenant connections cannot read these tables. */
  readonly prisma: PrismaClient;
  /** Resolves the TOTP secret from the Secret Service. */
  readonly resolveMfaSecret?: (secretRef: string) => Promise<string>;
  /**
   * Injected so session expiry can be tested without waiting four hours.
   * Every time reference in this class goes through it.
   */
  readonly clock?: Clock;
}

export class PlatformAuthService {
  readonly #prisma: PrismaClient;
  readonly #resolveMfaSecret: ((secretRef: string) => Promise<string>) | undefined;
  readonly #clock: Clock;

  constructor(options: PlatformAuthOptions) {
    this.#prisma = options.prisma;
    this.#resolveMfaSecret = options.resolveMfaSecret;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Step 1 — password. Creates a session that is NOT yet usable.
   *
   * Failures are deliberately indistinguishable: unknown email, wrong password
   * and disabled account all produce the same error and the same work, so the
   * endpoint cannot be used to enumerate platform staff.
   */
  async authenticateWithPassword(input: {
    email: string;
    password: string;
    ip?: string;
    userAgent?: string;
  }): Promise<{ session: PlatformSessionToken; mfaRequired: true; mfaEnrolled: boolean }> {
    const user = await this.#prisma.platformUser.findUnique({
      where: { email: input.email.toLowerCase().trim() },
      include: { role: true },
    });

    const storedHash =
      user?.passwordHash ??
      // Dummy verify against a real Argon2 hash so a missing user costs the
      // same time as a wrong password.
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$3B2ZQFvJ8Y0Z8Z0Z8Z0Z8Z0Z8Z0Z8Z0Z8Z0Z8Z0Z8Z0';
    const passwordOk = await verifyPassword(storedHash, input.password);

    // Checked AFTER the hash comparison, so a locked account costs the same
    // time as any other failure and is indistinguishable from one.
    const lockedUntil = user?.lockedUntil ?? null;
    if (user && lockedUntil && lockedUntil.getTime() > this.#clock.now().getTime()) {
      await this.#auditDenied(user.id, 'platform.login.locked', input.ip, input.userAgent);
      throw new AppError('UNAUTHENTICATED', 'Invalid credentials.');
    }

    if (!user || !passwordOk || user.status !== 'ACTIVE') {
      if (user) await this.#recordFailedAttempt(user.id, user.failedLoginCount);
      await this.#auditDenied(user?.id ?? null, 'platform.login.failed', input.ip, input.userAgent);
      throw new AppError('UNAUTHENTICATED', 'Invalid credentials.');
    }
    if (!ADMIN_CAPABLE_ROLES.has(user.role.key)) {
      await this.#auditDenied(user.id, 'platform.login.role_denied', input.ip, input.userAgent);
      throw new AppError('FORBIDDEN', 'This account may not access the Control Center.');
    }

    const session = await this.#createSession(user.id, input.ip, input.userAgent);
    await this.#prisma.auditEvent.create({
      data: {
        workspaceId: null,
        actorType: 'PLATFORM_USER',
        actorId: user.id,
        action: 'platform.login.password_ok',
        severity: 'NOTICE',
        outcome: 'SUCCESS',
        reason: 'Password accepted; awaiting MFA',
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });

    // D-27: MFA is never optional for a platform role.
    return { session, mfaRequired: true, mfaEnrolled: user.mfaEnabled };
  }

  /** Step 2 — MFA. Only this makes the session usable. */
  async verifyMfa(input: {
    token: string;
    code: string;
    ip?: string;
  }): Promise<AuthenticatedPlatformActor> {
    const session = await this.#loadSession(input.token);
    const user = await this.#prisma.platformUser.findUniqueOrThrow({
      where: { id: session.platformUserId },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });

    if (!user.mfaEnabled || !user.mfaSecretRef) {
      throw new AppError('FORBIDDEN', 'MFA enrolment is required before signing in (D-27).');
    }
    if (!this.#resolveMfaSecret) {
      throw new AppError('INTERNAL', 'MFA secret resolution is not configured.');
    }

    const secret = await this.#resolveMfaSecret(user.mfaSecretRef);
    const codeOk = totpVerifier.verify({ secret, token: input.code });

    if (!codeOk) {
      const recovered = await this.#tryRecoveryCode(user.id, input.code);
      if (!recovered) {
        // The second factor is six digits. Without a limit here, holding the
        // password reduces the account to a million guesses.
        await this.#recordFailedAttempt(user.id, user.failedLoginCount);
        await this.#auditDenied(user.id, 'platform.mfa.failed', input.ip, undefined);
        throw new AppError('UNAUTHENTICATED', 'Invalid verification code.');
      }
    }

    await this.#prisma.platformSession.update({
      where: { id: session.id },
      data: { mfaVerifiedAt: this.#clock.now(), lastSeenAt: this.#clock.now() },
    });
    await this.#prisma.platformUser.update({
      where: { id: user.id },
      data: { lastLoginAt: this.#clock.now(), failedLoginCount: 0, lockedUntil: null },
    });
    await this.#prisma.auditEvent.create({
      data: {
        workspaceId: null,
        actorType: 'PLATFORM_USER',
        actorId: user.id,
        action: 'platform.login.succeeded',
        severity: 'NOTICE',
        outcome: 'SUCCESS',
        reason: codeOk ? 'MFA verified (TOTP)' : 'MFA verified (recovery code)',
        ip: input.ip ?? null,
      },
    });

    return {
      platformUserId: user.id,
      sessionId: session.id,
      email: user.email,
      name: user.name,
      roleKey: user.role.key,
      permissionKeys: user.role.permissions.map((rp) => rp.permission.key),
      mfaVerified: true,
      stepUpVerifiedAt: null,
    };
  }

  /**
   * Resolve a request's actor. THE server-side gate for every admin page and
   * API route. Returns null rather than throwing so callers redirect cleanly.
   */
  async resolveActor(token: string | undefined): Promise<AuthenticatedPlatformActor | null> {
    if (!token) return null;
    let session;
    try {
      session = await this.#loadSession(token);
    } catch {
      return null;
    }
    // A session that has not passed MFA grants nothing at all.
    if (!session.mfaVerifiedAt) return null;

    const user = await this.#prisma.platformUser.findUnique({
      where: { id: session.platformUserId },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
    if (!user || user.status !== 'ACTIVE') return null;
    if (!ADMIN_CAPABLE_ROLES.has(user.role.key)) return null;

    await this.#prisma.platformSession
      .update({ where: { id: session.id }, data: { lastSeenAt: this.#clock.now() } })
      .catch(() => {
        // Touch failure must never fail the request.
      });

    return {
      platformUserId: user.id,
      sessionId: session.id,
      email: user.email,
      name: user.name,
      roleKey: user.role.key,
      permissionKeys: user.role.permissions.map((rp) => rp.permission.key),
      mfaVerified: true,
      stepUpVerifiedAt: session.stepUpVerifiedAt,
    };
  }

  async revokeSession(token: string, reason: string): Promise<void> {
    const tokenHash = hashToken(token);
    await this.#prisma.platformSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: this.#clock.now(), revokedReason: reason },
    });
  }

  async revokeAllSessions(platformUserId: string, reason: string): Promise<number> {
    const result = await this.#prisma.platformSession.updateMany({
      where: { platformUserId, revokedAt: null },
      data: { revokedAt: this.#clock.now(), revokedReason: reason },
    });
    return result.count;
  }

  /** Store hashed recovery codes, replacing any existing set. */
  async storeRecoveryCodes(platformUserId: string, codes: readonly string[]): Promise<void> {
    await this.#prisma.$transaction(async (tx) => {
      await tx.platformMfaRecoveryCode.deleteMany({ where: { platformUserId } });
      await tx.platformMfaRecoveryCode.createMany({
        data: codes.map((code) => ({ platformUserId, codeHash: hashRecoveryCode(code) })),
      });
    });
  }

  async #tryRecoveryCode(platformUserId: string, code: string): Promise<boolean> {
    const candidateHash = hashRecoveryCode(code);
    const unused = await this.#prisma.platformMfaRecoveryCode.findMany({
      where: { platformUserId, usedAt: null },
    });
    const match = unused.find((row) => recoveryCodeMatches(candidateHash, row.codeHash));
    if (!match) return false;
    // Single use: burn it immediately.
    await this.#prisma.platformMfaRecoveryCode.update({
      where: { id: match.id },
      data: { usedAt: this.#clock.now() },
    });
    return true;
  }

  /**
   * Count a failed attempt and lock the account once the limit is reached.
   *
   * The counter resets when the lock is applied, so the next window starts
   * clean rather than locking again on the first attempt after expiry.
   */
  async #recordFailedAttempt(platformUserId: string, currentCount: number): Promise<void> {
    const next = currentCount + 1;
    const lock = next >= MAX_FAILED_ATTEMPTS;
    await this.#prisma.platformUser
      .update({
        where: { id: platformUserId },
        data: lock
          ? {
              failedLoginCount: 0,
              lockedUntil: new Date(this.#clock.now().getTime() + LOCKOUT_MINUTES * 60_000),
            }
          : { failedLoginCount: next },
      })
      .catch(() => {
        // A counter that cannot be written must not change the auth outcome —
        // the attempt is still refused.
      });
  }

  async #createSession(
    platformUserId: string,
    ip?: string,
    userAgent?: string,
  ): Promise<PlatformSessionToken> {
    const token = randomBytes(32).toString('base64url');
    const now = this.#clock.now().getTime();
    const expiresAt = new Date(now + PLATFORM_REALM.sessionTtlSeconds * 1000);
    const created = await this.#prisma.platformSession.create({
      data: {
        platformUserId,
        tokenHash: hashToken(token),
        expiresAt,
        absoluteExpiresAt: new Date(now + PLATFORM_REALM.absoluteTtlSeconds * 1000),
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      },
    });
    return { token, sessionId: created.id, expiresAt };
  }

  async #loadSession(token: string) {
    const tokenHash = hashToken(token);
    const session = await this.#prisma.platformSession.findUnique({ where: { tokenHash } });
    if (!session) throw new AppError('UNAUTHENTICATED', 'Session not found.');
    if (!constantTimeEqual(session.tokenHash, tokenHash)) {
      throw new AppError('UNAUTHENTICATED', 'Session not found.');
    }
    const now = this.#clock.now().getTime();
    if (session.revokedAt) throw new AppError('UNAUTHENTICATED', 'Session revoked.');
    if (session.expiresAt.getTime() < now)
      throw new AppError('UNAUTHENTICATED', 'Session expired.');
    if (session.absoluteExpiresAt.getTime() < now) {
      throw new AppError('UNAUTHENTICATED', 'Session reached its absolute lifetime.');
    }
    return session;
  }

  async #auditDenied(
    actorId: string | null,
    action: string,
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    // Denials are audited too — repeated denials are a detection signal
    // (docs/SECURITY.md §7).
    await this.#prisma.auditEvent
      .create({
        data: {
          workspaceId: null,
          actorType: 'PLATFORM_USER',
          actorId,
          action,
          severity: 'WARNING',
          outcome: 'DENIED',
          reason: 'Platform authentication denied',
          ip: ip ?? null,
          userAgent: userAgent ?? null,
        },
      })
      .catch(() => {
        // Never turn an audit failure into a different auth outcome.
      });
  }
}

/** Permission check. Used by every admin route handler. */
export function requirePermission(
  actor: AuthenticatedPlatformActor | null,
  permissionKey: string,
): AuthenticatedPlatformActor {
  if (!actor) throw new AppError('UNAUTHENTICATED', 'Platform authentication required.');
  if (!actor.mfaVerified) throw new AppError('FORBIDDEN', 'MFA verification required (D-27).');
  if (!actor.permissionKeys.includes(permissionKey)) {
    throw new AppError('FORBIDDEN', `Missing platform permission: ${permissionKey}`);
  }
  return actor;
}
