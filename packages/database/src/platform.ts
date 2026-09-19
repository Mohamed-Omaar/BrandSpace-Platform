import type { PrismaClient } from '@prisma/client';
import { AppError } from '@brandspace/shared';
import { assertPlatformRole, getPlatformPrisma } from './platform-pool';
import type { TenantScopedClient } from './tenant-client';

/**
 * asPlatform() — the ONE audited application entrance for cross-tenant work.
 *
 * docs/ARCHITECTURE.md §4.4, docs/SECURITY.md §2.4.
 *
 * HOW THE GUARANTEE IS ENFORCED (F-01, hardened):
 *   Cross-tenant visibility now comes from connecting as `brandspace_platform`,
 *   a separate database identity that RLS policies name explicitly. It is NOT a
 *   session variable any more. The tenant role `brandspace_app` cannot obtain it
 *   by ANY SQL it can execute: no policy names it, it is not a member of the
 *   platform role so SET ROLE fails, and the old `app.is_platform_mode()`
 *   function has been dropped.
 *
 *   Neither role has BYPASSRLS. The platform role's access is a policy that is
 *   evaluated normally, so WITH CHECK still applies and the behaviour remains
 *   visible in pg_policies rather than hidden in a role attribute.
 *
 * FOUR PRECONDITIONS, all enforced here and all fail-closed:
 *   1. a platform actor,
 *   2. with verified MFA (D-27),
 *   3. a written reason,
 *   4. a correlation id, so the operation is traceable to a request.
 *
 * The audit event is written on a SEPARATE connection, so a rolled-back
 * operation still leaves evidence that cross-tenant access was attempted.
 *
 * RESIDUAL RISK, stated rather than assumed away: anyone holding the
 * DATABASE_PLATFORM_URL credential has cross-tenant access. That credential is
 * the security boundary now, which is why it is confined to platform processes,
 * never exported from this package, and lint- and test-enforced. Compromise of
 * the tenant application role no longer grants cross-tenant access.
 */

/**
 * Re-exported from the platform pool, deliberately.
 *
 * `platform-pool.ts` is the module that OPENS the cross-tenant connection, so
 * almost nothing may import it. `assertPlatformRole` is the opposite kind of
 * thing: it opens nothing and hands out nothing. Given a client somebody else
 * already holds, it asks PostgreSQL who that connection actually is and refuses
 * a superuser, a BYPASSRLS role, or anything that is not `brandspace_platform`.
 *
 * It is re-exported here so that a caller which legitimately builds its own
 * platform client — the production Platform Owner bootstrap does, because it
 * runs before any service has started — can verify it with the SAME check the
 * pool applies, rather than with a second copy of the query that would be one
 * refactor away from disagreeing with this one.
 */
export { assertPlatformRole } from './platform-pool';

export interface PlatformActorRef {
  readonly platformUserId: string;
  readonly roleKey: string;
  /** D-27: platform roles require verified 2FA before any privileged action. */
  readonly mfaVerified: boolean;
}

/** Platform roles permitted to perform cross-tenant operations at all. */
const VALID_PLATFORM_ROLE_KEYS = new Set([
  'platform_owner',
  'platform_admin',
  'support_agent',
  'billing_manager',
  'operations_viewer',
]);

export interface PlatformOperation {
  /** Audit action key, e.g. 'platform.workspace.create'. */
  readonly action: string;
  /** Why this cross-tenant access is justified. Required. */
  readonly reason: string;
  /** Correlation id tying the operation to a request. Required. */
  readonly requestId: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
}

export interface AsPlatformOptions {
  /** Test seam. Production always uses the platform pool. */
  readonly prisma?: PrismaClient;
  readonly timeoutMs?: number;
  readonly traceId?: string;
  readonly ip?: string;
  readonly userAgent?: string;
  /** Set when this runs inside a support-mode session (D-28). */
  readonly supportModeSessionId?: string;
  /** Narrows the audit record to the workspace being acted on, when known. */
  readonly targetWorkspaceId?: string;
  /**
   * Skips the audit write. ONLY for bootstrap/seed, where the audit table may
   * not yet be reachable. Never true in application code.
   */
  readonly bootstrap?: boolean;
  /** Repository root, so the seed can load .env before the pool is built. */
  readonly repoRoot?: string;
}

function assertPreconditions(actor: PlatformActorRef, operation: PlatformOperation): void {
  if (!actor || typeof actor.platformUserId !== 'string' || actor.platformUserId.trim() === '') {
    throw new AppError('FORBIDDEN', 'asPlatform() requires a platform actor.');
  }
  if (!VALID_PLATFORM_ROLE_KEYS.has(actor.roleKey)) {
    throw new AppError(
      'FORBIDDEN',
      `asPlatform() requires a valid platform role. "${actor.roleKey}" is not one.`,
    );
  }
  if (!actor.mfaVerified) {
    throw new AppError(
      'FORBIDDEN',
      'asPlatform() requires a platform actor with verified MFA (D-27).',
    );
  }
  if (!operation.reason || operation.reason.trim().length < 8) {
    throw new AppError(
      'FORBIDDEN',
      'asPlatform() requires a written reason of at least 8 characters. ' +
        'Unexplained cross-tenant access is not permitted.',
    );
  }
  if (!operation.requestId || operation.requestId.trim() === '') {
    throw new AppError(
      'FORBIDDEN',
      'asPlatform() requires a correlation/request id so the operation is traceable.',
    );
  }
}

let roleVerified = false;

async function resolvePlatformClient(options: AsPlatformOptions): Promise<PrismaClient> {
  if (options.prisma) return options.prisma;
  const client = getPlatformPrisma(options.repoRoot);
  if (!roleVerified) {
    await assertPlatformRole(client);
    roleVerified = true;
  }
  return client;
}

/** Test seam: forget that the role was verified. */
export function resetPlatformRoleVerification(): void {
  roleVerified = false;
}

/**
 * Execute `fn` with cross-tenant visibility, under audit.
 *
 * Runs on the platform pool. No session variable is set, and nothing the tenant
 * connection can do affects whether this succeeds.
 */
export async function asPlatform<T>(
  actor: PlatformActorRef,
  operation: PlatformOperation,
  fn: (db: TenantScopedClient) => Promise<T>,
  options: AsPlatformOptions = {},
): Promise<T> {
  assertPreconditions(actor, operation);
  const client = await resolvePlatformClient(options);

  let outcome: 'SUCCESS' | 'ERROR' = 'SUCCESS';
  let failureReason: string | undefined;

  try {
    return await client.$transaction(async (tx) => fn(tx as unknown as TenantScopedClient), {
      timeout: options.timeoutMs ?? 30_000,
    });
  } catch (error: unknown) {
    outcome = 'ERROR';
    failureReason = error instanceof Error ? error.name : 'UnknownError';
    throw error;
  } finally {
    // Written on a separate connection and in its own transaction, so a
    // rolled-back operation still leaves evidence.
    if (!options.bootstrap) {
      await writePlatformAudit(client, actor, operation, options, outcome, failureReason);
    }
  }
}

async function writePlatformAudit(
  client: PrismaClient,
  actor: PlatformActorRef,
  operation: PlatformOperation,
  options: AsPlatformOptions,
  outcome: 'SUCCESS' | 'ERROR',
  failureReason: string | undefined,
): Promise<void> {
  try {
    await client.auditEvent.create({
      data: {
        workspaceId: options.targetWorkspaceId ?? null,
        actorType: 'PLATFORM_USER',
        actorId: actor.platformUserId,
        action: operation.action,
        resourceType: operation.resourceType ?? null,
        resourceId: operation.resourceId ?? null,
        severity: outcome === 'ERROR' ? 'WARNING' : 'NOTICE',
        outcome,
        reason: failureReason ? `${operation.reason} [failed: ${failureReason}]` : operation.reason,
        requestId: operation.requestId,
        traceId: options.traceId ?? null,
        ip: options.ip ?? null,
        userAgent: options.userAgent ?? null,
        supportModeSessionId: options.supportModeSessionId ?? null,
      },
    });
  } catch (auditError: unknown) {
    // An audit failure must be loud. Cross-tenant access is never allowed to
    // happen silently without a record. The message deliberately carries no
    // connection string or configuration value.
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'CRITICAL: failed to write asPlatform audit event',
        action: operation.action,
        actorId: actor.platformUserId,
        requestId: operation.requestId,
        error: auditError instanceof Error ? auditError.name : 'UnknownError',
      }),
    );
    throw auditError;
  }
}
