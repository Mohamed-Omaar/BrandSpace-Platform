import { writeAuditEvent, type TenantScopedClient } from '@brandspace/database';
import { AppError } from '@brandspace/shared';

/**
 * G4 / Q23 (prototype v94 Phase 2B-1, D-333) — THE OWNER REQUIRES TWO-STEP
 * VERIFICATION FOR THE WORKSPACE.
 *
 * `workspace.security.manage` (Owner only) is the caller's gate. Two rules
 * here, inside the workspace's RLS transaction:
 *
 *   - the Owner turns it on only with their OWN two-step already on, so the
 *     requirement cannot start by shutting its author out;
 *   - the change is audited with before and after.
 *
 * Members without it are then sent to set it up (the dashboard's gate; the
 * API answers 404), and nobody can turn theirs off while it is required.
 */
export async function setWorkspaceMfaRequirement(
  db: TenantScopedClient,
  context: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly actorHasMfa: boolean;
  },
  required: boolean,
): Promise<void> {
  if (required && !context.actorHasMfa) {
    throw new AppError('CONFLICT', 'Turn on your own two-step verification first.', {
      reason: 'MFA_ENROL_FIRST',
    });
  }
  const before = await db.workspace.findUniqueOrThrow({
    where: { id: context.workspaceId },
    select: { requireMfa: true },
  });
  if (before.requireMfa === required) return;
  await db.workspace.update({
    where: { id: context.workspaceId },
    data: { requireMfa: required },
  });
  await writeAuditEvent(db, context.workspaceId, {
    action: 'workspace.security.mfa_requirement_changed',
    actorType: 'USER',
    actorId: context.actorUserId,
    resourceType: 'workspace',
    resourceId: context.workspaceId,
    severity: 'WARNING',
    // Named for what it is, not `requireMfa`: the redaction layer masks any
    // key that looks like MFA material, and this one is a plain yes/no.
    before: { twoStepRequired: before.requireMfa },
    after: { twoStepRequired: required },
  });
}
