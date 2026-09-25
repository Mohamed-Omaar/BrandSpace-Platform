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
  // E3 — archiving a fact is an edit of the brand's knowledge, so it moved here
  // from `brand_brain.delete`, which keeps removing sources.
  def('brand_brain.edit', 'workspace', 'Add, edit and archive brand knowledge'),
  def('brand_brain.upload', 'workspace', 'Upload source documents'),
  def('brand_brain.review', 'workspace', 'Approve or reject extracted knowledge'),
  def('brand_brain.delete', 'workspace', 'Remove brand sources'),
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
   *   - `create` is BRINGING A NEW DRAFT INTO THE LIBRARY, by whichever route.
   *     It was written as "generate with AI, spends credits", because when this
   *     list was drawn generation was the only way a `content_item` could come
   *     into being. Phase 2 added manual authoring — a person writing their own
   *     caption, no model, no reservation, no ledger entry — and it is a create
   *     in every sense that matters here: a new row in the brand's library,
   *     against the draft ceiling, attributed to its author. It takes this same
   *     key, so the description had to stop claiming that every use of it moves
   *     money (D-231).
   *
   *     SPENDING IS A PROPERTY OF THE GENERATION PATH, NOT OF THIS KEY. What
   *     reserves and settles credits is the AI Gateway, and what decides whether
   *     a caller may reach it is the entitlement and the wallet, both checked
   *     there. Splitting a second permission out to carry the money would put
   *     the guard somewhere the money is not, and would silently drop manual
   *     authoring for every role that has this key today.
   *   - `edit` is changing words that already exist — a different act from
   *     bringing new ones into the library, whoever or whatever wrote them.
   *   - `submit` moves a draft into review. It is the point at which one
   *     person's work becomes another person's queue.
   *   - `archive` is reversible removal; `delete` is not, and stays with the
   *     admins exactly as `assets.delete` and `brand_brain.delete` do.
   */
  def('content.read', 'workspace', 'View content drafts and variants'),
  def('content.create', 'workspace', 'Create a content draft, by hand or with AI'),
  def('content.edit', 'workspace', 'Edit content drafts and captions'),
  def('content.submit', 'workspace', 'Submit content for review'),
  def('content.archive', 'workspace', 'Archive a content draft'),
  def('content.schedule', 'workspace', 'Place content on the calendar and move it'),
  def('content.delete', 'workspace', 'Delete content permanently'),
  /*
   * Q12 — running a conversation, not just taking part in it. Starting a note
   * thread and replying to an open one need `content.read` (the Notes
   * permission); resolving, reopening, assigning, setting a due date or
   * importance, and replying to a resolved thread need this as well. Granted
   * to every role that held `content.read` when it was introduced, so no one
   * lost anything (migration `…_notes_manage_permission`).
   */
  def('notes.manage', 'workspace', 'Resolve, assign and triage note threads'),

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

  /*
   * Phase 6 — Social Publishing (docs/PRODUCT.md §5 modules 8 and 9).
   *
   * FOUR KEYS, AND THE SPLIT IS THE POINT — the same reasoning the Asset
   * Library and the Content Studio were separated by.
   *
   *   - `integrations.read` is seeing WHICH accounts are connected and whether
   *     they are healthy. A reviewer and an analyst both need it; neither
   *     should be able to change anything.
   *   - `integrations.manage` is CONNECTING AND DISCONNECTING. It is the most
   *     consequential key in this phase and arguably in the product: at the end
   *     of it, BrandSpace can post to the world as this customer. It belongs
   *     with the roles that already carry `workspace.manage`-grade trust, and
   *     it is NOT bundled into publishing — a person who may schedule a post is
   *     not thereby a person who may authorize a new account.
   *   - `publishing.read` is the publishing history: what went out, what
   *     failed, and why.
   *   - `publishing.manage` is cancelling a queued post and retrying a failed
   *     one. Both change what reaches the public, so neither rides on
   *     `content.schedule`.
   *
   * NO NEW ROLE. These attach to the roles that already exist, and the
   * read-only roles stay read-only: `analyst` and `client_viewer` get nothing
   * that can cause an external effect, and `client_viewer` gets nothing at all
   * (D-130).
   */
  def('integrations.read', 'workspace', 'View connected social accounts'),
  def('integrations.manage', 'workspace', 'Connect and disconnect social accounts'),
  def('publishing.read', 'workspace', 'View publishing history and status'),
  def('publishing.manage', 'workspace', 'Cancel a queued post or retry a failed one'),

  /*
   * Phase 7 — Analytics, Strategy, the Copilot and Automations.
   *
   * SPLIT WHERE THE AUTHORITIES GENUINELY DIFFER, which in this phase is
   * unusually easy to see: three of these SPEND MONEY and the rest do not, and
   * two of them can CHANGE THE WORLD through an assistant that a person talks
   * to in sentences.
   *
   *   - `analytics.read` is seeing the numbers. An Analyst needs it and a
   *     read-only Viewer does not get it, because performance data is
   *     commercially sensitive and D-130 keeps the Viewer at exactly
   *     `workspace.read`.
   *   - `analytics.export` is TAKING THE NUMBERS OUT of the platform. It is not
   *     `read`: a file leaves the product, is forwarded, and outlives every
   *     permission change afterwards. A role that may look at a chart is not
   *     automatically one that may hand the quarter's performance to somebody
   *     outside the workspace.
   *   - `analytics.explain` SPENDS AI CREDITS. That is the same distinction
   *     `content.create` carries and the one that matters most here: every other
   *     read on this list is free, and this one moves money.
   *   - `strategy.read` is seeing proposals. `strategy.manage` is generating one
   *     (credits again) and, more consequentially, ACCEPTING it — the act that
   *     turns a machine proposal into something the rest of the product will
   *     build campaigns from. It belongs with the role that runs the brand.
   *   - `copilot.use` is the whole assistant. It is ONE key rather than one per
   *     tool, because the Copilot never exceeds the permissions its user already
   *     holds: every tool call re-resolves the caller's own permissions at
   *     execution time, so `copilot.use` grants access to the assistant and
   *     nothing beyond what the person could already do by hand. A per-tool
   *     permission family would be a second, drifting copy of the first.
   *   - `automation.read` is seeing the rules and their run history.
   *     `automation.manage` is creating and enabling them, which is the authority
   *     to make things happen when nobody is watching — so it sits with the
   *     admins and the Marketing Manager, and with nobody else.
   *
   * NO NEW ROLE. These attach to the roles that already exist, and the read-only
   * roles stay read-only: `analyst` gets the reads and the export and nothing
   * that can cause an effect, and `client_viewer` gets NOTHING (D-62, D-130).
   */
  def('analytics.read', 'workspace', 'View performance analytics'),
  def('analytics.export', 'workspace', 'Export analytics data out of BrandSpace'),
  def(
    'analytics.explain',
    'workspace',
    'Generate an AI explanation of performance (spends credits)',
  ),
  def('strategy.read', 'workspace', 'View proposed strategies, plans and insights'),
  def('strategy.manage', 'workspace', 'Generate and accept strategies and plans (spends credits)'),
  def('campaigns.read', 'workspace', 'View campaigns'),
  def('campaigns.manage', 'workspace', 'Create and edit campaigns'),
  def('copilot.use', 'workspace', 'Use the AI Copilot (spends credits)'),
  def('automation.read', 'workspace', 'View automation rules and their run history'),
  def('automation.manage', 'workspace', 'Create, edit and enable automation rules'),
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
