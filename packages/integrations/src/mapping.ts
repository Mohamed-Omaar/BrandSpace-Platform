import { AppError } from '@brandspace/shared';
import type { IntegrationDefinition } from './registry';

/**
 * THE HUB'S GENERIC FORM, WRITTEN INTO THE CANONICAL DOCUMENTS — Phase 10
 * correction §5.
 *
 * WHY THIS IS A SEPARATE FILE. The Integrations Hub presents one shape to the
 * owner — settings and credentials — but the configuration service holds three
 * genuinely different documents behind it: `ai.providers` has eligibility gates
 * and concurrency limits that predate the Hub, `integrations.social-apps` is
 * keyed by platform and carries an app id and a redirect URI, and the other four
 * categories share one `{ key, name, status, settings, secretRefs }` shape.
 * Those documents are not the Hub's to redesign (§5 says so in as many words),
 * so the Hub translates into them.
 *
 * THE INVARIANT EVERY BRANCH HOLDS: this function may create a provider RECORD
 * and may update its settings and secret references. It may NEVER change
 * `status`, and it may NEVER change `activeProviderKey`. Saving is not
 * activating (§6), and the cheapest way to guarantee that is to make the
 * function that saves incapable of activating.
 *
 * AND NOTHING HERE READS THE FORM. Every key comes from the registry definition
 * the caller resolved; `settings` and `secretRefs` arrive already parsed against
 * it. A caller cannot reach this code with an undeclared field.
 */

export type IntegrationConfigDomain =
  | 'ai.providers'
  | 'integrations.social-apps'
  | 'integrations.email'
  | 'integrations.storage'
  | 'integrations.payment'
  | 'integrations.observability';

/**
 * What a NEW AI provider record starts as.
 *
 * DRAFT, AND UNVERIFIED ON EVERY D-13 GATE. The Hub can create the record and
 * hold its base URL and API key, but it cannot assert that a vendor does not
 * train on customer data — a person confirms that in a privacy review, and
 * `validateConfiguration` refuses to activate a provider still sitting on the
 * default. Creating the row pre-cleared would turn an owner decision into a
 * side effect of filling in a form.
 */
const AI_PROVIDER_DEFAULTS = {
  status: 'draft',
  timeoutMs: 30_000,
  maxConcurrency: 8,
  noTrainingGuarantee: false,
  dataRetentionPolicy: 'unverified',
} as const;

export interface ProviderRecordWrite {
  readonly definition: IntegrationDefinition;
  readonly domain: IntegrationConfigDomain;
  /** The currently active document, already read. Never mutated. */
  readonly document: Readonly<Record<string, unknown>>;
  /** Declared, parsed non-secret settings. */
  readonly settings: Readonly<Record<string, string>>;
  /** Declared credential slots that now have a stored secret, as references. */
  readonly secretRefs: Readonly<Record<string, string>>;
}

/** The next document, with this provider's settings and references applied. */
export function applyProviderRecord(input: ProviderRecordWrite): Record<string, unknown> {
  const next = structuredClone(input.document) as Record<string, unknown>;

  if (input.domain === 'ai.providers') {
    applyAiProvider(next, input);
    return next;
  }
  if (input.domain === 'integrations.social-apps') {
    applySocialApplication(next, input);
    return next;
  }
  applyGenericProvider(next, input);
  return next;
}

function applyAiProvider(next: Record<string, unknown>, input: ProviderRecordWrite): void {
  const providers = (next['providers'] ?? []) as Record<string, unknown>[];
  const existing = providers.find((provider) => provider['key'] === input.definition.providerKey);

  /*
   * THE TWO FIELDS THIS DOMAIN SPELLS DIFFERENTLY. `ai.providers` predates the
   * Hub and names the base URL `baseUrl` and the key reference
   * `apiKeySecretRef`; the Hub's generic form calls them `baseUrl` and `apiKey`.
   * Translating here is the whole reason this file exists — the alternative was
   * reshaping a document every AI request already reads.
   */
  const baseUrl = input.settings['baseUrl'];
  const apiKeyRef = input.secretRefs['apiKey'] ?? null;

  if (existing) {
    if (baseUrl !== undefined) existing['baseUrl'] = baseUrl;
    if (apiKeyRef !== null) existing['apiKeySecretRef'] = apiKeyRef;
    return;
  }

  /*
   * A NEW RECORD NEEDS A BASE URL, because the schema requires a URL and there
   * is no honest default for one. The refusal names the field rather than
   * letting Zod reject the draft with a path an owner cannot read.
   */
  if (baseUrl === undefined) {
    throw new AppError(
      'VALIDATION_FAILED',
      'A base URL is required before this AI provider can be recorded.',
    );
  }

  providers.push({
    key: input.definition.providerKey,
    name: input.definition.displayNameEn,
    baseUrl,
    apiKeySecretRef: apiKeyRef,
    ...AI_PROVIDER_DEFAULTS,
  });
  next['providers'] = providers;
}

function applySocialApplication(next: Record<string, unknown>, input: ProviderRecordWrite): void {
  const applications = (next['applications'] ?? []) as Record<string, unknown>[];
  const existing = applications.find(
    (application) => application['providerKey'] === input.definition.providerKey,
  );

  const appId = input.settings['appId'];
  const redirectUri = input.settings['redirectUri'];
  const clientSecretRef = input.secretRefs['clientSecret'] ?? null;
  const webhookSecretRef = input.secretRefs['webhookSecret'] ?? null;

  if (existing) {
    if (appId !== undefined) existing['appId'] = appId;
    if (redirectUri !== undefined) existing['redirectUri'] = redirectUri;
    if (clientSecretRef !== null) existing['clientSecretRef'] = clientSecretRef;
    if (webhookSecretRef !== null) existing['webhookSecretRef'] = webhookSecretRef;
    return;
  }

  if (appId === undefined || redirectUri === undefined) {
    throw new AppError(
      'VALIDATION_FAILED',
      'An application id and a redirect URI are required before this platform can be recorded.',
    );
  }

  applications.push({
    providerKey: input.definition.providerKey,
    appId,
    redirectUri,
    scopes: [],
    clientSecretRef,
    webhookSecretRef,
    status: 'draft',
  });
  next['applications'] = applications;
}

function applyGenericProvider(next: Record<string, unknown>, input: ProviderRecordWrite): void {
  const providers = (next['providers'] ?? []) as Record<string, unknown>[];
  const existing = providers.find((provider) => provider['key'] === input.definition.providerKey);

  if (existing) {
    existing['settings'] = {
      ...((existing['settings'] as Record<string, unknown>) ?? {}),
      ...input.settings,
    };
    existing['secretRefs'] = {
      ...((existing['secretRefs'] as Record<string, unknown>) ?? {}),
      ...input.secretRefs,
    };
    return;
  }

  providers.push({
    key: input.definition.providerKey,
    name: input.definition.displayNameEn,
    // DRAFT. A record that appeared already active would make saving a
    // credential an activation, which §6 forbids and §7 gates behind a
    // stronger permission than the one that got us here.
    status: 'draft',
    settings: { ...input.settings },
    secretRefs: { ...input.secretRefs },
  });
  next['providers'] = providers;
}
