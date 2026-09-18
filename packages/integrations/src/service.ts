import type { Prisma, PrismaClient } from '@brandspace/database';
import type { ConfigurationService, Environment } from '@brandspace/config';
import type { SecretActor, SecretMetadata, SecretService } from '@brandspace/secrets';
import { AppError, redact, systemClock, type Clock } from '@brandspace/shared';
import {
  findIntegration,
  INTEGRATION_CATEGORY_DEFINITIONS,
  INTEGRATION_DEFINITIONS,
  selectionRefusal,
  type IntegrationCategory,
  type IntegrationDefinition,
  type IntegrationEnvironment,
} from './registry';

/**
 * The Integrations Hub service — Phase 10 §2.
 *
 * ONE PLACE THAT ANSWERS "what is connected, and does it work". It reads three
 * sources and joins them; it owns none of them, which is the point:
 *
 *   1. CONFIGURATION — which provider is selected, its non-secret settings and
 *      its credential REFERENCES. Versioned, validated and rollback-able in the
 *      configuration service, exactly where Phase 2A put it.
 *   2. THE SECRET SERVICE — masked metadata for each referenced credential. A
 *      hint, a fingerprint, a rotation date. Never a value: there is no read
 *      path for one anywhere in this product, and this service does not add one.
 *   3. `integration_health_check` — what happened the last time we called.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not talk to a provider itself.
 * Testing a connection means running an adapter, and the adapters live in the
 * packages that own their protocols — `ai-gateway`, `billing`,
 * `social-connectors`, `storage`. Importing all four here would make this
 * package the centre of the dependency graph and would let a Hub screen reach
 * a customer OAuth token. The caller injects an `IntegrationTester` instead, so
 * the wiring happens once, in the API process that already has those
 * dependencies and the platform identity to use them.
 */

/** A masked view of one credential slot. NEVER carries a value. */
export interface CredentialStatus {
  readonly fieldKey: string;
  readonly required: boolean;
  /** The configured reference, or null when the owner has not set one. */
  readonly secretRef: string | null;
  /** Whether a secret actually exists behind that reference. */
  readonly present: boolean;
  /** At most the last four characters — `••••••••••7H2K`. */
  readonly maskedHint: string | null;
  /** Non-reversible. Lets an operator confirm "same key" without decrypting. */
  readonly fingerprint: string | null;
  readonly lastRotatedAt: Date | null;
  readonly expiresAt: Date | null;
}

export type ConnectionState = 'ok' | 'failed' | 'never_tested' | 'not_configured' | 'refused';

export interface IntegrationView {
  readonly category: IntegrationCategory;
  readonly providerKey: string;
  readonly displayNameEn: string;
  readonly displayNameAr: string;
  readonly environment: IntegrationEnvironment;
  readonly supportedEnvironments: readonly IntegrationEnvironment[];
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly adapterAvailable: boolean;
  readonly testable: boolean;
  readonly developmentOnly: boolean;
  readonly noteEn: string;
  readonly noteAr: string;

  /** Whether configuration currently selects this provider for the category. */
  readonly enabled: boolean;
  /** Non-secret settings, as configured. */
  readonly settings: Readonly<Record<string, string>>;
  readonly credentials: readonly CredentialStatus[];
  /**
   * Whether every REQUIRED credential and setting is present.
   *
   * Configuration completeness, not health: a complete integration whose key
   * was revoked yesterday is complete and broken, and the Hub shows both.
   */
  readonly configurationComplete: boolean;
  /** Why it cannot be activated here, or null. */
  readonly selectionRefusal: string | null;

  readonly connection: ConnectionState;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly lastMessage: string | null;
  readonly lastLatencyMs: number | null;
}

/** What a caller must supply to actually reach a provider. */
export interface IntegrationTester {
  /**
   * Run the provider's own connection test.
   *
   * Implementations MUST use minimal billable usage (§10) and must never let a
   * credential reach the returned message.
   */
  test(input: {
    readonly category: IntegrationCategory;
    readonly providerKey: string;
    readonly environment: IntegrationEnvironment;
  }): Promise<{ readonly ok: boolean; readonly latencyMs: number; readonly message: string }>;
}

export interface IntegrationsServiceOptions {
  /** The PLATFORM client. This table is closed to the tenant role. */
  readonly prisma: PrismaClient;
  readonly configuration: ConfigurationService;
  readonly secrets: SecretService;
  readonly clock?: Clock;
}

interface ProviderRecord {
  readonly key: string;
  readonly status?: string;
  readonly settings?: Record<string, unknown>;
  readonly secretRefs?: Record<string, string>;
}

export class IntegrationsService {
  readonly #prisma: PrismaClient;
  readonly #configuration: ConfigurationService;
  readonly #secrets: SecretService;
  readonly #clock: Clock;

  constructor(options: IntegrationsServiceOptions) {
    this.#prisma = options.prisma;
    this.#configuration = options.configuration;
    this.#secrets = options.secrets;
    this.#clock = options.clock ?? systemClock;
  }

  /** Every registered integration, joined with its configuration and health. */
  async list(
    actor: SecretActor,
    environment: IntegrationEnvironment,
  ): Promise<readonly IntegrationView[]> {
    const [configured, secrets, checks] = await Promise.all([
      this.#configuredProviders(environment),
      this.#secretIndex(actor, environment),
      this.#latestChecks(environment),
    ]);

    return INTEGRATION_DEFINITIONS.map((definition) =>
      this.#view(definition, environment, configured, secrets, checks),
    );
  }

  async get(
    actor: SecretActor,
    category: string,
    providerKey: string,
    environment: IntegrationEnvironment,
  ): Promise<IntegrationView> {
    const definition = findIntegration(category, providerKey);
    if (!definition) {
      throw new AppError('NOT_FOUND', `No integration "${category}/${providerKey}" is registered.`);
    }
    const [configured, secrets, checks] = await Promise.all([
      this.#configuredProviders(environment),
      this.#secretIndex(actor, environment),
      this.#latestChecks(environment),
    ]);
    return this.#view(definition, environment, configured, secrets, checks);
  }

  /**
   * Run a connection test and RECORD the outcome.
   *
   * The recording is the point: a test whose result nobody kept is a button
   * that reassures the person who pressed it and tells the next operator
   * nothing. It records refusals and incomplete configuration too, for the same
   * reason — "we never tried" is an answer an operator needs.
   *
   * TESTING IS NOT ACTIVATING (§10). Nothing here changes which provider serves
   * traffic; activation is a configuration change with its own author, its own
   * validation and its own audit trail.
   */
  async testConnection(input: {
    readonly actor: SecretActor;
    readonly category: string;
    readonly providerKey: string;
    readonly environment: IntegrationEnvironment;
    readonly tester: IntegrationTester;
    readonly requestedByPlatformUserId?: string | null;
  }): Promise<IntegrationView> {
    const definition = findIntegration(input.category, input.providerKey);
    if (!definition) {
      throw new AppError(
        'NOT_FOUND',
        `No integration "${input.category}/${input.providerKey}" is registered.`,
      );
    }

    const refusal = selectionRefusal(definition, input.environment);
    if (refusal) {
      await this.#record(definition, input.environment, {
        outcome: 'REFUSED',
        latencyMs: null,
        message: refusal,
        requestedByPlatformUserId: input.requestedByPlatformUserId ?? null,
      });
      return this.get(input.actor, input.category, input.providerKey, input.environment);
    }

    const current = await this.get(
      input.actor,
      input.category,
      input.providerKey,
      input.environment,
    );
    if (!current.configurationComplete) {
      await this.#record(definition, input.environment, {
        outcome: 'NOT_CONFIGURED',
        latencyMs: null,
        message: 'Nothing was attempted: a required credential or setting is missing.',
        requestedByPlatformUserId: input.requestedByPlatformUserId ?? null,
      });
      return this.get(input.actor, input.category, input.providerKey, input.environment);
    }

    let outcome: 'OK' | 'FAILED' = 'FAILED';
    let latencyMs: number | null = null;
    let message = 'The provider did not answer.';
    try {
      const result = await input.tester.test({
        category: definition.category,
        providerKey: definition.providerKey,
        environment: input.environment,
      });
      outcome = result.ok ? 'OK' : 'FAILED';
      latencyMs = result.latencyMs;
      message = result.message;
    } catch (error: unknown) {
      /*
       * A THROWN ERROR IS A FAILED TEST, not a 500. The operator pressed a
       * button to find out whether this works; "it does not, and here is a
       * sentence about why" is the answer they asked for. The message is taken
       * from `AppError` only — a raw exception may carry a URL with a
       * credential in it, and `redact` below is the second line of defence.
       */
      message = error instanceof AppError ? error.message : 'The provider could not be reached.';
    }

    await this.#record(definition, input.environment, {
      outcome,
      latencyMs,
      message,
      requestedByPlatformUserId: input.requestedByPlatformUserId ?? null,
    });
    return this.get(input.actor, input.category, input.providerKey, input.environment);
  }

  /** The verification history an operator reads, newest first. */
  async history(
    category: string,
    providerKey: string,
    environment: IntegrationEnvironment,
    limit = 20,
  ): Promise<
    readonly {
      readonly id: string;
      readonly outcome: string;
      readonly latencyMs: number | null;
      readonly message: string;
      readonly checkedAt: Date;
    }[]
  > {
    const rows = await this.#prisma.integrationHealthCheck.findMany({
      where: { category, providerKey, environment },
      orderBy: { checkedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      select: { id: true, outcome: true, latencyMs: true, message: true, checkedAt: true },
    });
    return rows;
  }

  /**
   * Categories that are required in production and have nobody serving them.
   *
   * Read by the readiness probe and by the Control Center, so "we are not ready
   * to take production traffic" is one computed answer rather than two screens
   * that can disagree.
   */
  async productionGaps(
    actor: SecretActor,
    environment: IntegrationEnvironment,
  ): Promise<readonly { category: IntegrationCategory; reason: string }[]> {
    const views = await this.list(actor, environment);
    const gaps: { category: IntegrationCategory; reason: string }[] = [];

    for (const category of INTEGRATION_CATEGORY_DEFINITIONS) {
      if (!category.requiredInProduction) continue;
      const active = views.filter(
        (view) => view.category === category.key && view.enabled && view.selectionRefusal === null,
      );
      if (active.length === 0) {
        gaps.push({
          category: category.key,
          reason: `No provider is active for ${category.labelEn} in ${environment}.`,
        });
        continue;
      }
      const incomplete = active.filter((view) => !view.configurationComplete);
      if (incomplete.length === active.length) {
        gaps.push({
          category: category.key,
          reason: `The active ${category.labelEn} provider is missing a required credential.`,
        });
      }
    }
    return gaps;
  }

  // --- internals -----------------------------------------------------------

  async #record(
    definition: IntegrationDefinition,
    environment: IntegrationEnvironment,
    input: {
      outcome: 'OK' | 'FAILED' | 'NOT_CONFIGURED' | 'REFUSED';
      latencyMs: number | null;
      message: string;
      requestedByPlatformUserId: string | null;
    },
  ): Promise<void> {
    /*
     * `createMany`, NOT `create`, and for the reason the codebase has met
     * twice before: `create` issues INSERT ... RETURNING, and RLS applies the
     * policy USING clause to the returned row. This table admits only the
     * platform role, which IS the writer here — so the RETURNING would in fact
     * succeed. It is `createMany` anyway because nothing reads the result, and
     * a row that cannot be read back is the cheaper write.
     */
    await this.#prisma.integrationHealthCheck.createMany({
      data: [
        {
          category: definition.category,
          providerKey: definition.providerKey,
          environment: environment as Environment,
          outcome: input.outcome,
          latencyMs: input.latencyMs,
          // The redaction layer runs even though adapters are trusted: a
          // message assembled from a provider response must not be able to
          // smuggle a credential into a table an operator reads casually.
          message: redactedMessage(input.message),
          requestedByPlatformUserId: input.requestedByPlatformUserId,
          checkedAt: this.#clock.now(),
        },
      ],
    });
  }

  /** The configured record for each category, keyed `category:providerKey`. */
  async #configuredProviders(
    environment: IntegrationEnvironment,
  ): Promise<Map<string, { record: ProviderRecord; active: boolean }>> {
    const index = new Map<string, { record: ProviderRecord; active: boolean }>();

    for (const category of INTEGRATION_CATEGORY_DEFINITIONS) {
      if (category.key === 'ai') {
        const doc = await this.#configuration.get('ai.providers', environment as Environment);
        for (const provider of doc.providers) {
          index.set(`ai:${provider.key}`, {
            record: {
              key: provider.key,
              status: provider.status,
              settings: { baseUrl: provider.baseUrl },
              secretRefs: provider.apiKeySecretRef ? { apiKey: provider.apiKeySecretRef } : {},
            },
            active: provider.status === 'active',
          });
        }
        continue;
      }
      if (category.key === 'social') {
        const doc = await this.#configuration.get(
          'integrations.social-apps',
          environment as Environment,
        );
        for (const app of doc.applications) {
          index.set(`social:${app.providerKey}`, {
            record: {
              key: app.providerKey,
              status: app.status,
              settings: { appId: app.appId, redirectUri: app.redirectUri },
              secretRefs: {
                ...(app.clientSecretRef ? { clientSecret: app.clientSecretRef } : {}),
                ...(app.webhookSecretRef ? { webhookSecret: app.webhookSecretRef } : {}),
              },
            },
            active: app.status === 'active',
          });
        }
        /*
         * The development social connector is not an entry in
         * `integrations.social-apps` — it needs no app id and no client secret,
         * which is exactly what makes it a development double. Outside
         * production it is available by construction, and the registry's
         * `selectionRefusal` is what keeps it out of production.
         */
        index.set('social:mock', {
          record: { key: 'mock', status: 'active', settings: {}, secretRefs: {} },
          active: environment !== 'PRODUCTION',
        });
        continue;
      }

      const domain = category.configDomain as
        | 'integrations.email'
        | 'integrations.storage'
        | 'integrations.payment'
        | 'integrations.observability';
      const doc = await this.#configuration.get(domain, environment as Environment);
      for (const provider of doc.providers) {
        index.set(`${category.key}:${provider.key}`, {
          record: {
            key: provider.key,
            status: provider.status,
            settings: provider.settings as Record<string, unknown>,
            secretRefs: provider.secretRefs,
          },
          active: doc.activeProviderKey === provider.key && provider.status === 'active',
        });
      }
    }
    return index;
  }

  /** Masked metadata for every platform secret in this environment. */
  async #secretIndex(
    actor: SecretActor,
    environment: IntegrationEnvironment,
  ): Promise<Map<string, SecretMetadata>> {
    /*
     * THE ACTOR IS REQUIRED, and the Secret Service checks it rather than this
     * one. Even masked metadata is operational intelligence — which providers
     * are wired up, when a key was last rotated, which environments are live —
     * so reading the Hub is as privileged as reading the secret list, because
     * it IS reading the secret list.
     */
    const page = await this.#secrets.listSecrets(actor, {
      environment: environment as Environment,
      pageSize: 100,
    });
    const index = new Map<string, SecretMetadata>();
    for (const item of page.items) index.set(item.ref, item);

    // The list is paged; an installation with more than a hundred platform
    // secrets must not silently show "not set" for the ones past the first page.
    for (let page2 = 2; page2 <= Math.min(page.totalPages, 20); page2 += 1) {
      const next = await this.#secrets.listSecrets(actor, {
        environment: environment as Environment,
        page: page2,
        pageSize: 100,
      });
      for (const item of next.items) index.set(item.ref, item);
    }
    return index;
  }

  async #latestChecks(
    environment: IntegrationEnvironment,
  ): Promise<Map<string, IntegrationCheckRow[]>> {
    const rows = await this.#prisma.integrationHealthCheck.findMany({
      where: { environment: environment as Environment },
      orderBy: { checkedAt: 'desc' },
      take: 500,
      select: {
        category: true,
        providerKey: true,
        outcome: true,
        latencyMs: true,
        message: true,
        checkedAt: true,
      },
    });
    const index = new Map<string, IntegrationCheckRow[]>();
    for (const row of rows) {
      const key = `${row.category}:${row.providerKey}`;
      const list = index.get(key);
      if (list) list.push(row);
      else index.set(key, [row]);
    }
    return index;
  }

  #view(
    definition: IntegrationDefinition,
    environment: IntegrationEnvironment,
    configured: Map<string, { record: ProviderRecord; active: boolean }>,
    secrets: Map<string, SecretMetadata>,
    checks: Map<string, IntegrationCheckRow[]>,
  ): IntegrationView {
    const key = `${definition.category}:${definition.providerKey}`;
    const entry = configured.get(key);
    const settings = Object.fromEntries(
      Object.entries(entry?.record.settings ?? {}).map(([k, v]) => [k, String(v)]),
    );

    const credentials: CredentialStatus[] = definition.credentialFields.map((field) => {
      const ref = entry?.record.secretRefs?.[field.key] ?? null;
      const metadata = ref ? (secrets.get(ref) ?? null) : null;
      return {
        fieldKey: field.key,
        required: field.required,
        secretRef: ref,
        present: metadata !== null,
        maskedHint: metadata?.maskedHint ?? null,
        fingerprint: metadata?.fingerprint ?? null,
        lastRotatedAt: metadata?.lastRotatedAt ?? null,
        expiresAt: metadata?.expiresAt ?? null,
      };
    });

    const missingCredential = credentials.some((c) => c.required && !c.present);
    const missingSetting = definition.settingFields.some(
      (field) => field.required && !settings[field.key],
    );

    const history = checks.get(key) ?? [];
    const latest = history[0] ?? null;
    const lastSuccess = history.find((row) => row.outcome === 'OK') ?? null;
    const lastFailure = history.find((row) => row.outcome === 'FAILED') ?? null;

    let connection: ConnectionState = 'never_tested';
    if (latest) {
      connection =
        latest.outcome === 'OK'
          ? 'ok'
          : latest.outcome === 'FAILED'
            ? 'failed'
            : latest.outcome === 'REFUSED'
              ? 'refused'
              : 'not_configured';
    }

    return {
      category: definition.category,
      providerKey: definition.providerKey,
      displayNameEn: definition.displayNameEn,
      displayNameAr: definition.displayNameAr,
      environment,
      supportedEnvironments: definition.supportedEnvironments,
      capabilities: definition.capabilities,
      adapterAvailable: definition.adapterAvailable,
      testable: definition.testable,
      developmentOnly: definition.developmentOnly,
      noteEn: definition.noteEn,
      noteAr: definition.noteAr,
      enabled: entry?.active ?? false,
      settings,
      credentials,
      configurationComplete: !missingCredential && !missingSetting,
      selectionRefusal: selectionRefusal(definition, environment),
      connection,
      lastSuccessAt: lastSuccess?.checkedAt ?? null,
      lastFailureAt: lastFailure?.checkedAt ?? null,
      lastCheckedAt: latest?.checkedAt ?? null,
      lastMessage: latest?.message ?? null,
      lastLatencyMs: latest?.latencyMs ?? null,
    };
  }
}

interface IntegrationCheckRow {
  readonly category: string;
  readonly providerKey: string;
  readonly outcome: string;
  readonly latencyMs: number | null;
  readonly message: string;
  readonly checkedAt: Date;
}

/**
 * The message as it is safe to store.
 *
 * `redact` is the platform-wide layer every log sink and error serializer
 * already runs through (docs/SECURITY.md §5). Applying it here too is not
 * belt-and-braces theatre: an adapter assembles this sentence from a provider
 * response, and a provider that echoes a request URL back in an error has
 * echoed whatever was in that URL.
 */
function redactedMessage(message: string): string {
  const redacted = redact({ message }) as { message?: unknown } | null;
  const value = typeof redacted?.message === 'string' ? redacted.message : message;
  return value.slice(0, 2000);
}

/** Narrowing helper so `Prisma` stays imported for the type-only seam. */
export type IntegrationWriteInput = Prisma.IntegrationHealthCheckCreateManyInput;
