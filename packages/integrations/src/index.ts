export { activeProviderSelection, type ActiveProviderSelection } from './active-provider';

/**
 * The Integrations Hub — Phase 10 §2 and §4.
 *
 * `registry` describes what BrandSpace can be connected to; `service` joins
 * that description with the configuration an owner entered, the masked
 * credential metadata the Secret Service holds, and what happened the last time
 * we called. Nothing in this package can read a secret value, and nothing in it
 * talks to a provider: reaching one means running an adapter, and the adapters
 * belong to the packages that own their protocols.
 */
export {
  editableSettingFields,
  findIntegration,
  findIntegrationCategory,
  INTEGRATION_CATEGORIES,
  INTEGRATION_CATEGORY_DEFINITIONS,
  INTEGRATION_DEFINITIONS,
  INTEGRATION_ENVIRONMENTS,
  integrationSecretRef,
  integrationsInCategory,
  parseCredentialInput,
  parseSettingsInput,
  secretCategoryFor,
  selectionRefusal,
  settingsSchemaFor,
} from './registry';
export type {
  IntegrationCapabilities,
  IntegrationCategory,
  IntegrationCategoryDefinition,
  IntegrationDefinition,
  IntegrationEnvironment,
  IntegrationField,
  SettingsParseResult,
} from './registry';

export { applyProviderRecord } from './mapping';
export type { IntegrationConfigDomain, ProviderRecordWrite } from './mapping';

export { IntegrationsService } from './service';
export type {
  ConnectionState,
  CredentialStatus,
  IntegrationsServiceOptions,
  IntegrationTester,
  IntegrationView,
} from './service';
