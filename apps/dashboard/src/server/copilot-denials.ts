import 'server-only';
import { denialText } from './denial';
import { memberDisplayName, workspaceOwnerName, type WorkspaceSession } from './customer-context';

/**
 * PR B (D-591) — THE PERMISSIONS THE COPILOT'S WORKSPACE READS ASK, the same
 * ones their screens ask (team → `member.read`, credits → `credits.read`,
 * plan → `billing.read`, channels → `integrations.read`, notifications →
 * `workspace.read`). `tests/unit/pr-b-workspace-reads.test.ts` holds this list
 * equal to the tool registry's, so the two cannot drift.
 */
export const COPILOT_READ_PERMISSIONS: readonly string[] = [
  'member.read',
  'credits.read',
  'billing.read',
  'integrations.read',
  'workspace.read',
];

/**
 * What the Copilot says when this member asks for a read they may not open:
 * the SAME words the screen's own refusal uses (E6 `denialText`), one per
 * permission they lack. Empty when they hold them all.
 */
export async function copilotDenials(
  locale: string,
  session: Pick<WorkspaceSession, 'workspace' | 'customer'>,
): Promise<Readonly<Record<string, string>>> {
  const missing = COPILOT_READ_PERMISSIONS.filter(
    (key) => !session.workspace.permissionKeys.includes(key),
  );
  if (missing.length === 0) return {};
  const ownerName = await workspaceOwnerName(session.workspace.workspaceId).catch(() => '');
  const memberName = memberDisplayName(session.customer);
  return Object.fromEntries(
    missing.map((permissionKey) => [
      permissionKey,
      denialText(locale, { permissionKey, memberName, ownerName }).body,
    ]),
  );
}
