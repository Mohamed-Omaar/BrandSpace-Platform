// The client TYPE comes from @brandspace/database, the only package permitted
// to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import type { PrismaClient } from '@brandspace/database';
import { AppError, type Clock, systemClock } from '@brandspace/shared';
import { denialReason, type PlatformWorkspaceActor } from './workspaces';

/**
 * Support Mode — docs/SECURITY.md §8, docs/ADMIN-CONTROL-CENTER.md §13, D-28.
 *
 * WHAT THIS IS NOT: impersonation. No customer session is ever minted, and no
 * action is ever attributed to the customer. A support session is a grant held
 * by a PLATFORM actor to LOOK at one workspace, for a bounded time, with a
 * written reason, and with every access audited.
 *
 * Four things make that true rather than merely intended:
 *
 *   1. `SupportModeSession` rows are the only artefact. There is no code path
 *      here that touches `customer_session`, so this cannot become a customer
 *      login even by mistake.
 *   2. Every read is scoped to `session.workspaceId`. The workspace is fixed at
 *      grant time and never taken from the request, so a support session cannot
 *      be pointed at a second tenant.
 *   3. Read-only is the default. `writeEnabled` requires a separate, justified
 *      grant, and even then the audit records a PLATFORM actor.
 *   4. Expiry is enforced on every resolve by comparing `expiresAt`, not by a
 *      sweep. An unswept row is already unusable.
 *
 * The record is TENANT-OWNED on purpose: docs/SECURITY.md §8 requires the
 * workspace's own Activity Log to show that support looked, with reason and
 * duration. A platform-owned row would be invisible to the customer, which is
 * the opposite of the guarantee.
 */

export const SUPPORT_MODE_PERMISSION = 'platform.support_mode.enter';

/** Default TTL. The `operations` configuration domain can shorten it. */
export const DEFAULT_SUPPORT_TTL_MINUTES = 60;
export const MAX_SUPPORT_TTL_MINUTES = 480;

const MIN_REASON_LENGTH = 8;

/** Fields Support Mode must never surface, whatever a future query selects. */
export const SUPPORT_MODE_FORBIDDEN_FIELDS = [
  'passwordHash',
  'mfaSecretRef',
  'tokenHash',
  'codeHash',
  'ciphertext',
  'wrappedDataKey',
  'authTag',
  'iv',
  'encryptionContext',
] as const;

export interface SupportModeGrant {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly platformUserId: string;
  readonly platformUserEmail: string;
  readonly reason: string;
  readonly ticketRef: string | null;
  readonly writeEnabled: boolean;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
  readonly remainingSeconds: number;
}

export interface SupportModeServiceOptions {
  readonly prisma: PrismaClient;
  readonly clock?: Clock;
  /** From the `operations` configuration domain. Clamped to the max. */
  readonly ttlMinutes?: number;
}

export class SupportModeService {
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;
  readonly #ttlMinutes: number;

  constructor(options: SupportModeServiceOptions) {
    this.#prisma = options.prisma;
    this.#clock = options.clock ?? systemClock;
    this.#ttlMinutes = Math.min(
      Math.max(options.ttlMinutes ?? DEFAULT_SUPPORT_TTL_MINUTES, 1),
      MAX_SUPPORT_TTL_MINUTES,
    );
  }

  /**
   * Start a support session.
   *
   * Requires: the permission, verified MFA (D-27 — the step-up requirement of
   * docs/SECURITY.md §3), an existing workspace, and a written reason. A
   * write-enabled session additionally requires the elevated grant, which no
   * role holds in Phase 2B, so `writeEnabled` is always false here.
   */
  async start(
    actor: PlatformWorkspaceActor,
    workspaceId: string,
    reason: string,
    ticketRef?: string,
  ): Promise<SupportModeGrant> {
    await this.#authorize(actor, 'support_mode.start', workspaceId);

    if (reason.trim().length < MIN_REASON_LENGTH) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Support access requires a written reason of at least ${MIN_REASON_LENGTH} characters.`,
      );
    }

    const workspace = await this.#prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!workspace) throw new AppError('NOT_FOUND', 'Workspace not found.');

    const now = this.#clock.now();
    const expiresAt = new Date(now.getTime() + this.#ttlMinutes * 60_000);

    /*
     * ONE TRANSACTION, AND A LOCK — A-10.
     *
     * This was three separate statements: end any live session, create the new
     * one, write the audit event. Two failures followed from that.
     *
     * NOT ATOMIC. Anything failing after the INSERT left a LIVE SUPPORT GRANT
     * WITH NO AUDIT EVENT — an operator with access to a customer's workspace
     * and nothing in the customer's Activity Log saying so, which is the exact
     * situation docs/SECURITY.md §8 exists to prevent.
     *
     * NOT SERIALISED. The comment claimed "one active session per (actor,
     * workspace)" and nothing enforced it: two concurrent starts both ran the
     * UPDATE (finding nothing to end), both ran the INSERT, and the workspace
     * ended with two overlapping grants whose accesses cannot be attributed to
     * either.
     *
     * The workspace row is the mutex, taken first, as in `MembershipService`.
     * A partial unique index (migration 20260908100000) is the backstop that
     * holds even if a future caller forgets the lock.
     */
    const session = await this.#prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "workspace" WHERE "id" = ${workspaceId}::uuid FOR UPDATE`;

      // Starting again while one is live ends the old one, so the audit trail
      // never shows two overlapping grants.
      await tx.supportModeSession.updateMany({
        where: { workspaceId, platformUserId: actor.platformUserId, endedAt: null },
        data: { endedAt: now },
      });

      const created = await tx.supportModeSession.create({
        data: {
          workspaceId,
          platformUserId: actor.platformUserId,
          reason: reason.trim(),
          ticketRef: ticketRef?.trim() || null,
          // Read-only. Elevation is a separate grant Phase 2B does not issue.
          writeEnabled: false,
          expiresAt,
        },
      });

      await tx.auditEvent.create({
        data: {
          // Written against the WORKSPACE, so it appears in the customer's own
          // Activity Log — docs/SECURITY.md §8 requires exactly that.
          workspaceId,
          actorType: 'PLATFORM_USER',
          actorId: actor.platformUserId,
          action: 'support_mode.entered',
          resourceType: 'support_mode_session',
          resourceId: created.id,
          severity: 'WARNING',
          outcome: 'SUCCESS',
          reason: reason.trim(),
          supportModeSessionId: created.id,
          after: { expiresAt: expiresAt.toISOString(), writeEnabled: false },
        },
      });

      return created;
    });

    return this.#toGrant(session, workspace.name, actor.platformUserId, now);
  }

  /**
   * Resolve an active session, or null.
   *
   * Null when: unknown, ended, expired, held by a different actor, or the
   * workspace has gone away. The actor check is what stops one platform user
   * from riding another's grant.
   */
  async resolve(sessionId: string, platformUserId: string): Promise<SupportModeGrant | null> {
    const session = await this.#prisma.supportModeSession.findFirst({
      where: { id: sessionId, platformUserId },
      include: { workspace: true, platformUser: { select: { email: true } } },
    });
    if (!session) return null;
    if (session.endedAt !== null) return null;

    const now = this.#clock.now();
    if (session.expiresAt <= now) return null;
    if (session.workspace.deletedAt !== null) return null;

    return {
      id: session.id,
      workspaceId: session.workspaceId,
      workspaceName: session.workspace.name,
      platformUserId: session.platformUserId,
      platformUserEmail: session.platformUser.email,
      reason: session.reason,
      ticketRef: session.ticketRef,
      writeEnabled: session.writeEnabled,
      grantedAt: session.grantedAt,
      expiresAt: session.expiresAt,
      remainingSeconds: Math.max(
        0,
        Math.floor((session.expiresAt.getTime() - now.getTime()) / 1000),
      ),
    };
  }

  /**
   * Record one access made inside a support session.
   *
   * Every request under support mode is audited (docs/SECURITY.md §8). The
   * event carries `supportModeSessionId`, so the customer's Activity Log can
   * group an entire visit.
   */
  async recordAccess(
    sessionId: string,
    platformUserId: string,
    resourceType: string,
    detail?: string,
  ): Promise<void> {
    const grant = await this.resolve(sessionId, platformUserId);
    if (!grant) throw new AppError('FORBIDDEN', 'This support session is no longer active.');

    await this.#prisma.auditEvent.create({
      data: {
        workspaceId: grant.workspaceId,
        actorType: 'PLATFORM_USER',
        actorId: platformUserId,
        action: 'support_mode.accessed',
        resourceType,
        severity: 'NOTICE',
        outcome: 'SUCCESS',
        reason: detail ?? grant.reason,
        supportModeSessionId: sessionId,
      },
    });
  }

  /**
   * Refuse and audit a mutation attempted inside a read-only support session.
   *
   * Always throws in Phase 2B: no role holds the elevated write grant. A denied
   * attempt is a detection signal, so it is recorded rather than dropped.
   */
  async assertMayWrite(sessionId: string, platformUserId: string, action: string): Promise<never> {
    const grant = await this.resolve(sessionId, platformUserId);
    await this.#prisma.auditEvent.create({
      data: {
        workspaceId: grant?.workspaceId ?? null,
        actorType: 'PLATFORM_USER',
        actorId: platformUserId,
        action: 'support_mode.write_denied',
        resourceType: 'support_mode_session',
        resourceId: sessionId,
        severity: 'WARNING',
        outcome: 'DENIED',
        reason: `${action} requires an elevated support grant, which is not issued in Phase 2B.`,
        supportModeSessionId: grant ? sessionId : null,
      },
    });
    throw new AppError('FORBIDDEN', 'Support Mode is read-only.');
  }

  /** End a session early. Only its holder may end it. */
  async end(sessionId: string, platformUserId: string): Promise<void> {
    const now = this.#clock.now();
    const ended = await this.#prisma.supportModeSession.updateMany({
      where: { id: sessionId, platformUserId, endedAt: null },
      data: { endedAt: now },
    });
    if (ended.count !== 1) return; // Already ended, or not this actor's. Idempotent.

    const session = await this.#prisma.supportModeSession.findUnique({
      where: { id: sessionId },
      select: { workspaceId: true, grantedAt: true },
    });
    if (!session) return;

    await this.#prisma.auditEvent.create({
      data: {
        workspaceId: session.workspaceId,
        actorType: 'PLATFORM_USER',
        actorId: platformUserId,
        action: 'support_mode.ended',
        resourceType: 'support_mode_session',
        resourceId: sessionId,
        severity: 'NOTICE',
        outcome: 'SUCCESS',
        supportModeSessionId: sessionId,
        after: {
          durationSeconds: Math.floor((now.getTime() - session.grantedAt.getTime()) / 1000),
        },
      },
    });
  }

  /**
   * End every live session for a platform user.
   *
   * Called when the platform session ends: a support grant must not outlive the
   * authenticated session that created it.
   */
  async endAllForActor(platformUserId: string): Promise<number> {
    const result = await this.#prisma.supportModeSession.updateMany({
      where: { platformUserId, endedAt: null },
      data: { endedAt: this.#clock.now() },
    });
    return result.count;
  }

  /** Live sessions over one workspace — shown to the customer and to Admin. */
  async listForWorkspace(workspaceId: string): Promise<SupportModeGrant[]> {
    const now = this.#clock.now();
    const rows = await this.#prisma.supportModeSession.findMany({
      where: { workspaceId },
      include: { workspace: true, platformUser: { select: { email: true } } },
      orderBy: { grantedAt: 'desc' },
      take: 50,
    });
    return rows.map((s) => ({
      id: s.id,
      workspaceId: s.workspaceId,
      workspaceName: s.workspace.name,
      platformUserId: s.platformUserId,
      platformUserEmail: s.platformUser.email,
      reason: s.reason,
      ticketRef: s.ticketRef,
      writeEnabled: s.writeEnabled,
      grantedAt: s.grantedAt,
      expiresAt: s.expiresAt,
      remainingSeconds:
        s.endedAt !== null
          ? 0
          : Math.max(0, Math.floor((s.expiresAt.getTime() - now.getTime()) / 1000)),
    }));
  }

  async #authorize(
    actor: PlatformWorkspaceActor,
    operation: string,
    workspaceId: string,
  ): Promise<void> {
    const denial = denialReason(actor, operation, SUPPORT_MODE_PERMISSION);
    if (denial === null) return;

    if (actor?.platformUserId) {
      try {
        await this.#prisma.auditEvent.create({
          data: {
            workspaceId: null,
            actorType: 'PLATFORM_USER',
            actorId: actor.platformUserId,
            action: 'support_mode.denied',
            resourceType: 'workspace',
            resourceId: workspaceId,
            severity: 'WARNING',
            outcome: 'DENIED',
            reason: denial,
          },
        });
      } catch {
        // A denial that cannot be recorded is still a denial.
      }
    }
    throw new AppError('FORBIDDEN', denial);
  }

  #toGrant(
    session: {
      id: string;
      workspaceId: string;
      platformUserId: string;
      reason: string;
      ticketRef: string | null;
      writeEnabled: boolean;
      grantedAt: Date;
      expiresAt: Date;
    },
    workspaceName: string,
    platformUserId: string,
    now: Date,
  ): SupportModeGrant {
    return {
      id: session.id,
      workspaceId: session.workspaceId,
      workspaceName,
      platformUserId,
      platformUserEmail: '',
      reason: session.reason,
      ticketRef: session.ticketRef,
      writeEnabled: session.writeEnabled,
      grantedAt: session.grantedAt,
      expiresAt: session.expiresAt,
      remainingSeconds: Math.max(
        0,
        Math.floor((session.expiresAt.getTime() - now.getTime()) / 1000),
      ),
    };
  }
}
