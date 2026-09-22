import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
// The client TYPE comes from @brandspace/database, the only package permitted
// to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import type { PrismaClient } from '@brandspace/database';
import { AppError, type Clock, systemClock } from '@brandspace/shared';
import { CUSTOMER_REALM } from './realms';
import { hashPassword, verifyPassword } from './password';
import { AuthRateLimiter, BOOTSTRAP_CEILINGS, type AbuseCeilings } from './rate-limit';

/**
 * Customer authentication — docs/SECURITY.md §3.
 *
 * SEPARATE FROM PLATFORM AUTHENTICATION BY CONSTRUCTION, not by policy:
 *
 *   - a different table (`customer_session` vs `platform_session`), so there is
 *     no shared store in which a token of the other realm could be found;
 *   - a different cookie name, audience and signing-key source (`realms.ts`);
 *   - a different service class, with no code path that reads the other table.
 *
 * A platform session token presented here resolves to `null` because its hash
 * is not in this table — not because a check rejected it. That distinction
 * matters: a missing check cannot re-enable what does not exist.
 *
 * WHAT A SESSION DOES NOT GRANT. Holding a session proves who you are. It never
 * proves what workspace you may act in: `activeWorkspaceId` is re-verified
 * against a live, non-removed `Membership` on every resolve, so revoking a
 * membership takes effect at the next request rather than at the next login.
 */

const GENERIC_FAILURE = 'Invalid credentials.';

/**
 * What an authentication audit event records beyond the action.
 *
 * IT EXISTS BECAUSE THE DEFAULTS WERE WRONG. `#audit` hard-coded
 * `outcome: 'DENIED'`, so a successful MFA verification was filed as a denial,
 * and it had no user-agent parameter at all, so the column was null on every
 * row this service has ever written.
 */
interface AuditContext {
  readonly outcome?: 'SUCCESS' | 'DENIED' | 'ERROR';
  readonly severity?: 'INFO' | 'NOTICE' | 'WARNING' | 'CRITICAL';
  readonly userAgent?: string | undefined;
}

/** Session/lockout policy. Same shape and thresholds as the platform realm. */
export const CUSTOMER_MAX_FAILED_ATTEMPTS = 10;
export const CUSTOMER_LOCKOUT_MINUTES = 15;

/**
 * The only account states in which a password reset may complete.
 *
 * PENDING, because completing a reset is exactly the proof of address control
 * that PENDING is waiting for. ACTIVE, because that is the ordinary case.
 *
 * SUSPENDED and DELETED are absent deliberately, and this set is the whole
 * reason: suspension is an administrative decision, and a link in the user's
 * own inbox must not be able to overturn it. Anything not listed here is
 * refused rather than reactivated.
 */
const RESETTABLE_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'ACTIVE']);

/**
 * A dummy Argon2id hash of a random value, verified when no user matched, so an
 * unknown email costs the same work as a known one. Without it, response time
 * is an oracle for "does this address have an account?".
 */
let enumerationGuardHash: string | null = null;
async function enumerationGuard(): Promise<void> {
  enumerationGuardHash ??= await hashPassword(randomBytes(32).toString('hex'));
  await verifyPassword(enumerationGuardHash, randomBytes(32).toString('hex'));
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 256 bits of entropy, URL-safe. Never stored — only its SHA-256 hash is. */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface CustomerSignInInput {
  readonly email: string;
  readonly password: string;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface CustomerSessionToken {
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
  /**
   * Phase 9. True when this session has presented a password and nothing else.
   * It resolves to NOTHING until `completeMfa` succeeds, so a caller that
   * ignores this flag gets a session that does not work rather than one that
   * works without a second factor.
   */
  readonly mfaRequired: boolean;
}

/** What a resolved customer session grants. Workspace scope is separate. */
export interface AuthenticatedCustomer {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly locale: 'AR' | 'EN';
  readonly sessionId: string;
  /** Null until a workspace is selected, or after the membership went away. */
  readonly activeWorkspaceId: string | null;
}

/** A membership the signed-in user may act under, with its effective grants. */
export interface CustomerWorkspaceContext {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceSlug: string;
  readonly workspaceStatus: string;
  readonly roleKey: string;
  readonly roleNameEn: string;
  readonly roleNameAr: string;
  readonly permissionKeys: readonly string[];
  readonly brandScope: readonly string[];
}

export interface CustomerAuthOptions {
  readonly prisma: PrismaClient;
  readonly clock?: Clock;
  /**
   * The activated abuse ceilings (F-19).
   *
   * OPTIONAL, AND THE DEFAULT IS NOT "NO LIMIT". A caller that has not read the
   * `onboarding` document still gets the schema defaults, because the one thing
   * this must never do is authenticate with the counter switched off.
   */
  readonly ceilings?: AbuseCeilings;
}

export class CustomerAuthService {
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;
  readonly #ceilings: AbuseCeilings;
  readonly #limiter: AuthRateLimiter;

  constructor(options: CustomerAuthOptions) {
    this.#prisma = options.prisma;
    this.#clock = options.clock ?? systemClock;
    this.#ceilings = options.ceilings ?? BOOTSTRAP_CEILINGS;
    this.#limiter = new AuthRateLimiter({ prisma: options.prisma, clock: this.#clock });
  }

  /**
   * Password sign-in.
   *
   * Every failure — unknown email, wrong password, unverified email, suspended
   * or deleted user, passwordless (invitation-only) account, locked account —
   * returns the SAME message after the SAME Argon2 work. The reason lives in
   * the audit log, where it helps an operator, and nowhere a caller can see it.
   */
  async signIn(input: CustomerSignInInput): Promise<CustomerSessionToken> {
    const email = input.email.trim().toLowerCase();

    /*
     * THE CEILINGS COME FIRST, BEFORE THE ADDRESS IS EVEN LOOKED UP (F-19).
     *
     * Before this, the only brake was a per-ACCOUNT lockout, which an attacker
     * spreading attempts across many accounts never touches — and which an
     * attacker can trip on purpose to lock somebody out. Both dimensions are
     * counted here, and counted on EVERY attempt rather than on failures only:
     * a limiter that counts failures can be starved by an attacker who already
     * knows one working credential, and the honest user who signs in twice is
     * nowhere near a ceiling measured in tens.
     *
     * The refusal is identical whether or not the address exists, so this is not
     * a new enumeration oracle: the per-source count is reached by making
     * requests, not by guessing whose they are.
     */
    await this.#limiter.enforce(
      'signin:ip',
      input.ip,
      this.#ceilings.signInPerIp,
      this.#ceilings.windowSeconds,
    );
    await this.#limiter.enforce(
      'signin:account',
      email,
      this.#ceilings.signInPerAccount,
      this.#ceilings.windowSeconds,
    );

    const user = await this.#prisma.user.findUnique({ where: { email } });

    if (!user) {
      await enumerationGuard();
      throw new AppError('UNAUTHENTICATED', GENERIC_FAILURE);
    }

    if (this.#isLocked(user.lockedUntil)) {
      await enumerationGuard();
      await this.#audit(user.id, 'customer.auth.locked', input.ip, false, {
        userAgent: input.userAgent,
      });
      throw new AppError('UNAUTHENTICATED', GENERIC_FAILURE);
    }

    if (!user.passwordHash) {
      // An invitation-only account. Doing the same work stops "no password set"
      // from being detectable by timing.
      await enumerationGuard();
      await this.#countFailure(user.id, 'customer.auth.no_password', input.ip, input.userAgent);
      throw new AppError('UNAUTHENTICATED', GENERIC_FAILURE);
    }

    const passwordOk = await verifyPassword(user.passwordHash, input.password);
    if (!passwordOk) {
      await this.#countFailure(user.id, 'customer.auth.bad_password', input.ip, input.userAgent);
      throw new AppError('UNAUTHENTICATED', GENERIC_FAILURE);
    }

    // Status is checked AFTER the password, so a wrong password on a suspended
    // account is indistinguishable from a wrong password on an active one.
    if (user.status !== 'ACTIVE' || user.deletedAt !== null) {
      await this.#audit(user.id, 'customer.auth.inactive', input.ip, false, {
        userAgent: input.userAgent,
      });
      throw new AppError('UNAUTHENTICATED', GENERIC_FAILURE);
    }

    await this.#prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: this.#clock.now() },
    });

    return this.#createSession(user.id, input.ip, input.userAgent, user.mfaEnabled);
  }

  /**
   * Present the second factor for a session that owes one.
   *
   * THE SESSION ALREADY EXISTS AND STILL GRANTS NOTHING. Keeping it lets the
   * second step be a separate request without holding the password anywhere,
   * and `resolve()` refuses it meanwhile — so a caller that forgets to call
   * this does not get a partly-authenticated session, it gets none.
   *
   * A WRONG CODE COUNTS AS A FAILED ATTEMPT. The second factor is six digits;
   * without a limit here, holding the password reduces the account to a million
   * guesses.
   */
  async completeMfa(input: {
    readonly token: string;
    readonly verify: (userId: string, code: string) => Promise<boolean>;
    readonly code: string;
    readonly ip?: string | undefined;
    readonly userAgent?: string | undefined;
  }): Promise<void> {
    /*
     * A SECOND FACTOR IS SIX DIGITS, so the per-account lockout below is the
     * load-bearing control — and it is per ACCOUNT. An attacker holding many
     * stolen passwords guesses one code each across many accounts and never
     * meets it, which is why the source is counted too.
     */
    await this.#limiter.enforce(
      'mfa:ip',
      input.ip,
      this.#ceilings.mfaPerIp,
      this.#ceilings.windowSeconds,
    );

    const session = await this.#prisma.customerSession.findUnique({
      where: { tokenHash: hashSessionToken(input.token) },
      select: { id: true, userId: true, revokedAt: true, expiresAt: true, mfaVerifiedAt: true },
    });
    const now = this.#clock.now();
    if (!session || session.revokedAt || session.expiresAt <= now) {
      // Identical to a wrong code. A revoked session must not be detectable.
      throw new AppError('UNAUTHENTICATED', GENERIC_FAILURE);
    }
    if (session.mfaVerifiedAt) return;

    await this.#limiter.enforce(
      'mfa:account',
      session.userId,
      this.#ceilings.mfaPerAccount,
      this.#ceilings.windowSeconds,
    );

    const user = await this.#prisma.user.findUnique({
      where: { id: session.userId },
      select: { lockedUntil: true },
    });
    if (this.#isLocked(user?.lockedUntil ?? null)) {
      await this.#audit(session.userId, 'customer.mfa.locked', input.ip, false, {
        userAgent: input.userAgent,
      });
      throw new AppError('UNAUTHENTICATED', GENERIC_FAILURE);
    }

    const ok = await input.verify(session.userId, input.code);
    if (!ok) {
      await this.#countFailure(session.userId, 'customer.mfa.failed', input.ip, input.userAgent);
      throw new AppError('UNAUTHENTICATED', GENERIC_FAILURE);
    }

    await this.#prisma.customerSession.update({
      where: { id: session.id },
      data: { mfaVerifiedAt: now, lastSeenAt: now },
    });
    await this.#prisma.user.update({
      where: { id: session.userId },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
    });
    // A SUCCESS, AND RECORDED AS ONE. This line used to file the completed
    // second factor as a DENIED/WARNING event like every refusal above it.
    await this.#audit(session.userId, 'customer.mfa.verified', input.ip, false, {
      outcome: 'SUCCESS',
      severity: 'NOTICE',
      userAgent: input.userAgent,
    });
  }

  /**
   * Resolve a session token to an authenticated customer.
   *
   * Returns null for: unknown token, expired, past absolute lifetime, revoked,
   * or a user who is no longer active. Fail-closed: any doubt is `null`.
   */
  async resolve(token: string): Promise<AuthenticatedCustomer | null> {
    if (!token) return null;
    const session = await this.#prisma.customerSession.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: { user: true },
    });
    if (!session) return null;

    const now = this.#clock.now();
    if (session.revokedAt) return null;
    if (session.expiresAt <= now) return null;
    if (session.absoluteExpiresAt <= now) return null;
    if (session.user.status !== 'ACTIVE' || session.user.deletedAt !== null) return null;
    /*
     * AN UNVERIFIED SECOND FACTOR GRANTS NOTHING (Phase 9 §11). Checked against
     * the USER's current enrolment rather than a flag copied onto the session,
     * so switching MFA on takes effect for sessions that already exist instead
     * of at the next sign-in.
     */
    if (session.user.mfaEnabled && !session.mfaVerifiedAt) return null;

    // A workspace selected earlier is only still valid while the membership is,
    // and while the workspace is still operable. Re-derived here rather than
    // trusted from the row, so a removal or a suspension lands at the next
    // request instead of the next sign-in.
    let activeWorkspaceId: string | null = null;
    if (session.activeWorkspaceId) {
      const available = await this.listWorkspaces(token);
      activeWorkspaceId = available.some((w) => w.workspaceId === session.activeWorkspaceId)
        ? session.activeWorkspaceId
        : null;
    }

    await this.#prisma.customerSession.update({
      where: { id: session.id },
      data: { lastSeenAt: now, expiresAt: this.#slidingExpiry(now) },
    });

    return {
      userId: session.userId,
      email: session.user.email,
      name: session.user.name,
      locale: session.user.locale,
      sessionId: session.id,
      activeWorkspaceId,
    };
  }

  /**
   * The workspaces the holder of this token may act in.
   *
   * TAKES THE TOKEN, NOT A USER ID, and reads through the two session-scoped
   * RLS policies added by migration 20260902210000. Both facts matter:
   *
   *   - Under RLS the tenant role sees no `membership` or `workspace` row
   *     without a workspace context, and this question PRECEDES any context.
   *     Relaxing those policies to allow a context-less read would let the
   *     tenant role enumerate every membership in the system, so the widening
   *     is confined to two SELECT-only policies keyed on the session token
   *     hash carried in `app.session_token_hash`.
   *   - Those policies key on the SESSION TOKEN HASH, so the caller must
   *     already hold the session. A user id alone would let anyone who guessed
   *     one enumerate that person's workspaces.
   *
   * An unknown token is an ERROR, not an empty list. Returning `[]` for a token
   * that matches no session is indistinguishable from "a member of nothing",
   * and that ambiguity hid a real defect: a page passed a user id where a
   * session token belongs and rendered "no workspace available" instead of
   * failing. A caller that holds no live session now finds out.
   *
   * Only ACTIVE memberships in OPERABLE workspaces are returned, so a
   * suspended, archived or cancelled workspace simply disappears from the
   * selector — the member keeps the membership and loses the surface.
   */
  async listWorkspaces(token: string): Promise<CustomerWorkspaceContext[]> {
    if (!token) return [];
    const tokenHash = hashSessionToken(token);

    const now = this.#clock.now();
    const live = await this.#prisma.customerSession.count({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
    });
    if (live === 0) throw new AppError('UNAUTHENTICATED', 'Your session is no longer valid.');

    const memberships = await this.#scope(tokenHash, (db) =>
      db.membership.findMany({
        where: {
          status: 'ACTIVE',
          // A suspended, archived, cancelled or deleted workspace is not
          // selectable: the member keeps the membership and loses the surface.
          workspace: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] }, deletedAt: null },
        },
        include: {
          workspace: true,
          role: { include: { permissions: { include: { permission: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );

    return memberships.map((m) => ({
      workspaceId: m.workspaceId,
      workspaceName: m.workspace.name,
      workspaceSlug: m.workspace.slug,
      workspaceStatus: m.workspace.status,
      roleKey: m.role.key,
      roleNameEn: m.role.nameEn,
      roleNameAr: m.role.nameAr,
      // Recomputed from the stored role on every call, so a role change lands
      // at the next request rather than at the next sign-in.
      permissionKeys: m.role.permissions.map((rp) => rp.permission.key),
      brandScope: m.brandScope,
    }));
  }

  /**
   * Select the workspace a session acts in.
   *
   * Membership is re-verified server-side here. A client that posts another
   * workspace's id gets `NOT_FOUND` — the same response as a workspace that
   * does not exist, so the switcher cannot be used to enumerate tenants
   * (docs/SECURITY.md §2.3).
   */
  async switchWorkspace(token: string, workspaceId: string): Promise<CustomerWorkspaceContext> {
    // Resolve FIRST. The session-scoped policies deliberately do not join
    // `user` (that would recurse through the `user` policy), so the account's
    // status is checked here, before any membership is read.
    const customer = await this.resolve(token);
    if (!customer) throw new AppError('UNAUTHENTICATED', 'Your session is no longer valid.');

    const available = await this.listWorkspaces(token);
    const target = available.find((w) => w.workspaceId === workspaceId);
    if (!target) {
      // The same answer as a workspace that does not exist, so the switcher
      // cannot be used to discover other tenants (docs/SECURITY.md §2.3).
      throw new AppError('NOT_FOUND', 'Workspace not found.');
    }

    await this.#prisma.customerSession.updateMany({
      where: { tokenHash: hashSessionToken(token), revokedAt: null },
      data: { activeWorkspaceId: workspaceId, lastSeenAt: this.#clock.now() },
    });
    // `lastActivityAt` is a tenant-owned column, so the CALLER updates it
    // inside its workspace context. Doing it here would need a context this
    // service deliberately does not have.
    return target;
  }

  /** Sign out one session. Idempotent. */
  async signOut(token: string, reason = 'Signed out'): Promise<void> {
    await this.#prisma.customerSession.updateMany({
      where: { tokenHash: hashSessionToken(token), revokedAt: null },
      data: { revokedAt: this.#clock.now(), revokedReason: reason },
    });
  }

  /** Revoke every session for a user — password change, suspension, removal. */
  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    const result = await this.#prisma.customerSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.#clock.now(), revokedReason: reason },
    });
    return result.count;
  }

  /**
   * Revoke every session currently scoped to a workspace.
   *
   * Called when a workspace is suspended or archived. It does NOT revoke
   * sessions of members who happen to belong to that workspace but are working
   * in another one — suspending customer A must not sign anyone out of B.
   */
  async revokeSessionsForWorkspace(workspaceId: string, reason: string): Promise<number> {
    const result = await this.#prisma.customerSession.updateMany({
      where: { activeWorkspaceId: workspaceId, revokedAt: null },
      data: { revokedAt: this.#clock.now(), revokedReason: reason },
    });
    return result.count;
  }

  /**
   * Start a session for a user whose identity was just proven by another means.
   *
   * The ONE caller is invitation onboarding (A-2), where the invitee has, in
   * the same request, demonstrated control of the invited mailbox by presenting
   * a token that exists nowhere but in it, and set the password themselves.
   * Asking them to type that password back on a sign-in form immediately
   * afterwards proves nothing and loses people.
   *
   * NOT A BACK DOOR. It takes a user id, never an email or a password, so
   * nothing a request body carries can reach it; and it refuses any account
   * that is not ACTIVE. Every other entry point to a session still goes
   * through `signIn` and its lockout.
   *
   * The record of how such a session came to exist is the
   * `workspace.invitation.accepted` audit event written in the same
   * transaction that created the identity — not a column here, which would
   * duplicate it and could disagree with it.
   */
  async startSessionForUser(
    userId: string,
    ip?: string,
    userAgent?: string,
  ): Promise<CustomerSessionToken> {
    const user = await this.#prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, deletedAt: true, mfaEnabled: true },
    });
    if (!user || user.deletedAt !== null || user.status !== 'ACTIVE') {
      throw new AppError('UNAUTHENTICATED', GENERIC_FAILURE);
    }
    // MFA APPLIES HERE TOO. This path is reached after an invitation or a
    // completed reset; skipping the second factor on either would make them a
    // way around it.
    return this.#createSession(user.id, ip, userAgent, user.mfaEnabled);
  }

  // --- Password reset ------------------------------------------------------

  /**
   * Begin a password reset.
   *
   * Returns the raw token for the caller to put in an email, or `null` when no
   * reset was created. The CALLER MUST NOT branch visibly on that null: the
   * response to the user is identical either way, or the endpoint becomes an
   * account-existence oracle.
   */
  async beginPasswordReset(email: string, ip?: string): Promise<{ token: string } | null> {
    const address = email.trim().toLowerCase();

    /*
     * COUNTED BEFORE THE LOOKUP, so the ceiling cannot become an oracle: an
     * address that exists and one that does not are refused at exactly the same
     * point, after exactly the same number of requests.
     *
     * THE PER-ACCOUNT CEILING IS THE ONE THAT MATTERS HERE, and it protects
     * somebody who is not the caller. A probe on unmodified main issued
     * twenty-five reset tokens for one address in a loop — twenty-five emails
     * into a stranger's inbox, each of them a working reset link, from one
     * unauthenticated request repeated.
     */
    await this.#limiter.enforce(
      'password-reset:ip',
      ip,
      this.#ceilings.passwordResetPerIp,
      this.#ceilings.windowSeconds,
    );
    await this.#limiter.enforce(
      'password-reset:account',
      address,
      this.#ceilings.passwordResetPerAccount,
      this.#ceilings.windowSeconds,
    );

    const user = await this.#prisma.user.findUnique({
      where: { email: address },
    });
    /*
     * No token is minted for an account a reset could not complete anyway.
     * `completePasswordReset` refuses these states too — this is the cheaper
     * half of the same rule, and it keeps a suspended user from receiving a
     * recovery email that implies the account is still theirs to recover.
     *
     * Returning null, not throwing: the caller's response is identical either
     * way, which is what stops this being an account-existence oracle.
     */
    if (!user || user.deletedAt !== null || !RESETTABLE_STATUSES.has(user.status)) return null;

    const token = mintToken();
    const ttlMinutes = 60;
    await this.#prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashResetToken(token),
        expiresAt: new Date(this.#clock.now().getTime() + ttlMinutes * 60_000),
        ip: ip ?? null,
      },
    });
    return { token };
  }

  /**
   * Complete a password reset.
   *
   * THREE PROPERTIES, each of which was previously missing or only half true.
   *
   * 1. A RESET NEVER REACTIVATES AN ACCOUNT. This used to write
   *    `status: 'ACTIVE'` unconditionally, so a SUSPENDED user — or a DELETED
   *    one holding a token minted before the deletion — could resurrect their
   *    own account with a link from their inbox. Suspension is an
   *    administrative decision and a password is not an appeal against it.
   *    Only PENDING advances, because that is what a reset legitimately
   *    completes: proving control of the address. ACTIVE stays ACTIVE;
   *    SUSPENDED and DELETED are refused outright, with the SAME message as an
   *    unknown token so the endpoint does not become a status oracle.
   *
   * 2. THE WHOLE THING IS ONE TRANSACTION. Consumption, the password write and
   *    session revocation used to be four separate statements. Anything that
   *    failed after the first one — a hash error, a lost connection, a crash —
   *    left the token spent and the password unchanged, which locks the user
   *    out of their own recovery path with no way back but a second reset.
   *    They now commit together or not at all.
   *
   * 3. AN INVALID PASSWORD DOES NOT COST THE TOKEN. The new password is hashed
   *    BEFORE anything is consumed. `hashPassword` throws for a password under
   *    twelve characters, and it used to throw with the token already spent.
   *    The web form checks length too, but the service is the boundary that has
   *    to hold: a caller that forgets is a bug, not a lockout.
   *
   * Consumption itself is still a single conditional UPDATE requiring exactly
   * one affected row, so two concurrent requests cannot both spend one token —
   * the R-03 defect, not repeated here.
   */
  async completePasswordReset(token: string, newPassword: string): Promise<void> {
    const now = this.#clock.now();
    const tokenHash = hashResetToken(token);

    /*
     * Hashed FIRST, outside the transaction. Argon2id is deliberately slow
     * (19 MiB, two passes) and holding a row lock for the duration of it would
     * turn every reset into a lock-contention window. Doing it here also means
     * a rejected password has cost nothing at all.
     */
    const passwordHash = await hashPassword(newPassword);

    await this.#transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) {
        throw new AppError('UNAUTHENTICATED', 'This reset link is no longer valid.');
      }

      const row = await tx.passwordResetToken.findUnique({
        where: { tokenHash },
        select: { userId: true },
      });
      if (!row) throw new AppError('UNAUTHENTICATED', 'This reset link is no longer valid.');

      const user = await tx.user.findUnique({
        where: { id: row.userId },
        select: { id: true, status: true, deletedAt: true },
      });
      /*
       * Refused with the SAME message as an unknown or expired token. A
       * distinct "your account is suspended" here would tell anyone holding a
       * stale link exactly what happened to the account, and the throw rolls
       * the consumption back, so a suspended user's token is not silently
       * burned either.
       */
      if (!user || user.deletedAt !== null || !RESETTABLE_STATUSES.has(user.status)) {
        throw new AppError('UNAUTHENTICATED', 'This reset link is no longer valid.');
      }

      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          failedLoginCount: 0,
          lockedUntil: null,
          // PENDING advances — completing a reset proves control of the
          // address. ACTIVE stays ACTIVE. Nothing else reaches this line.
          ...(user.status === 'PENDING' ? { status: 'ACTIVE' as const } : {}),
          emailVerifiedAt: now,
        },
      });

      // A password change invalidates every existing session
      // (docs/SECURITY.md §3), in the SAME transaction: a revocation that can
      // fail separately is a window in which the old sessions outlive the
      // password that authorised them.
      await tx.customerSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'Password changed' },
      });
    });
  }

  // --- Internals -----------------------------------------------------------

  /**
   * Run work in ONE transaction, when the client we hold supports it.
   *
   * Same detection as `#scope` below and for the same reason: this service is
   * handed a real client by the customer application and, in the Control
   * Center, a platform client that reads these tables through its own policy.
   * A stub without `$transaction` (which is what the unit tests hand it) runs
   * the body directly rather than failing — the atomicity is a property of the
   * database path, and pretending to offer it elsewhere would be worse than
   * being explicit about where it holds.
   */
  async #transaction<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
    const maybe = this.#prisma as unknown as { $transaction?: unknown };
    if (typeof maybe.$transaction !== 'function') return fn(this.#prisma);
    return this.#prisma.$transaction(async (tx) => fn(tx as unknown as PrismaClient));
  }

  /**
   * Run a read under the SESSION scope.
   *
   * Optional by construction: the Control Center hands this service a platform
   * client, which reads these tables through its own policy and needs no scope.
   * The customer application hands it the tenant client, where the scope is
   * what makes the read possible at all. Detecting which we hold keeps one
   * code path instead of two services.
   */
  async #scope<T>(tokenHash: string, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
    const maybe = this.#prisma as unknown as { $transaction?: unknown };
    if (typeof maybe.$transaction !== 'function') return fn(this.#prisma);

    return this.#prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', '', true)`;
      await tx.$executeRaw`SELECT set_config('app.session_token_hash', ${tokenHash}, true)`;
      return fn(tx as unknown as PrismaClient);
    });
  }

  async #createSession(
    userId: string,
    ip?: string,
    userAgent?: string,
    mfaRequired = false,
  ): Promise<CustomerSessionToken> {
    const token = mintToken();
    const now = this.#clock.now();
    const session = await this.#prisma.customerSession.create({
      data: {
        userId,
        tokenHash: hashSessionToken(token),
        expiresAt: this.#slidingExpiry(now),
        absoluteExpiresAt: new Date(now.getTime() + CUSTOMER_REALM.absoluteTtlSeconds * 1000),
        // An account WITHOUT MFA is marked verified on creation, so the column
        // never has to be read together with the enrolment flag to know whether
        // a session is usable.
        mfaVerifiedAt: mfaRequired ? null : now,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      },
    });
    return { token, sessionId: session.id, expiresAt: session.expiresAt, mfaRequired };
  }

  #slidingExpiry(now: Date): Date {
    return new Date(now.getTime() + CUSTOMER_REALM.sessionTtlSeconds * 1000);
  }

  #isLocked(lockedUntil: Date | null): boolean {
    return lockedUntil !== null && lockedUntil > this.#clock.now();
  }

  /**
   * Count one failed attempt, atomically.
   *
   * One UPDATE that computes the new value from the row's own column, so
   * PostgreSQL row locking serialises concurrent attempts and no increment is
   * lost. Read-modify-write here was R-01; it is not repeated.
   */
  async #countFailure(
    userId: string,
    action: string,
    ip?: string,
    userAgent?: string,
  ): Promise<void> {
    const lockUntil = new Date(this.#clock.now().getTime() + CUSTOMER_LOCKOUT_MINUTES * 60_000);
    try {
      const rows = await this.#prisma.$queryRaw<{ lockedUntil: Date | null }[]>`
        UPDATE "user"
           SET "failedLoginCount" =
                 CASE WHEN "failedLoginCount" + 1 >= ${CUSTOMER_MAX_FAILED_ATTEMPTS} THEN 0
                      ELSE "failedLoginCount" + 1 END,
               "lockedUntil" =
                 CASE WHEN "failedLoginCount" + 1 >= ${CUSTOMER_MAX_FAILED_ATTEMPTS} THEN ${lockUntil}
                      ELSE "lockedUntil" END
         WHERE "id" = ${userId}::uuid
         RETURNING "lockedUntil"`;
      const locked = rows[0]?.lockedUntil !== null && rows[0]?.lockedUntil !== undefined;
      await this.#audit(userId, locked ? 'customer.account.locked' : action, ip, locked, {
        userAgent,
      });
    } catch {
      // Rate limiting must never switch itself off quietly. The attempt is
      // refused either way; this records that the counter did not persist.
      await this.#audit(userId, 'customer.security.rate_limit_unavailable', ip, true, {
        // The counter did not persist. That is an ERROR in this system, not a
        // decision to deny somebody — the denial is recorded by the caller.
        outcome: 'ERROR',
        userAgent,
      });
    }
  }

  async #audit(
    userId: string,
    action: string,
    ip?: string,
    critical = false,
    context: AuditContext = {},
  ): Promise<void> {
    try {
      // `createMany`, NOT `create`. Prisma's `create` issues INSERT … RETURNING,
      // and the tenant policy's USING clause deliberately hides platform-scope
      // events (`workspaceId IS NULL`) from every tenant — so the row is
      // written and then invisible, and the RETURNING fails. The event was
      // being dropped silently by the catch below, which is exactly the failure
      // mode an audit trail must not have.
      await this.#prisma.auditEvent.createMany({
        data: [
          {
            // Authentication happens before a workspace exists in the request,
            // so these are platform-scope events with a null workspace.
            workspaceId: null,
            actorType: 'USER',
            actorId: userId,
            action,
            resourceType: 'user',
            resourceId: userId,
            /*
             * THE OUTCOME IS THE TRUTH, NOT A CONSTANT.
             *
             * Every event this service wrote was recorded as DENIED at WARNING,
             * including `customer.mfa.verified` — a SUCCESSFUL second factor.
             * An operator filtering the audit trail for denials to find an
             * attack therefore found every successful MFA challenge mixed in,
             * and an operator asking "did this person get in" was told no.
             * Callers now say which it was, and the severity follows.
             */
            severity: context.severity ?? (critical ? 'CRITICAL' : 'WARNING'),
            outcome: context.outcome ?? 'DENIED',
            ip: ip ?? null,
            /*
             * THE USER AGENT, WHICH THIS NEVER STORED. The column has existed
             * since Phase 1 and nothing on the authentication path ever wrote
             * it, so every customer sign-in failure in the audit trail was a
             * time and an address with no device beside it.
             */
            userAgent: context.userAgent ?? null,
          },
        ],
      });
    } catch {
      // Never let an audit failure change the authentication result. The write
      // above is the one that must not fail silently; this catch is the last
      // resort for a database that is unreachable entirely.
    }
  }
}

/** Constant-time compare, exported for tests that assert the helper is used. */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
