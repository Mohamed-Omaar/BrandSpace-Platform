import type { PrismaClient } from '@prisma/client';
import { AppError } from '@brandspace/shared';
import { getPrisma } from './client';
import type { TenantScopedClient } from './tenant-client';

/**
 * asPlatform() — the ONE audited cross-tenant escape hatch.
 *
 * docs/ARCHITECTURE.md §4.4 / docs/SECURITY.md §2.4:
 *   "Cross-tenant reads are only possible through asPlatform(), which is audited."
 *
 * Three properties, all enforced here:
 *   1. It requires a platform actor. A customer actor cannot reach it.
 *   2. It requires a written reason. Unexplained cross-tenant access is refused.
 *   3. It ALWAYS writes an AuditEvent — including when the callback throws.
 *
 * SCOPE OF THE GUARANTEE, stated honestly: this is a control against developer
 * error and it produces the audit trail. It is not a defence against an attacker
 * who already has arbitrary SQL execution as the application role, since that
 * attacker could set the GUC directly. Hardening that case means a separate
 * database role and connection pool for platform operations; it is recorded as
 * follow-up work in docs/DECISIONS.md rather than silently assumed.
 */

export interface PlatformActorRef {
  readonly platformUserId: string;
  readonly roleKey: string;
  /** D-27: platform roles require verified 2FA before any privileged action. */
  readonly mfaVerified: boolean;
}

export interface AsPlatformOptions {
  readonly prisma?: PrismaClient;
  readonly timeoutMs?: number;
  /** Correlation for the audit record. */
  readonly requestId?: string;
  readonly traceId?: string;
  readonly ip?: string;
  readonly userAgent?: string;
  /** Set when this runs inside a support-mode session (D-28). */
  readonly supportModeSessionId?: string;
  /** Narrows the audit record to the workspace being acted on, when known. */
  readonly targetWorkspaceId?: string;
  /**
   * Skips the audit write. ONLY for bootstrap/seed, where the audit table may not
   * yet be reachable. Never true in application code.
   */
  readonly bootstrap?: boolean;
}

export interface PlatformOperation {
  /** Audit action key, e.g. 'platform.workspace.create'. */
  readonly action: string;
  /** Why this cross-tenant access is justified. Required. */
  readonly reason: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
}

function assertActorIsValid(actor: PlatformActorRef, operation: PlatformOperation): void {
  if (!actor || typeof actor.platformUserId !== 'string' || actor.platformUserId.length === 0) {
    throw new AppError('FORBIDDEN', 'asPlatform() requires a platform actor.');
  }
  if (!actor.mfaVerified) {
    // D-27: mandatory 2FA for platform roles.
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
}

/**
 * Execute `fn` with cross-tenant visibility, under audit.
 *
 * The platform flag is transaction-local, so visibility is confined to this
 * transaction and released when it ends.
 */
export async function asPlatform<T>(
  actor: PlatformActorRef,
  operation: PlatformOperation,
  fn: (db: TenantScopedClient) => Promise<T>,
  options: AsPlatformOptions = {},
): Promise<T> {
  assertActorIsValid(actor, operation);
  const prisma = options.prisma ?? getPrisma();

  let outcome: 'SUCCESS' | 'ERROR' = 'SUCCESS';
  let failureReason: string | undefined;

  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.platform_mode', 'on', true)`;
        try {
          return await fn(tx as unknown as TenantScopedClient);
        } finally {
          // Close the window even on the failure path, so nothing later in this
          // transaction runs with cross-tenant visibility.
          await tx.$executeRaw`SELECT set_config('app.platform_mode', 'off', true)`;
        }
      },
      { timeout: options.timeoutMs ?? 30_000 },
    );
  } catch (error: unknown) {
    outcome = 'ERROR';
    failureReason = error instanceof Error ? error.name : 'UnknownError';
    throw error;
  } finally {
    // The audit record is written in a SEPARATE transaction, so a rolled-back
    // operation still leaves evidence that cross-tenant access was attempted.
    if (!options.bootstrap) {
      await writePlatformAudit(prisma, actor, operation, options, outcome, failureReason);
    }
  }
}

async function writePlatformAudit(
  prisma: PrismaClient,
  actor: PlatformActorRef,
  operation: PlatformOperation,
  options: AsPlatformOptions,
  outcome: 'SUCCESS' | 'ERROR',
  failureReason: string | undefined,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_mode', 'on', true)`;
      await tx.auditEvent.create({
        data: {
          workspaceId: options.targetWorkspaceId ?? null,
          actorType: 'PLATFORM_USER',
          actorId: actor.platformUserId,
          action: operation.action,
          resourceType: operation.resourceType ?? null,
          resourceId: operation.resourceId ?? null,
          severity: outcome === 'ERROR' ? 'WARNING' : 'NOTICE',
          outcome,
          reason: failureReason
            ? `${operation.reason} [failed: ${failureReason}]`
            : operation.reason,
          requestId: options.requestId ?? null,
          traceId: options.traceId ?? null,
          ip: options.ip ?? null,
          userAgent: options.userAgent ?? null,
          supportModeSessionId: options.supportModeSessionId ?? null,
        },
      });
      await tx.$executeRaw`SELECT set_config('app.platform_mode', 'off', true)`;
    });
  } catch (auditError: unknown) {
    // An audit failure must be loud. It never silently swallows the fact that
    // cross-tenant access happened without a record.
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'CRITICAL: failed to write asPlatform audit event',
        action: operation.action,
        actorId: actor.platformUserId,
        error: auditError instanceof Error ? auditError.message : String(auditError),
      }),
    );
    throw auditError;
  }
}
