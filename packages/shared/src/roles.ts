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
    // Everything except ownership transfer and workspace deletion.
    permissionKeys: allWorkspacePermissionKeys.filter(
      (k) => k !== 'workspace.transfer_ownership' && k !== 'workspace.delete',
    ),
  },
  {
    key: 'marketing_manager',
    realm: 'workspace',
    nameEn: 'Marketing Manager',
    nameAr: 'مدير التسويق',
    permissionKeys: ['workspace.read', 'member.read', 'audit.read'],
  },
  {
    key: 'content_creator',
    realm: 'workspace',
    nameEn: 'Content Creator',
    nameAr: 'منشئ المحتوى',
    permissionKeys: ['workspace.read', 'member.read'],
  },
  {
    key: 'copywriter',
    realm: 'workspace',
    nameEn: 'Copywriter',
    nameAr: 'كاتب المحتوى',
    permissionKeys: ['workspace.read', 'member.read'],
  },
  {
    key: 'designer',
    realm: 'workspace',
    nameEn: 'Designer',
    nameAr: 'مصمم',
    permissionKeys: ['workspace.read', 'member.read'],
  },
  {
    key: 'approver',
    realm: 'workspace',
    nameEn: 'Approver',
    nameAr: 'المعتمِد',
    permissionKeys: ['workspace.read', 'member.read'],
  },
  {
    key: 'analyst',
    realm: 'workspace',
    nameEn: 'Analyst',
    nameAr: 'محلل',
    permissionKeys: ['workspace.read', 'member.read', 'audit.read'],
  },
  {
    key: 'client_viewer',
    realm: 'workspace',
    nameEn: 'Client Viewer',
    nameAr: 'عميل مُشاهِد',
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
    permissionKeys: ['platform.workspace.read', 'platform.support_mode.enter'],
  },
  {
    key: 'billing_manager',
    realm: 'platform',
    nameEn: 'Billing Manager',
    nameAr: 'مدير الفوترة',
    permissionKeys: ['platform.workspace.read'],
  },
  {
    key: 'operations_viewer',
    realm: 'platform',
    nameEn: 'Operations Viewer',
    nameAr: 'مُشاهِد العمليات',
    permissionKeys: ['platform.workspace.read', 'platform.audit.read'],
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
