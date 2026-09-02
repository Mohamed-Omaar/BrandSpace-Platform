import { z } from 'zod';

/**
 * Configuration domains and their schemas.
 *
 * CLAUDE.md §2.2: providers, models, routing, plans, prices, limits, credit
 * costs, feature availability, templates and website content are CONFIGURATION,
 * never code. Each domain below is a schema-backed document the Platform Owner
 * edits in the Control Center.
 *
 * The defaults here are BOOTSTRAP values for local development only. They are
 * deliberately empty or clearly-marked placeholders: inventing prices, provider
 * names or credit costs would be putting business decisions in code, which is
 * exactly what this service exists to prevent. Real values are entered by the
 * owner, and the ones still awaiting a decision are recorded in
 * docs/DECISIONS.md.
 */

const localizedText = z.object({ ar: z.string(), en: z.string() });

// --- AI ---------------------------------------------------------------------
const aiProvidersSchema = z.object({
  providers: z
    .array(
      z.object({
        key: z.string().min(1),
        name: z.string().min(1),
        baseUrl: z.string().url(),
        /** Reference into the Secret Service. NEVER a key value. */
        apiKeySecretRef: z.string().min(1).nullable(),
        status: z.enum(['draft', 'validated', 'active', 'disabled']),
        timeoutMs: z.number().int().positive().max(600_000),
        maxConcurrency: z.number().int().positive().max(1000),
        /** Only providers with no-training terms are eligible for production. */
        noTrainingGuarantee: z.boolean(),
      }),
    )
    .default([]),
});

const aiModelsSchema = z.object({
  models: z
    .array(
      z.object({
        key: z.string().min(1),
        providerKey: z.string().min(1),
        displayName: z.string().min(1),
        modality: z.enum(['text', 'image', 'video', 'voice', 'embedding', 'moderation']),
        qualityTier: z.enum(['fast', 'balanced', 'premium']),
        status: z.enum(['available', 'beta', 'deprecated', 'disabled']),
        /** Kill switch — a disabled model is unusable by routing immediately. */
        disableSwitch: z.boolean().default(false),
      }),
    )
    .default([]),
});

const aiModelCapabilitiesSchema = z.object({
  capabilities: z
    .array(
      z.object({
        modelKey: z.string().min(1),
        contextWindow: z.number().int().positive().nullable(),
        maxOutputTokens: z.number().int().positive().nullable(),
        supportsStreaming: z.boolean().default(false),
        supportsToolUse: z.boolean().default(false),
        supportsJsonMode: z.boolean().default(false),
        languages: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

const aiRoutingSchema = z.object({
  rules: z
    .array(
      z.object({
        taskKey: z.string().min(1),
        scope: z.enum(['global', 'plan', 'workspace']).default('global'),
        planKey: z.string().nullable().default(null),
        workspaceId: z.string().uuid().nullable().default(null),
        primaryModelKey: z.string().min(1),
        /** Ordered. Tried only for fallback-eligible error classes. */
        fallbackModelKeys: z.array(z.string()).default([]),
        timeoutMs: z.number().int().positive().default(30_000),
        maxCostPerRequestMinor: z.number().int().nonnegative().nullable().default(null),
        priority: z.number().int().default(0),
      }),
    )
    .default([]),
});

const aiCreditRulesSchema = z.object({
  /** D-14: milli-credits internally, whole credits displayed. */
  unit: z.literal('milli-credits').default('milli-credits'),
  costs: z
    .array(
      z.object({
        taskKey: z.string().min(1),
        modelKey: z.string().min(1),
        baseMilliCredits: z.number().int().nonnegative(),
        perUnitMilliCredits: z.number().int().nonnegative().default(0),
        unit: z.enum(['1k_tokens', 'image', 'second', 'character', 'request']),
      }),
    )
    .default([]),
  /** Owner decision D-15 pending: a floor of 0 disables the guard until set. */
  minimumGrossMarginPercent: z.number().min(0).max(100).default(0),
});

// --- Commerce ---------------------------------------------------------------
const plansSchema = z.object({
  plans: z
    .array(
      z.object({
        key: z.string().min(1),
        name: localizedText,
        description: localizedText,
        visibility: z.enum(['public', 'private', 'legacy']).default('private'),
        status: z.enum(['draft', 'active', 'grandfathered', 'retired']).default('draft'),
        // Prices are owner decisions (D-07). No default is invented here.
        prices: z
          .array(
            z.object({
              currency: z.string().length(3),
              monthlyMinor: z.number().int().nonnegative(),
              annualMinor: z.number().int().nonnegative(),
            }),
          )
          .default([]),
        trialDays: z.number().int().nonnegative().default(0),
        monthlyCredits: z.number().int().nonnegative().default(0),
        sortOrder: z.number().int().default(0),
      }),
    )
    .default([]),
});

const entitlementsSchema = z.object({
  features: z
    .array(
      z.object({
        key: z.string().min(1),
        name: localizedText,
        valueType: z.enum(['boolean', 'quota', 'enum']),
        defaultValue: z.union([z.boolean(), z.number(), z.string(), z.null()]).default(null),
        dependsOn: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  planEntitlements: z
    .array(
      z.object({
        planKey: z.string().min(1),
        featureKey: z.string().min(1),
        enabled: z.boolean(),
        limitValue: z.number().int().nullable().default(null),
        limitPeriod: z.enum(['day', 'month', 'billing_cycle', 'total']).nullable().default(null),
      }),
    )
    .default([]),
});

const featureFlagsSchema = z.object({
  flags: z
    .array(
      z.object({
        featureKey: z.string().min(1),
        /** Kill switch wins over every other rule. */
        killSwitch: z.boolean().default(false),
        globalEnabled: z.boolean().nullable().default(null),
        enabledForPlans: z.array(z.string()).default([]),
        enabledForWorkspaces: z.array(z.string().uuid()).default([]),
        disabledForWorkspaces: z.array(z.string().uuid()).default([]),
        betaGroups: z.array(z.string()).default([]),
        countries: z.array(z.string().length(2)).default([]),
        activeFrom: z.string().datetime().nullable().default(null),
        activeUntil: z.string().datetime().nullable().default(null),
        percentageRollout: z.number().int().min(0).max(100).nullable().default(null),
      }),
    )
    .default([]),
});

const usageLimitsSchema = z.object({
  limits: z
    .array(
      z.object({
        key: z.string().min(1),
        scope: z.enum(['ip', 'user', 'workspace', 'endpoint_class', 'provider', 'platform']),
        windowSeconds: z.number().int().positive(),
        maxRequests: z.number().int().positive(),
      }),
    )
    .default([]),
});

// --- Integrations -----------------------------------------------------------
function providerIntegrationSchema() {
  return z.object({
    activeProviderKey: z.string().nullable().default(null),
    providers: z
      .array(
        z.object({
          key: z.string().min(1),
          name: z.string().min(1),
          status: z.enum(['draft', 'validated', 'active', 'disabled']).default('draft'),
          settings: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .default({}),
          /** Every credential is a reference. A value here would be a defect. */
          secretRefs: z.record(z.string(), z.string()).default({}),
        }),
      )
      .default([]),
  });
}

const socialAppsSchema = z.object({
  applications: z
    .array(
      z.object({
        providerKey: z.enum(['facebook', 'instagram', 'tiktok', 'linkedin', 'youtube', 'x']),
        appId: z.string().min(1),
        redirectUri: z.string().url(),
        scopes: z.array(z.string()).default([]),
        clientSecretRef: z.string().min(1).nullable().default(null),
        webhookSecretRef: z.string().min(1).nullable().default(null),
        status: z.enum(['draft', 'validated', 'active', 'disabled']).default('draft'),
      }),
    )
    .default([]),
});

// --- Messaging, website, operations ----------------------------------------
const templatesSchema = z.object({
  templates: z
    .array(
      z.object({
        key: z.string().min(1),
        channel: z.enum(['email', 'in_app', 'sms', 'whatsapp', 'push']),
        subject: localizedText,
        body: localizedText,
        status: z.enum(['draft', 'active']).default('draft'),
      }),
    )
    .default([]),
});

const websiteSchema = z.object({
  siteName: localizedText.default({ ar: 'براندسبيس', en: 'BrandSpace' }),
  defaultLocale: z.enum(['ar', 'en']).default('ar'),
  announcement: localizedText.nullable().default(null),
  pages: z
    .array(
      z.object({
        slug: z.string().min(1),
        title: localizedText,
        published: z.boolean().default(false),
      }),
    )
    .default([]),
});

const operationsSchema = z.object({
  maintenanceMode: z
    .object({
      enabled: z.boolean().default(false),
      message: localizedText.nullable().default(null),
      allowPlatformAdmin: z.boolean().default(true),
    })
    .default({ enabled: false, message: null, allowPlatformAdmin: true }),
  supportModeTtlMinutes: z.number().int().positive().max(480).default(60),
  trialDefaultDays: z.number().int().nonnegative().default(14),
  supportedCurrencies: z.array(z.string().length(3)).default(['SAR', 'USD']),
});

// --- Registry ---------------------------------------------------------------

export const CONFIG_DOMAINS = {
  'ai.providers': { schema: aiProvidersSchema, schemaVersion: 1 },
  'ai.models': { schema: aiModelsSchema, schemaVersion: 1 },
  'ai.model-capabilities': { schema: aiModelCapabilitiesSchema, schemaVersion: 1 },
  'ai.routing': { schema: aiRoutingSchema, schemaVersion: 1 },
  'ai.credit-rules': { schema: aiCreditRulesSchema, schemaVersion: 1 },
  plans: { schema: plansSchema, schemaVersion: 1 },
  entitlements: { schema: entitlementsSchema, schemaVersion: 1 },
  'feature-flags': { schema: featureFlagsSchema, schemaVersion: 1 },
  'usage-limits': { schema: usageLimitsSchema, schemaVersion: 1 },
  'integrations.email': { schema: providerIntegrationSchema(), schemaVersion: 1 },
  'integrations.storage': { schema: providerIntegrationSchema(), schemaVersion: 1 },
  'integrations.payment': { schema: providerIntegrationSchema(), schemaVersion: 1 },
  'integrations.observability': { schema: providerIntegrationSchema(), schemaVersion: 1 },
  'integrations.social-apps': { schema: socialAppsSchema, schemaVersion: 1 },
  templates: { schema: templatesSchema, schemaVersion: 1 },
  website: { schema: websiteSchema, schemaVersion: 1 },
  operations: { schema: operationsSchema, schemaVersion: 1 },
} as const;

export type ConfigDomain = keyof typeof CONFIG_DOMAINS;
export type ConfigPayload<D extends ConfigDomain> = z.infer<(typeof CONFIG_DOMAINS)[D]['schema']>;

export const CONFIG_DOMAIN_KEYS = Object.keys(CONFIG_DOMAINS) as ConfigDomain[];

export function isConfigDomain(value: string): value is ConfigDomain {
  return value in CONFIG_DOMAINS;
}

/** The empty-but-valid document a brand new domain starts from. */
export function defaultPayload<D extends ConfigDomain>(domain: D): ConfigPayload<D> {
  return CONFIG_DOMAINS[domain].schema.parse({}) as ConfigPayload<D>;
}
