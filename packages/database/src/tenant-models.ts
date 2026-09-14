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
export const STRICT_TENANT_MODELS = [
  'Workspace',
  'Membership',
  'SupportModeSession',
  // Phase 2B
  'Invitation',
  'WorkspaceOverride',
  'CreditWallet',
  'CreditTransaction',
  // Phase 3. Every one is per-customer commercial or consumption state and
  // carries a non-null `workspaceId`.
  'WorkspaceSubscription',
  'CreditGrant',
  'CreditReservation',
  'UsageCounter',
  'UsageEvent',
  'BetaCohortMembership',
  // Phase 4. An AI request and its ledger row are both per-customer: the
  // request records what a workspace asked for, the ledger what it was
  // charged. Neither may ever be visible across a tenant boundary.
  'AiRequest',
  'AiUsageLedger',
  // Phase 5. Brand Brain holds what a customer has told us about its own
  // brand — the most sensitive tenant data in the product after credentials,
  // and the one corpus a competitor would most want. Every one of these
  // carries a non-null `workspaceId` AND a composite foreign key to `brand`,
  // so the brand boundary is enforced alongside the workspace boundary.
  //
  // (No apostrophes in this block: readRegistryList parses it with a
  // quote-matching regex, so one would silently swallow the names below.)
  'Brand',
  'BrandKnowledgeItem',
  'BrandKnowledgeVersion',
  'BrandSourceDocument',
  'BrandSourceChunk',
  'BrandKnowledgeCandidate',
  'BrandIngestionJob',
  'BrandBrainConversation',
  'BrandBrainMessage',
  // Phase 5B-1. The Asset Library holds files belonging to the customer:
  // brand photography, contracts, logo packs, campaign video. Every one of
  // these carries a non-null workspaceId. Five of the six are additionally
  // brand-scoped with a NULLABLE brand, because docs/DATABASE.md §4.6 makes a
  // null brand mean "belongs to the workspace" rather than "belongs to
  // nobody" — and the composite foreign key still checks every row that DOES
  // name a brand, because PostgreSQL MATCH SIMPLE exempts only the null case.
  //
  // (No apostrophes in this block either: readRegistryList parses it with a
  // quote-matching regex, so one would silently swallow the names below.)
  'AssetFolder',
  'Asset',
  'AssetVersion',
  'AssetDerivative',
  'AssetUploadSession',
  'AssetProcessingJob',
] as const;

/**
 * Models carrying a NULLABLE `workspaceId`. These still require a policy, but the
 * meaning of NULL differs per model and each behaviour is asserted by a test.
 */
export const NULLABLE_TENANT_MODELS = [
  'Role',
  'AuditEvent',
  // Phase 2B. NULL denotes a message that precedes any workspace — a password
  // reset — and `NULL = <uuid>` is never true, so tenants never see those rows.
  'EmailMessage',
] as const;

/**
 * Not tenant-owned, but still RLS-protected because they can leak tenant
 * membership. `User` is a global identity; inside a workspace context only users
 * with a membership in that workspace are visible.
 */
export const IDENTITY_MODELS_WITH_POLICY = [
  'User',
  // Phase 2B. A customer session belongs to a global identity, not to a
  // workspace: the workspace is chosen AFTER authentication. Both are still
  // RLS-protected, and their policy admits ONLY the no-workspace-context
  // authentication path, so a member acting inside workspace A cannot read
  // session or reset rows at all.
  'CustomerSession',
  'PasswordResetToken',
] as const;

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
export const GLOBAL_MODELS = [
  'Permission',
  'RolePermission',
  // Phase 2B. A tenant-readable projection of the three configuration domains
  // that entitlement resolution depends on: feature keys, plan keys, limits and
  // flag rules. Identical rows for every tenant, no customer data, no secrets.
  // The `configuration_version` table itself stays platform-owned and remains
  // unreadable by the tenant role.
  'EntitlementCatalogueSnapshot',
] as const;

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
  // Phase 2B
  CustomerSession: 'customer_session',
  PasswordResetToken: 'password_reset_token',
  Invitation: 'invitation',
  WorkspaceOverride: 'workspace_override',
  CreditWallet: 'credit_wallet',
  CreditTransaction: 'credit_transaction',
  // Phase 3
  WorkspaceSubscription: 'workspace_subscription',
  CreditGrant: 'credit_grant',
  CreditReservation: 'credit_reservation',
  UsageCounter: 'usage_counter',
  UsageEvent: 'usage_event',
  BetaCohortMembership: 'beta_cohort_membership',
  // Phase 4.
  AiRequest: 'ai_request',
  AiUsageLedger: 'ai_usage_ledger',
  // Phase 5.
  Brand: 'brand',
  BrandKnowledgeItem: 'brand_knowledge_item',
  BrandKnowledgeVersion: 'brand_knowledge_version',
  BrandSourceDocument: 'brand_source_document',
  BrandSourceChunk: 'brand_source_chunk',
  BrandKnowledgeCandidate: 'brand_knowledge_candidate',
  BrandIngestionJob: 'brand_ingestion_job',
  BrandBrainConversation: 'brand_brain_conversation',
  BrandBrainMessage: 'brand_brain_message',
  // Phase 5B-1 — the Asset Library.
  AssetFolder: 'asset_folder',
  Asset: 'asset',
  AssetVersion: 'asset_version',
  AssetDerivative: 'asset_derivative',
  AssetUploadSession: 'asset_upload_session',
  AssetProcessingJob: 'asset_processing_job',
  EmailMessage: 'email_message',
  EntitlementCatalogueSnapshot: 'entitlement_catalogue_snapshot',
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
