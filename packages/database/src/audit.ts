import type { Prisma } from '@prisma/client';
import { redact } from '@brandspace/shared';
import type { TenantScopedClient } from './tenant-client';

/**
 * Audit writer — CLAUDE.md §5: "Every mutation that changes tenant or platform
 * state writes an AuditEvent."
 *
 * `before`/`after` pass through the redaction layer before they are written, so a
 * secret can never reach the audit table even if a caller passes a whole record.
 */

export interface AuditInput {
  readonly action: string;
  readonly actorType: 'USER' | 'PLATFORM_USER' | 'SYSTEM' | 'AUTOMATION' | 'COPILOT';
  readonly actorId?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly brandId?: string | undefined;
  readonly severity?: 'INFO' | 'NOTICE' | 'WARNING' | 'CRITICAL';
  readonly outcome?: 'SUCCESS' | 'DENIED' | 'ERROR';
  readonly reason?: string | undefined;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly requestId?: string | undefined;
  readonly traceId?: string | undefined;
  readonly supportModeSessionId?: string | undefined;
}

/**
 * Write an audit event inside an existing tenant-scoped transaction, so the event
 * and the change it describes commit or roll back together.
 */
export async function writeAuditEvent(
  db: TenantScopedClient,
  workspaceId: string,
  input: AuditInput,
): Promise<void> {
  // `before`/`after` are Json columns: Prisma distinguishes "absent" from
  // "explicit null", and under exactOptionalPropertyTypes an explicit `undefined`
  // is not assignable. Build the optional half separately rather than widening
  // the compiler settings.
  const redactedDiff: { before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue } = {};
  if (input.before !== undefined) {
    redactedDiff.before = redact(input.before) as Prisma.InputJsonValue;
  }
  if (input.after !== undefined) {
    redactedDiff.after = redact(input.after) as Prisma.InputJsonValue;
  }

  await db.auditEvent.create({
    data: {
      workspaceId,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      brandId: input.brandId ?? null,
      severity: input.severity ?? 'INFO',
      outcome: input.outcome ?? 'SUCCESS',
      reason: input.reason ?? null,
      ...redactedDiff,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      supportModeSessionId: input.supportModeSessionId ?? null,
    },
  });
}

/**
 * Denied authorization attempts are audited too — repeated denials are a
 * detection signal (docs/SECURITY.md §7).
 */
export async function writeDeniedAudit(
  db: TenantScopedClient,
  workspaceId: string,
  input: Omit<AuditInput, 'outcome'>,
): Promise<void> {
  await writeAuditEvent(db, workspaceId, { ...input, outcome: 'DENIED', severity: 'WARNING' });
}
