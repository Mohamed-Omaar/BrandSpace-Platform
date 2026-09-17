/**
 * Per-platform social connectors and the publishing pipeline — Phase 6
 * (docs/SOCIAL-INTEGRATIONS.md, docs/PRODUCT.md §5 modules 8 and 9).
 *
 * THE PUBLIC SURFACE. Nothing outside this package reaches into a module
 * directly, and no provider SDK is imported anywhere in it: every external call
 * goes through `SocialConnectorAdapter`, which is the only thing that knows a
 * platform exists.
 *
 * NO TOKEN CROSSES THIS BOUNDARY. `ConnectionView` and `PublishJobView` are the
 * shapes a screen receives, and neither has a field that could hold one.
 */
export type {
  AdapterApplication,
  AdapterCredentials,
  AuthorizationRequest,
  ConnectionHealth,
  PublishFailure,
  PublishOutcome,
  PublishRequest,
  PublishSuccess,
  PublishTarget,
  SocialConnectorAdapter,
  TokenBundle,
} from './adapter';

export { MockSocialConnectorAdapter } from './mock-adapters';
export { createConnectorRegistry } from './registry';
export type { ConnectorRegistry, ConnectorRegistryOptions } from './registry';

export {
  capabilitiesFor,
  parsePublishingPolicy,
  PROVIDER_CONFIG_KEYS,
  PUBLISHING_CONFIG_DOMAIN,
  resolvePublishingPolicy,
  SOCIAL_PROVIDERS,
  TenantPublishingPolicySource,
} from './policy';
export type {
  ProviderCapabilities,
  ProviderConfigKey,
  PublishingCatalogueReader,
  PublishingPolicy,
} from './policy';

export { SocialTokenVault, socialEncryptionContext } from './token-vault';
export type { SocialTokenVaultOptions, TokenMaterial } from './token-vault';

export { SocialOAuthService } from './oauth';
export type {
  ApplicationResolver,
  CompleteConnectionResult,
  OAuthActor,
  PendingSelectionView,
  SocialOAuthOptions,
  StartConnectionResult,
} from './oauth';

export { SocialConnectionService, toConnectionView } from './connections';
export type { ConnectionServiceOptions, ConnectionView } from './connections';

export {
  PublishPipelineService,
  providerForPlatformKey,
  publishIdempotencyKey,
} from './publishing';
export type {
  ExecuteResult,
  MaterialiseResult,
  PublishApprovalGate,
  PublishNotifier,
  PublishPipelineOptions,
} from './publishing';

export { PublishHistoryService, toPublishJobView } from './history';
export type { PublishAttemptView, PublishHistoryOptions, PublishJobView } from './history';

export {
  connectionLimitReached,
  connectionNotPublishable,
  FAILURE_BEHAVIOUR,
  oauthStateInvalid,
  providerNotEnabled,
  publishJobNotCancellable,
  publishJobNotFound,
  publishJobNotRetryable,
  socialConnectionNotFound,
  unsupportedByProvider,
} from './errors';
export type { FailureBehaviour } from './errors';

/*
 * Phase 7 — the SHARED provider request budget.
 *
 * Exported from here rather than from the analytics package because a
 * platform's rate limit belongs to our relationship with that platform, not to
 * whichever feature happens to be talking to it. Analytics ingestion imports it
 * so a backfill cannot spend the allowance a scheduled post needs.
 */
export { ProviderRateLimiter } from './rate-limits';
export type { ProviderBudget, RateLimitDecision, RateLimitPriority } from './rate-limits';
