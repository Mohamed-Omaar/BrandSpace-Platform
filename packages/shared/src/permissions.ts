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

  /*
   * Phase 5. Brand Brain, split along the lines where the ANSWERS differ.
   *
   * `brand_brain.read` and `brand_brain.edit` are the ordinary pair. The other
   * three exist because they are genuinely different authorities:
   *
   *   - `upload` is not `edit`. Uploading consumes storage and produces work
   *     for a reviewer; a copywriter who may correct a typo is not
   *     automatically someone who may add documents to the corpus.
   *   - `review` is not `edit` either. Approving a candidate is what turns
   *     machine output into brand truth, and D-65 makes that a human decision
   *     with a named owner. Collapsing it into `edit` would mean anyone who can
   *     fix a sentence can also approve everything a document proposed.
   *   - `delete` is separate because archiving knowledge is destructive to the
   *     grounding every future generation depends on.
   *
   * No new ROLE is introduced. These attach to the roles that already exist.
   */
  def('brand.read', 'workspace', 'View brands'),
  def('brand.manage', 'workspace', 'Create and edit brands'),
  def('brand_brain.read', 'workspace', 'View Brand Brain knowledge and sources'),
  def('brand_brain.edit', 'workspace', 'Add and edit brand knowledge'),
  def('brand_brain.upload', 'workspace', 'Upload source documents'),
  def('brand_brain.review', 'workspace', 'Approve or reject extracted knowledge'),
  def('brand_brain.delete', 'workspace', 'Archive brand knowledge and remove sources'),
  def('brand_brain.chat', 'workspace', 'Ask Brand Brain questions'),

  /*
   * Phase 5B-1. The Asset Library, split where the AUTHORITIES genuinely
   * differ rather than where the screens do.
   *
   * docs/SECURITY.md §4.3 has one row — "Upload / manage assets" — and one row
   * is too coarse to express what that table itself already says: the Designer
   * holds it outright, the Copywriter holds it only for their OWN work, and
   * Approver, Analyst and Viewer do not hold it at all. A single
   * `assets.manage` key cannot say that, and collapsing eight capabilities
   * into it would mean anyone who may tag a photo may also delete the brand
   * library.
   *
   * Each key below is a different question:
   *
   *   - `read` is seeing the library at all.
   *   - `use` is SELECTING an approved asset for a post or a design. It is
   *     separate from `read` because it is the capability other modules will
   *     ask for, and because a role that may browse for reference is not
   *     automatically one that may put a file in front of the public. It
   *     grants no write of any kind.
   *   - `upload` consumes plan storage and creates work for a scanner. It is
   *     not `edit`: someone who may fix a mistyped caption is not
   *     automatically someone who may add files to the corpus.
   *   - `edit` is metadata — name, tags, folder, licence, rights expiry. It
   *     never touches bytes.
   *   - `manage_taxonomy` is folders and tags ACROSS the library. Renaming a
   *     folder changes what every member sees, which is a different blast
   *     radius from editing one asset.
   *   - `version` replaces the BYTES behind an asset that other content may
   *     already reference. That is the most consequential write short of
   *     deletion, and it is why it is not `edit`.
   *   - `archive` is reversible removal; `restore` brings it back; `delete` is
   *     the irreversible one. They are three keys because they are three
   *     different amounts of trust, and because a role that may tidy up is not
   *     automatically one that may destroy.
   *
   * No new ROLE is introduced. These attach to the roles that already exist,
   * and the read-only roles stay read-only — `analyst` and `client_viewer`
   * receive `assets.read` and nothing else, not even `assets.use`.
   */
  def('assets.read', 'workspace', 'View the Asset Library'),
  def('assets.use', 'workspace', 'Select an approved asset for use'),
  def('assets.upload', 'workspace', 'Upload files to the Asset Library'),
  def('assets.edit', 'workspace', 'Edit asset metadata, tags and placement'),
  def('assets.manage_taxonomy', 'workspace', 'Create and rename folders and tags'),
  def('assets.version', 'workspace', 'Replace the file behind an asset with a new version'),
  def('assets.archive', 'workspace', 'Archive an asset'),
  def('assets.restore', 'workspace', 'Restore an archived asset'),
  def('assets.delete', 'workspace', 'Delete an asset permanently'),

  /*
   * Phase 5B-2 — AI Content Studio (docs/PRODUCT.md §5 module 7).
   *
   * SEPARATED THE SAME WAY THE LIBRARY IS, and for the same reason: a key that
   * meant "content" would collapse four different amounts of trust into one.
   *
   *   - `read` is the library of drafts. A reviewer needs it and nothing else.
   *   - `create` SPENDS AI CREDITS. That is the distinction that matters most
   *     here and it has no parallel in the Asset Library: every other write on
   *     this list is free, and this one moves money. A role that may edit a
   *     caption is not thereby a role that may run up a bill.
   *   - `edit` is changing words that already exist — free, and a different
   *     act from generating new ones.
   *   - `submit` moves a draft into review. It is the point at which one
   *     person's work becomes another person's queue.
   *   - `archive` is reversible removal; `delete` is not, and stays with the
   *     admins exactly as `assets.delete` and `brand_brain.delete` do.
   */
  def('content.read', 'workspace', 'View content drafts and variants'),
  def('content.create', 'workspace', 'Generate content with AI (spends credits)'),
  def('content.edit', 'workspace', 'Edit content drafts and captions'),
  def('content.submit', 'workspace', 'Submit content for review'),
  def('content.archive', 'workspace', 'Archive a content draft'),
  def('content.schedule', 'workspace', 'Place content on the calendar and move it'),
  def('content.delete', 'workspace', 'Delete content permanently'),

  /*
   * Phase 5B-3 — Approvals, Activity Log, Notifications.
   *
   * `content.approve` IS NOT `content.edit`. docs/SECURITY.md §4.3 gives the
   * Approver role review authority and no authoring authority at all, and the
   * separation is the whole reason an approval record means anything: an
   * approver who rewrites the thing they are approving has not approved it.
   *
   * THE ACTIVITY LOG GRADES `audit.read`, IT DOES NOT REPLACE IT. That key has
   * existed since Phase 1 and already carries the §4.3 rows marked ✅ or
   * 🟡 brand-scoped; adding a parallel `activity.*` family would have been a
   * second permission for the same capability, which is how two answers to one
   * question get shipped. So `audit.read` keeps its meaning — "you may see more
   * of the log than your own actions" — and two REFINEMENTS sit beside it:
   *
   *   `audit.read_workspace`  the whole workspace (Owner, Admin)
   *   `audit.read`            brands in your scope (Marketing Manager, Analyst)
   *   `audit.read_own`        your own actions (Creator, Copywriter, Designer,
   *                           Approver)
   *   none                    Viewer (read-only)
   *
   * The scope is resolved from PERMISSIONS, never from the role key. A role in
   * this platform IS its permission set; a capability that secretly consulted
   * the role name could not be reasoned about, could not be overridden, and
   * would mis-grade any role added later. Most privileged wins.
   */
  def('content.approve', 'workspace', 'Approve, reject or request changes on content'),
  def('approvals.policy.manage', 'workspace', "Change a brand's approval policy"),
  def('audit.read_own', 'workspace', 'View your own actions in the activity log'),
  def('audit.read_workspace', 'workspace', 'View all workspace activity'),
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
  // Phase 4. AI operations data is its own authority. It is not customer
  // content — the explorer deliberately never surfaces a prompt or a generated
  // result — but it is a per-workspace financial record, so it does not ride on
  // "View any workspace" the way the configuration screens once did (R-02).
  def('platform.ai.usage.read', 'platform', 'View AI request history, usage and cost'),

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
