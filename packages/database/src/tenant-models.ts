/**
 * The tenancy registry — the single source of truth for which models are
 * tenant-owned, and therefore which models MUST have an RLS policy and isolation
 * test coverage.
 *
 * D-29: scripts/isolation-gate.ts parses prisma/schema.prisma, derives the
 * tenant-owned set from the presence of a `workspaceId` field, and fails CI when
 * this registry, the RLS policies, or the isolation tests disagree with it.
 * Adding a tenant-owned model without tests is therefore a build failure, not a
 * code-review omission.
 */

/** Models carrying a non-null `workspaceId`: strict tenant ownership. */
export const STRICT_TENANT_MODELS = ['Workspace', 'Membership', 'SupportModeSession'] as const;

/**
 * Models carrying a NULLABLE `workspaceId`. These still require a policy, but the
 * meaning of NULL differs per model and each behaviour is asserted by a test.
 */
export const NULLABLE_TENANT_MODELS = ['Role', 'AuditEvent'] as const;

/**
 * Not tenant-owned, but still RLS-protected because they can leak tenant
 * membership. `User` is a global identity; inside a workspace context only users
 * with a membership in that workspace are visible.
 */
export const IDENTITY_MODELS_WITH_POLICY = ['User'] as const;

/** Global catalogues. No customer data, identical for every tenant. */
export const GLOBAL_MODELS = ['Permission', 'RolePermission', 'PlatformUser'] as const;

export type TenantModel =
  (typeof STRICT_TENANT_MODELS)[number] | (typeof NULLABLE_TENANT_MODELS)[number];

/** Every model that must carry an RLS policy. */
export const MODELS_REQUIRING_RLS = [
  ...STRICT_TENANT_MODELS,
  ...NULLABLE_TENANT_MODELS,
  ...IDENTITY_MODELS_WITH_POLICY,
] as const;

/** Prisma model name -> physical table name (@@map). */
export const MODEL_TABLE_NAMES: Record<string, string> = {
  User: 'user',
  PlatformUser: 'platform_user',
  Workspace: 'workspace',
  Membership: 'membership',
  Role: 'role',
  Permission: 'permission',
  RolePermission: 'role_permission',
  AuditEvent: 'audit_event',
  SupportModeSession: 'support_mode_session',
};

export function isTenantOwned(model: string): model is TenantModel {
  return (
    (STRICT_TENANT_MODELS as readonly string[]).includes(model) ||
    (NULLABLE_TENANT_MODELS as readonly string[]).includes(model)
  );
}
