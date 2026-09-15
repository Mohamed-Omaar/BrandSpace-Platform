import {
  PLATFORM_PERMISSIONS,
  WORKSPACE_PERMISSIONS,
  type PermissionDefinition,
} from './permissions';

/** Customer roles — docs/SECURITY.md §4.3. */
export const CUSTOMER_ROLE_KEYS = [
  'workspace_owner',
  'workspace_admin',
  'marketing_manager',
  'content_creator',
  'copywriter',
  'designer',
  'approver',
  'analyst',
  'client_viewer',
] as const;
export type CustomerRoleKey = (typeof CUSTOMER_ROLE_KEYS)[number];

/** Platform roles — docs/SECURITY.md §4.4. */
export const PLATFORM_ROLE_KEYS = [
  'platform_owner',
  'platform_admin',
  'support_agent',
  'billing_manager',
  'operations_viewer',
] as const;
export type PlatformRoleKey = (typeof PLATFORM_ROLE_KEYS)[number];

export interface RoleDefinition {
  readonly key: CustomerRoleKey | PlatformRoleKey;
  readonly realm: 'workspace' | 'platform';
  readonly nameEn: string;
  readonly nameAr: string;
  readonly permissionKeys: readonly string[];
}

const allWorkspacePermissionKeys = WORKSPACE_PERMISSIONS.map((p) => p.key);
const allPlatformPermissionKeys = PLATFORM_PERMISSIONS.map((p) => p.key);

/**
 * Phase 1 grants only the identity/tenancy permissions that exist so far.
 * Content, publishing, billing and AI permissions arrive with their phases.
 */
export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    key: 'workspace_owner',
    realm: 'workspace',
    nameEn: 'Workspace Owner',
    nameAr: 'مالك مساحة العمل',
    permissionKeys: allWorkspacePermissionKeys,
  },
  {
    key: 'workspace_admin',
    realm: 'workspace',
    nameEn: 'Workspace Admin',
    nameAr: 'مدير مساحة العمل',
    // Everything EXCEPT the four authorities docs/SECURITY.md §4.3 reserves
    // for the Owner: ownership transfer, deletion, and changing the plan or
    // payment method (the Admin is "view only" on billing).
    //
    // Stated as an explicit deny list rather than "everything minus two",
    // because that phrasing silently granted `billing.manage` the moment the
    // permission was added — caught by tests/unit/phase2b-boundaries.test.ts
    // before it shipped. A blanket grant inherits every future permission.
    permissionKeys: allWorkspacePermissionKeys.filter(
      (k) =>
        k !== 'workspace.transfer_ownership' && k !== 'workspace.delete' && k !== 'billing.manage',
    ),
  },
  {
    key: 'marketing_manager',
    realm: 'workspace',
    nameEn: 'Marketing Manager',
    nameAr: 'مدير التسويق',
    // docs/SECURITY.md §4.3 marks "invite / remove members" as conditional for
    // this role (non-admin roles only). A conditional grant needs the condition
    // to be enforced, not assumed, so it is NOT granted in Phase 2B — see F-15.
    permissionKeys: [
      'workspace.read',
      'member.read',
      'audit.read',
      'credits.read',
      // Phase 5. The role that runs the brand: full Brand Brain authority
      // short of deleting knowledge, which stays with the admins.
      'brand.read',
      'brand.manage',
      'brand_brain.read',
      'brand_brain.edit',
      'brand_brain.upload',
      'brand_brain.review',
      'brand_brain.chat',
      // Phase 5B-1. Everything the library offers except permanent deletion,
      // which stays with the admins exactly as `brand_brain.delete` does.
      'assets.read',
      'assets.use',
      'assets.upload',
      'assets.edit',
      'assets.manage_taxonomy',
      'assets.version',
      'assets.archive',
      'assets.restore',
      // Phase 5B-2. Runs the brand's content end to end, short of deleting it —
      // including the calendar, which is the planning half of that job.
      'content.read',
      'content.create',
      'content.edit',
      'content.submit',
      'content.archive',
      'content.schedule',
    ],
  },
  {
    key: 'content_creator',
    realm: 'workspace',
    nameEn: 'Content Creator',
    nameAr: 'منشئ المحتوى',
    // Reads the brand and asks it questions; may add knowledge and upload
    // sources. May NOT review: approving a candidate is what turns machine
    // output into brand truth (D-65), and that is an approver decision.
    permissionKeys: [
      'workspace.read',
      'member.read',
      'brand.read',
      'brand_brain.read',
      'brand_brain.edit',
      'brand_brain.upload',
      'brand_brain.chat',
      // Phase 5B-1. Creates content, so uploads and uses assets and keeps the
      // library tidy. NOT `version`: replacing the bytes behind an asset other
      // content already references is a heavier act than adding a new one, and
      // NOT `archive`, `restore` or `delete`.
      'assets.read',
      'assets.use',
      'assets.upload',
      'assets.edit',
      'assets.manage_taxonomy',
      // Phase 5B-2. The role the Studio exists for: generates, edits, submits
      // for review and plans when it goes out. Archiving and deleting stay
      // elsewhere.
      'content.read',
      'content.create',
      'content.edit',
      'content.submit',
      'content.schedule',
    ],
  },
  {
    key: 'copywriter',
    realm: 'workspace',
    nameEn: 'Copywriter',
    nameAr: 'كاتب المحتوى',
    permissionKeys: [
      'workspace.read',
      'member.read',
      'brand.read',
      'brand_brain.read',
      'brand_brain.edit',
      'brand_brain.chat',
      // Phase 5B-1. docs/SECURITY.md §4.3 marks "Upload / manage assets" as
      // CONDITIONAL for this role — "own" only. A conditional grant needs the
      // condition ENFORCED, not assumed, and per-actor ownership scoping does
      // not exist yet, so upload is not granted (the F-15 rule: an ungranted
      // capability is recoverable, an ungated one is not). Reading and using
      // approved assets is unconditional and is granted.
      'assets.read',
      'assets.use',
      // Phase 5B-2. Writing captions IS this role's job, so it generates,
      // edits and submits. It still may not archive or delete — and it may not
      // SCHEDULE: deciding when the brand speaks is a different decision from
      // deciding what it says, and the F-15 rule says an ungranted capability
      // is the recoverable mistake.
      'content.read',
      'content.create',
      'content.edit',
      'content.submit',
    ],
  },
  {
    key: 'designer',
    realm: 'workspace',
    nameEn: 'Designer',
    nameAr: 'مصمم',
    // Reads the brand to design consistently with it. No editing.
    permissionKeys: [
      'workspace.read',
      'member.read',
      'brand.read',
      'brand_brain.read',
      'brand_brain.chat',
      // Phase 5B-1. docs/SECURITY.md §4.3 gives this role "Upload / manage
      // assets" OUTRIGHT — it is the role whose work the library exists for.
      // Deletion still stays with the admins.
      'assets.read',
      'assets.use',
      'assets.upload',
      'assets.edit',
      'assets.manage_taxonomy',
      'assets.version',
      'assets.archive',
      'assets.restore',
    ],
  },
  {
    key: 'approver',
    realm: 'workspace',
    nameEn: 'Approver',
    nameAr: 'المعتمِد',
    // The role whose whole purpose is judging proposals. It gets `review`
    // WITHOUT `edit`: approving what was extracted is a different act from
    // authoring brand knowledge, and keeping them apart is what makes the
    // review record mean something.
    permissionKeys: [
      'workspace.read',
      'member.read',
      'brand.read',
      'brand_brain.read',
      'brand_brain.review',
      // Phase 5B-1. Judging a post means seeing the image attached to it, so
      // the library is readable. Nothing else: docs/SECURITY.md §4.3 gives this
      // role no asset authority at all, and `use` is a content decision rather
      // than an approval one.
      'assets.read',
      // Phase 5B-2. Reviews content, so it READS drafts. It does not
      // generate — that spends credits — and it does not edit: an approver
      // who rewrites the thing they are approving is not approving it.
      // The approve/reject ACTION itself belongs to Approvals (scope item 6).
      'content.read',
    ],
  },
  {
    key: 'analyst',
    realm: 'workspace',
    nameEn: 'Analyst',
    nameAr: 'محلل',
    permissionKeys: [
      'workspace.read',
      'member.read',
      'audit.read',
      'credits.read',
      // Read-only, deliberately. `brand_brain.chat` is NOT granted: a chat turn
      // spends credits and writes a conversation, so it is a mutation wearing a
      // question mark, and a read-only role must not be able to spend money.
      'brand.read',
      'brand_brain.read',
      // Phase 5B-1. READ-ONLY, and `assets.use` is deliberately withheld: it is
      // the capability other modules will ask for before putting a file in
      // front of the public, which is not something a read-only role does.
      'assets.read',
      // Phase 5B-2. READ-ONLY, symmetrically with the library above.
      'content.read',
    ],
  },
  {
    /*
     * THE KEY IS UNCHANGED, THE LABEL IS NOT.
     *
     * `client_viewer` is a stored RBAC identifier: it is written into
     * `Membership.roleId` rows, referenced by the permission matrix and
     * asserted by the isolation and RBAC suites. Renaming it would be a data
     * migration wearing a copy change, so it stays exactly as it is, with
     * exactly the permissions it had (`workspace.read`, and nothing else).
     *
     * What changes is the VISIBLE NAME. "Client Viewer" framed the narrowest
     * role as an outside client of an agency, which is one customer shape
     * among six and not the product's own language. "Viewer (read-only)"
     * describes the same access without implying who the person is.
     */
    key: 'client_viewer',
    realm: 'workspace',
    nameEn: 'Viewer (read-only)',
    nameAr: 'مُشاهِد (قراءة فقط)',
    permissionKeys: ['workspace.read'],
  },
  {
    key: 'platform_owner',
    realm: 'platform',
    nameEn: 'Platform Owner',
    nameAr: 'مالك المنصة',
    permissionKeys: allPlatformPermissionKeys,
  },
  {
    key: 'platform_admin',
    realm: 'platform',
    nameEn: 'Platform Admin',
    nameAr: 'مدير المنصة',
    permissionKeys: allPlatformPermissionKeys.filter((k) => k !== 'platform.user.manage'),
  },
  {
    key: 'support_agent',
    realm: 'platform',
    nameEn: 'Support Agent',
    nameAr: 'وكيل الدعم',
    // Helps customers: support mode and a read of the directory, nothing more.
    // No business editing platform configuration, and no business anywhere near
    // a credential. Resending an invitation and
    // granting goodwill credits are marked conditional ("within cap") in
    // docs/SECURITY.md §4.4; the cap does not exist yet, so neither is granted
    // — an ungranted capability is recoverable, an ungated one is not (F-15).
    permissionKeys: ['platform.workspace.read', 'platform.support_mode.enter'],
  },
  {
    key: 'billing_manager',
    realm: 'platform',
    nameEn: 'Billing Manager',
    nameAr: 'مدير الفوترة',
    // docs/SECURITY.md §4.4 gives this role plan assignment and credit
    // movement outright. Everything else there is conditional and therefore
    // ungranted. No configuration or secret authority at all.
    permissionKeys: [
      'platform.workspace.read',
      'platform.plan.assign',
      'platform.credit.adjust',
      // AI usage is the record behind every credit movement this role makes.
      'platform.ai.usage.read',
    ],
  },
  {
    key: 'operations_viewer',
    realm: 'platform',
    nameEn: 'Operations Viewer',
    nameAr: 'مُشاهِد العمليات',
    // Read-only by name and by grant: it can inspect configuration and the
    // audit log, and cannot change either. No secret permission — not even
    // metadata, because nothing in the role's job needs it.
    permissionKeys: [
      'platform.workspace.read',
      'platform.audit.read',
      'platform.configuration.read',
      // Reading AI request history and cost is precisely this role's job.
      'platform.ai.usage.read',
    ],
  },
] as const;

/** A role must never reference a permission from the other realm. */
export function assertRolePermissionsAreValid(): void {
  const byRealm: Record<'workspace' | 'platform', ReadonlySet<string>> = {
    workspace: new Set(WORKSPACE_PERMISSIONS.map((p: PermissionDefinition) => p.key)),
    platform: new Set(PLATFORM_PERMISSIONS.map((p: PermissionDefinition) => p.key)),
  };
  for (const role of ROLE_DEFINITIONS) {
    for (const key of role.permissionKeys) {
      if (!byRealm[role.realm].has(key)) {
        throw new Error(
          `Role "${role.key}" (${role.realm} realm) references permission "${key}" ` +
            `which does not belong to that realm.`,
        );
      }
    }
  }
}
