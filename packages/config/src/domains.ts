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

        /*
         * D-13 ELIGIBILITY GATES (approved 2026-09-13).
         *
         * The owner approved the provider ARCHITECTURE — one primary plus one
         * fallback per modality — and deferred vendor selection until each of
         * these is confirmed. They are recorded per provider so the decision is
         * evidenced by configuration rather than by somebody's memory, and
         * `validateConfiguration` refuses to activate a provider that has not
         * cleared them.
         */

        /** Confirmed: this provider does not train on our customers' data. */
        noTrainingGuarantee: z.boolean(),
        /**
         * The provider's retention terms, as verified in the privacy review.
         *
         * `unverified` is the honest default for a provider nobody has reviewed
         * yet, and an active provider may not sit in it. `zero_retention` and
         * `limited_retention` are the two D-13 accepts ("zero-retention or an
         * acceptable equivalent"); `retains_data` records a provider that was
         * reviewed and failed, so the finding is not lost.
         */
        dataRetentionPolicy: z
          .enum(['unverified', 'zero_retention', 'limited_retention', 'retains_data'])
          .default('unverified'),
        /**
         * Where the privacy and data-processing review is written down (a DPA
         * reference, a ticket, a document id). Free text, never a credential.
         */
        privacyReviewRef: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

/**
 * The unit a provider prices by — docs/AI-GATEWAY.md §4.
 *
 * Shared with `ai.credit-rules` so a model's cost basis and the credit rule
 * that prices it are expressed in the same currency of measurement.
 */
const aiBillingUnit = z.enum(['1k_tokens', 'image', 'second', 'character', 'request']);

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

        /*
         * COST BASIS — the inputs to margin (§4, §7.2).
         *
         * WHY MICRO-MINOR AND NOT MINOR. docs/AI-GATEWAY.md names these
         * `inputCostPerUnitMinor`, but a minor unit cannot express what
         * providers actually charge. A text model at $0.15 per million input
         * tokens is 0.015 of a cent per thousand tokens; as an integer count
         * of cents that is zero, so every request would record a provider cost
         * of nothing and margin reporting would show infinite margin on every
         * row. One micro-minor is a millionth of a minor unit, which holds that
         * price exactly as the integer 15000.
         *
         * `null` until an operator enters real numbers. No price is invented
         * here: provider rates are commercial facts, and a plausible-looking
         * default would be indistinguishable from a real one on the margin
         * screen.
         */
        inputCostPerUnitMicroMinor: z.number().int().nonnegative().nullable().default(null),
        outputCostPerUnitMicroMinor: z.number().int().nonnegative().nullable().default(null),
        costUnit: aiBillingUnit.default('1k_tokens'),
        costCurrency: z.string().length(3).default('USD'),

        /*
         * D-17 QUALITY GATE (approved 2026-09-13).
         *
         * "No provider/model may be enabled for production customer routing
         * until it passes a documented side-by-side Arabic marketing-content
         * benchmark." Where that benchmark is recorded — a report id, a
         * document reference — goes here, and a model may not reach
         * `available` without it. See docs/AI-QUALITY-BENCHMARK.md.
         *
         * `beta` deliberately does NOT require it: beta is the status a model
         * sits in WHILE it is being evaluated. The gate is between beta and
         * general availability, which is where customer traffic actually
         * arrives.
         */
        qualityBenchmarkRef: z.string().nullable().default(null),
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

/**
 * Per-request generation parameters — docs/AI-GATEWAY.md §5.2.
 *
 * These belong to the ROUTING RULE and not to the calling code. A caller asks
 * for `caption.generate`; how long the answer may be and how adventurous it is
 * are operator decisions that must be tunable without a deploy.
 */
const aiRoutingParametersSchema = z.object({
  temperature: z.number().min(0).max(2).default(0.7),
  maxOutputTokens: z.number().int().positive().max(200_000).default(800),
  promptTemplateVersion: z.number().int().positive().default(1),
  /*
   * Keep the model's output on the request row so an idempotent replay can
   * return it (docs/AI-GATEWAY.md §7.4 guarantee 2).
   *
   * OFF by default, and the approved output-persistence policy (2026-09-13)
   * keeps it that way: raw prompts and raw provider responses are never
   * persisted, and a user-facing result is kept only when the calling product
   * feature explicitly requires it. The feature that asks for persistence owns
   * the artifact — the gateway must not become a permanent content store.
   */
  persistOutput: z.boolean().default(false),
  /*
   * How long a persisted output may live, in days.
   *
   * The policy requires a DEFINED retention and deletion policy for anything
   * persisted, so this is not optional: validation refuses `persistOutput`
   * without it. `purgeExpiredOutputs` clears the payload past this age and
   * leaves the operational metadata — usage, cost, credits, idempotency,
   * audit — which the policy requires be retained.
   */
  outputRetentionDays: z.number().int().positive().max(3650).nullable().default(null),
});

/**
 * Retry policy — docs/AI-GATEWAY.md §5.2.
 *
 * `retryOn` is deliberately absent. Which classes may be retried is derived
 * from the failure taxonomy in `@brandspace/ai-gateway`, not from a list an
 * operator can widen: making `content_filtered` retryable from a config screen
 * would turn a moderation refusal into a paid retry loop.
 */
const aiRoutingRetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5).default(3),
  backoff: z.enum(['none', 'fixed', 'exponential']).default('exponential'),
  initialDelayMs: z.number().int().nonnegative().max(60_000).default(250),
  jitter: z.boolean().default(true),
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
        parameters: aiRoutingParametersSchema.default({}),
        retryPolicy: aiRoutingRetrySchema.default({}),
        /*
         * Input moderation — docs/AI-GATEWAY.md §6 and §10.1.
         *
         * OFF by default and with no model named, because moderation is only
         * meaningful once an operator has chosen a moderation model, and a
         * check that silently passes everything is worse than none: it looks
         * like a control and is not one. Enabling it without naming a model is
         * refused at activation rather than degrading quietly at runtime.
         */
        moderateInput: z.boolean().default(false),
        moderationModelKey: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

/**
 * Budgets and limits — docs/AI-GATEWAY.md §8.
 *
 * `null` is "no ceiling" everywhere, and every field defaults to null: a
 * budget nobody set must not quietly refuse a customer's request, and a number
 * invented here would be a commercial decision made in source (CLAUDE.md §2.2).
 */
const aiBudgetLimitsSchema = z.object({
  creditsPerDayMilli: z.number().int().nonnegative().nullable().default(null),
  creditsPerMonthMilli: z.number().int().nonnegative().nullable().default(null),
  maxConcurrentRequests: z.number().int().positive().max(10_000).nullable().default(null),
});

const aiBudgetsSchema = z.object({
  defaults: aiBudgetLimitsSchema.default({}),
  /**
   * Per-plan ceilings. A plan overrides a default FIELD BY FIELD, so raising
   * only the daily credit ceiling does not silently make concurrency
   * unlimited.
   */
  perPlan: z.array(aiBudgetLimitsSchema.extend({ planKey: z.string().min(1) })).default([]),
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
        unit: aiBillingUnit,
      }),
    )
    .default([]),
  /*
   * TWO MARGIN NUMBERS, AND THEY ARE NOT THE SAME THING (D-15, approved
   * 2026-09-13 at 65%).
   *
   * `targetGrossMarginPercent` is what pricing AIMS FOR. It drives the
   * derivation `customer price = provider cost / (1 - target)`, which is how a
   * credit price is calibrated from a measured provider cost.
   *
   * `minimumGrossMarginPercent` is the FLOOR below which a configuration change
   * is flagged. A target of 65 with a floor somewhere beneath it is the normal
   * shape: the target is where you price, the floor is where you are warned.
   *
   * Both default to unset. The approved 65% is an internal commercial target,
   * not a hard-coded markup — CLAUDE.md §2.2 — so it is entered in
   * configuration and versioned there, and no number is invented in source.
   */
  targetGrossMarginPercent: z.number().min(0).max(99.99).nullable().default(null),
  /** A floor of 0 disables the guard until an operator sets one. */
  minimumGrossMarginPercent: z.number().min(0).max(100).default(0),
  /*
   * What one whole credit is worth, in micro-minor units of the reference
   * currency. Margin cannot be computed without it: revenue is denominated in
   * credits and cost in money, and nothing else in the system converts between
   * them.
   *
   * `null`, and deliberately so — the price of a credit is an owner commercial
   * decision (D-15/D-16), not something to infer from a plan price. While it is
   * null the margin guard reports that margin is UNKNOWN rather than passing a
   * change it cannot actually check.
   */
  creditValueMicroMinor: z.number().int().positive().nullable().default(null),
  referenceCurrency: z.string().length(3).default('USD'),
});

// --- Commerce ---------------------------------------------------------------

/**
 * The six quota dimensions a plan carries (AC-04.2, docs/PRODUCT.md §10A.3).
 *
 * The KEYS are code — application code asks `entitlements.limit(ws, 'limit.seats')`
 * the same way docs/ADMIN-CONTROL-CENTER.md §5.1 has it ask
 * `entitlements.can(workspace, 'ai.image_generation')`. The VALUES are
 * configuration and appear nowhere in source, which is what AC-04.3 forbids.
 *
 * `null` means unlimited/negotiated — Enterprise, whose numbers are agreed per
 * contract rather than published.
 */
const planQuotasSchema = z.object({
  seats: z.number().int().positive().nullable().default(null),
  brands: z.number().int().positive().nullable().default(null),
  socialAccounts: z.number().int().positive().nullable().default(null),
  scheduledPostsPerMonth: z.number().int().positive().nullable().default(null),
  storageGb: z.number().int().positive().nullable().default(null),
  analyticsRetentionDays: z.number().int().positive().nullable().default(null),
});

const plansSchema = z.object({
  plans: z
    .array(
      z.object({
        key: z.string().min(1),
        name: localizedText,
        description: localizedText,
        /** Ordinal tier. Upgrade/downgrade direction is derived from it. */
        tier: z.number().int().nonnegative().default(0),
        badge: localizedText.nullable().default(null),
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
        taxBehavior: z.enum(['inclusive', 'exclusive']).default('exclusive'),
        trialDays: z.number().int().nonnegative().default(0),
        /** D-09 approved a card-free trial; the field keeps it configurable. */
        trialRequiresCard: z.boolean().default(false),
        trialCredits: z.number().int().nonnegative().default(0),
        monthlyCredits: z.number().int().nonnegative().default(0),
        /**
         * D-12: monthly plan credits roll over up to ONE monthly allowance.
         * `capped` with a multiplier of 1 expresses exactly that, and the shape
         * still admits `none` and `full` without a schema change.
         */
        creditRollover: z
          .object({
            policy: z.enum(['none', 'capped', 'full']).default('none'),
            capMultiplier: z.number().min(0).max(12).default(0),
          })
          .default({ policy: 'none', capMultiplier: 0 }),
        quotas: planQuotasSchema.default({}),
        addOns: z
          .array(
            z.object({
              key: z.string().min(1),
              name: localizedText,
              kind: z.enum(['seats', 'brands', 'social_accounts', 'storage_gb', 'credits']),
              /** Units added per unit purchased. */
              unitAmount: z.number().int().positive(),
              prices: z
                .array(
                  z.object({
                    currency: z.string().length(3),
                    monthlyMinor: z.number().int().nonnegative(),
                  }),
                )
                .default([]),
            }),
          )
          .default([]),
        /**
         * D-11: the MVP is `block` on every plan — a hard stop at zero with
         * prepaid top-ups and NO postpaid overage. The other modes stay in the
         * schema because the decision is reversible after launch, but
         * `validatePlans` refuses them while the credit policy says hard-stop.
         */
        overagePolicy: z
          .object({
            mode: z.enum(['block', 'charge', 'charge_capped']).default('block'),
            pricePerCreditMinor: z.number().int().nonnegative().default(0),
            capCredits: z.number().int().nonnegative().nullable().default(null),
          })
          .default({ mode: 'block', pricePerCreditMinor: 0, capCredits: null }),
        upgradeBehavior: z
          .object({
            timing: z.enum(['immediate', 'period_end']).default('immediate'),
            prorate: z.boolean().default(true),
            creditGrant: z.enum(['full', 'prorated', 'none']).default('prorated'),
          })
          .default({ timing: 'immediate', prorate: true, creditGrant: 'prorated' }),
        /**
         * D-12: a downgrade NEVER deletes a customer resource. `read_only` is
         * the only value `validatePlans` accepts for `excessResources`; the
         * union exists so a future decision is a configuration change rather
         * than a migration, not so this one can be bypassed.
         */
        downgradeBehavior: z
          .object({
            timing: z.enum(['immediate', 'period_end']).default('period_end'),
            excessResources: z.enum(['read_only', 'archive']).default('read_only'),
            excessCredits: z
              .enum(['retain_until_expiry', 'forfeit'])
              .default('retain_until_expiry'),
          })
          .default({
            timing: 'period_end',
            excessResources: 'read_only',
            excessCredits: 'retain_until_expiry',
          }),
        sortOrder: z.number().int().default(0),
      }),
    )
    .default([]),
});

/**
 * Credit POLICY — the rules D-11 and D-12 approved, as configuration.
 *
 * Separate from `ai.credit-rules`, which prices AI TASKS. Nothing here is
 * AI-specific: expiry, rollover and thresholds govern the wallet whether or not
 * a provider ever exists.
 */
const creditPolicySchema = z.object({
  /** D-11. `false` would be postpaid overage, which the MVP does not implement. */
  hardStopAtZero: z.boolean().default(true),
  /** D-12. 0 disables expiry for that source. */
  purchasedPackExpiryMonths: z.number().int().nonnegative().max(120).default(0),
  promotionalExpiryMonths: z.number().int().nonnegative().max(120).default(0),
  planGrantExpiryMonths: z.number().int().nonnegative().max(120).default(0),
  /** D-12: soonest-expiring credits are consumed first. */
  consumptionOrder: z.literal('fifo_by_expiry').default('fifo_by_expiry'),
  /** Percentages of the monthly allowance. Default 20% and 5% per §12. */
  lowBalanceThresholdPercents: z.array(z.number().int().min(0).max(100)).default([]),
  /** How long an unconfirmed reservation may live before the sweeper releases it. */
  reservationTimeoutSeconds: z.number().int().positive().max(86_400).default(900),
});

/** Named beta cohorts. Membership is a tenant-owned database row, not config. */
const betaCohortsSchema = z.object({
  cohorts: z
    .array(
      z.object({
        key: z.string().min(1),
        name: localizedText,
        description: localizedText,
        status: z.enum(['draft', 'active', 'closed']).default('draft'),
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
        /** Grouping for the registry screen only; it decides nothing. */
        category: z.string().default('general'),
        valueType: z.enum(['boolean', 'quota', 'enum']),
        defaultValue: z.union([z.boolean(), z.number(), z.string(), z.null()]).default(null),
        /** Allowed values when `valueType` is `enum`. */
        enumValues: z.array(z.string()).default([]),
        dependsOn: z.array(z.string()).default([]),
        status: z.enum(['active', 'deprecated']).default('active'),
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
        /** For `enum` features — e.g. analytics depth basic/full/advanced. */
        enumValue: z.string().nullable().default(null),
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
  // schemaVersion 2 adds the D-13 eligibility gates a provider must clear
  // before it can be activated.
  'ai.providers': { schema: aiProvidersSchema, schemaVersion: 2 },
  // schemaVersion 3 adds the cost basis each model is priced from and the
  // D-17 Arabic-benchmark reference it needs before general availability.
  'ai.models': { schema: aiModelsSchema, schemaVersion: 3 },
  'ai.model-capabilities': { schema: aiModelCapabilitiesSchema, schemaVersion: 1 },
  // schemaVersion 3 adds `parameters`, `retryPolicy`, moderation and the
  // output-retention window. All carry defaults, so an earlier payload still
  // parses; the bump records that new drafts are written against the wider
  // shape.
  'ai.routing': { schema: aiRoutingSchema, schemaVersion: 3 },
  // schemaVersion 3 adds the credit-to-currency reference margin needs and the
  // D-15 target gross margin that credit prices are derived from.
  'ai.credit-rules': { schema: aiCreditRulesSchema, schemaVersion: 3 },
  'ai.budgets': { schema: aiBudgetsSchema, schemaVersion: 1 },
  plans: { schema: plansSchema, schemaVersion: 1 },
  entitlements: { schema: entitlementsSchema, schemaVersion: 1 },
  'feature-flags': { schema: featureFlagsSchema, schemaVersion: 1 },
  credits: { schema: creditPolicySchema, schemaVersion: 1 },
  'beta-cohorts': { schema: betaCohortsSchema, schemaVersion: 1 },
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
