/**
 * The tenancy registry — the single source of truth for how every model in the
 * schema is classified, and therefore which models MUST have an RLS policy and
 * isolation test coverage.
 *
 * D-29: scripts/isolation-gate.ts parses prisma/schema.prisma, derives the
 * tenant-owned set from the presence of a `workspaceId` field, cross-checks it
 * against this registry, and fails CI when the registry, the RLS policies, or
 * the isolation tests disagree with it. Adding a tenant-owned model without
 * tests is therefore a build failure, not a code-review omission.
 *
 * Phase 2A extends the same idea to PLATFORM-owned models. Those carry no
 * `workspaceId`, so the schema alone cannot classify them — a model with no
 * tenant key is either a harmless global catalogue or the most sensitive table
 * in the database, and the difference is a judgement call. The gate therefore
 * requires every model to be listed here explicitly: a new model that nobody
 * classified breaks the build rather than silently defaulting to "global".
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

/**
 * PLATFORM-owned models. These belong to BrandSpace itself, not to any customer:
 * Platform Admin credentials and sessions, versioned configuration, and encrypted
 * secret material. The tenant application role must have NO access to them at
 * all — not "filtered access", none — so each of these requires:
 *
 *   - ENABLE + FORCE row-level security,
 *   - a policy granted to `brandspace_platform` and to nobody else,
 *   - `REVOKE ALL ... FROM brandspace_app`,
 *   - an isolation test proving the tenant role is refused.
 *
 * `PlatformUser` moved here in Phase 2A. It was previously classified as a
 * global catalogue, which meant the blanket `GRANT ... ON ALL TABLES` from the
 * RLS migration left the Platform Owner's password hash readable by the tenant
 * role. See migration 20260901210500_platform_user_isolation.
 */
export const PLATFORM_OWNED_MODELS = [
  'PlatformUser',
  'PlatformSession',
  'PlatformMfaRecoveryCode',
  'ConfigurationVersion',
  'SecretRecord',
  'SecretVersion',
] as const;

/**
 * Global catalogues. No customer data and no platform credentials: the same rows
 * for every tenant, and readable by the tenant role because RBAC resolution
 * needs them.
 */
export const GLOBAL_MODELS = ['Permission', 'RolePermission'] as const;

export type TenantModel =
  (typeof STRICT_TENANT_MODELS)[number] | (typeof NULLABLE_TENANT_MODELS)[number];

export type PlatformOwnedModel = (typeof PLATFORM_OWNED_MODELS)[number];

/** Every model that must carry an RLS policy. */
export const MODELS_REQUIRING_RLS = [
  ...STRICT_TENANT_MODELS,
  ...NULLABLE_TENANT_MODELS,
  ...IDENTITY_MODELS_WITH_POLICY,
  ...PLATFORM_OWNED_MODELS,
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
  PlatformSession: 'platform_session',
  PlatformMfaRecoveryCode: 'platform_mfa_recovery_code',
  ConfigurationVersion: 'configuration_version',
  SecretRecord: 'secret_record',
  SecretVersion: 'secret_version',
};

export function isTenantOwned(model: string): model is TenantModel {
  return (
    (STRICT_TENANT_MODELS as readonly string[]).includes(model) ||
    (NULLABLE_TENANT_MODELS as readonly string[]).includes(model)
  );
}

export function isPlatformOwned(model: string): model is PlatformOwnedModel {
  return (PLATFORM_OWNED_MODELS as readonly string[]).includes(model);
}
