import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_DEFINITIONS, OWNER_ONLY_PERMISSION_KEYS } from '@brandspace/shared';
import { parseConfigPayload } from '@brandspace/config';

/**
 * A8 (D-328) — THE OWNER'S WORKSPACE DELETION: the gates that the isolation
 * suite cannot reach through a browser, pinned where they live.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('A8 · who may delete, and with what confirmation', () => {
  it('workspace.delete stays owner-only', () => {
    expect(OWNER_ONLY_PERMISSION_KEYS).toContain('workspace.delete');
    const admin = ROLE_DEFINITIONS.find((role) => role.key === 'workspace_admin');
    expect(admin?.permissionKeys).not.toContain('workspace.delete');
  });

  it('the request action requires workspace.delete, the typed name and the password, on the server', () => {
    const action = read('apps/dashboard/src/app/[locale]/settings/data/actions.ts');
    expect(action).toContain("requireWorkspaceAction(locale, 'workspace.delete')");
    expect(action).toContain('typed !== session.workspace.workspaceName.trim()');
    expect(action).toContain('getCustomerAuth().confirmPassword(');
    // Both confirmations come BEFORE the service writes anything.
    expect(action.indexOf('confirmPassword(')).toBeLessThan(action.indexOf('.request(db'));
  });

  it('the cancel action has its own gate: the pending workspace, and workspace.delete', () => {
    const action = read('apps/dashboard/src/app/[locale]/deletion-pending/actions.ts');
    expect(action).toContain('await pendingDeletionSession(locale)');
    expect(action).toContain("holdsPermission(session.workspace, 'workspace.delete')");
    expect(action.indexOf("holdsPermission(session.workspace, 'workspace.delete')")).toBeLessThan(
      action.indexOf('.cancel(db'),
    );
  });

  it('the waiting period is configuration, 30 days by default', () => {
    const policy = parseConfigPayload('onboarding', {}) as {
      workspaceDeletion: { graceDays: number };
    };
    expect(policy.workspaceDeletion.graceDays).toBe(30);
  });
});

describe('A8 · while it waits, nobody works in it', () => {
  it('every dashboard page and action lands on the pending screen before any permission is read', () => {
    const context = read('apps/dashboard/src/server/customer-context.ts');
    const redirectAt = context.indexOf(
      'if (workspace.deletionScheduledFor) redirect(`/${locale}/deletion-pending`);',
    );
    expect(redirectAt).toBeGreaterThan(0);
    expect(redirectAt).toBeLessThan(context.indexOf('if (!holdsEvery(workspace, permissionKey))'));
  });

  it('listWorkspaces leaves a pending workspace out unless a caller asks for it', () => {
    const session = read('packages/auth/src/customer-session.ts');
    expect(session).toContain(
      '...(options.includePendingDeletion ? {} : { deletionScheduledFor: null }),',
    );
  });

  it('the publishing sweep materialises and dispatches nothing from a pending workspace', () => {
    const scheduler = read('apps/api/src/scheduler.ts');
    const filters = scheduler.match(/workspace: \{ deletionScheduledFor: null \}/g) ?? [];
    expect(filters.length).toBeGreaterThanOrEqual(2);
  });

  it('the credit ledger refuses a reservation for a pending workspace', () => {
    expect(read('packages/entitlements/src/credit-ledger.ts')).toContain(
      "reason: 'WORKSPACE_PENDING_DELETION'",
    );
  });
});
