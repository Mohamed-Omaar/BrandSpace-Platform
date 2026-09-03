/**
 * Permission registry — docs/SECURITY.md §4.
 *
 * Permissions are `resource.action`. Scope is the narrowest level at which the
 * permission can be granted. Roles are composed from these keys; code asks for a
 * permission, never for a role name.
 */

export const PERMISSION_SCOPES = ['platform', 'workspace', 'brand', 'campaign'] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

export interface PermissionDefinition {
  readonly key: string;
  readonly resource: string;
  readonly action: string;
  readonly minScope: PermissionScope;
  readonly description: string;
}

function def(key: string, minScope: PermissionScope, description: string): PermissionDefinition {
  const [resource, action] = key.split('.');
  if (!resource || !action) throw new Error(`Malformed permission key: ${key}`);
  return { key, resource, action, minScope, description };
}

/** Workspace-realm permissions. Phase 1 covers identity and tenancy only. */
export const WORKSPACE_PERMISSIONS: readonly PermissionDefinition[] = [
  def('workspace.read', 'workspace', 'View the workspace'),
  def('workspace.update', 'workspace', 'Change workspace settings'),
  def('workspace.delete', 'workspace', 'Delete the workspace'),
  def('workspace.transfer_ownership', 'workspace', 'Transfer workspace ownership'),
  def('member.read', 'workspace', 'List workspace members'),
  def('member.invite', 'workspace', 'Invite a member'),
  def('member.remove', 'workspace', 'Remove a member'),
  def('member.assign_role', 'workspace', 'Change a member role'),
  def('audit.read', 'workspace', 'View the workspace activity log'),

  // Phase 2B. Split read from manage: docs/SECURITY.md §4.3 gives Workspace
  // Admin "view only" on billing, and only the Owner may change the plan.
  def('billing.read', 'workspace', 'View the plan, effective features and limits'),
  def('billing.manage', 'workspace', 'Change the plan or payment method'),
  def('credits.read', 'workspace', 'View the workspace AI credit balance'),
] as const;

/** Platform-realm permissions. Disjoint from the workspace set by construction. */
export const PLATFORM_PERMISSIONS: readonly PermissionDefinition[] = [
  def('platform.workspace.read', 'platform', 'View any workspace'),
  def('platform.workspace.create', 'platform', 'Create a customer workspace'),
  def('platform.workspace.suspend', 'platform', 'Suspend or reactivate a workspace'),
  def('platform.user.read', 'platform', 'View platform users'),
  def('platform.user.manage', 'platform', 'Manage platform users and roles'),
  def('platform.audit.read', 'platform', 'View the platform audit log'),
  def('platform.support_mode.enter', 'platform', 'Enter time-boxed support mode'),

  // Phase 2B. Each authority in docs/SECURITY.md §4.4 that a role holds
  // outright gets its own key, so no capability rides on another's back — the
  // mistake R-02 was. Assigning a plan, granting a feature override and moving
  // credits are three different powers held by three different sets of roles.
  def('platform.workspace.update', 'platform', 'Edit customer workspace details'),
  def('platform.workspace.invite', 'platform', 'Invite a member into a customer workspace'),
  def('platform.plan.assign', 'platform', 'Assign or change a workspace plan'),
  def('platform.entitlement.override', 'platform', 'Grant or revoke a customer feature override'),
  def('platform.credit.adjust', 'platform', 'Add or remove AI credits'),

  // Configuration and secrets are split into read / manage / activate on
  // purpose. They were previously all gated on `platform.workspace.read`
  // ("View any workspace"), which every admin-capable role holds — so a support
  // agent could rotate a production API key. Viewing a customer's workspace and
  // repricing the platform are not the same authority.
  def('platform.configuration.read', 'platform', 'View platform configuration and its history'),
  def('platform.configuration.manage', 'platform', 'Draft and edit platform configuration'),
  def(
    'platform.configuration.activate',
    'platform',
    'Activate or roll back platform configuration (high impact)',
  ),
  def('platform.secret.read', 'platform', 'View secret metadata — never a value'),
  def('platform.secret.manage', 'platform', 'Create, rotate, disable or revoke secrets'),
] as const;

export const ALL_PERMISSIONS: readonly PermissionDefinition[] = [
  ...WORKSPACE_PERMISSIONS,
  ...PLATFORM_PERMISSIONS,
];

/** The two session realms never share a permission key. */
export function assertRealmsAreDisjoint(): void {
  const workspaceKeys = new Set(WORKSPACE_PERMISSIONS.map((p) => p.key));
  const overlap = PLATFORM_PERMISSIONS.filter((p) => workspaceKeys.has(p.key));
  if (overlap.length > 0) {
    throw new Error(`Permission realms overlap: ${overlap.map((p) => p.key).join(', ')}`);
  }
}
