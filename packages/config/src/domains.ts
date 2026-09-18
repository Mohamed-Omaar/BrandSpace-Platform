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

// --- Brand Brain ------------------------------------------------------------

/**
 * AI Content Studio policy (Phase 5B-2).
 *
 * CLAUDE.md §2.2 again, and this domain carries two decisions the owner made
 * explicitly, both of which had to land in CONFIGURATION rather than in code:
 *
 *   D-115 — the Arabic dialects the product supports and which one a workspace
 *   that has configured none writes in. An enum in the schema would have made
 *   "add Emirati" a migration, and — the part the decision is emphatic about —
 *   would have forced a first value, quietly making some dialect the platform
 *   default. The default ships as `msa`, which is the form every Arabic reader
 *   can read, and NO dialect is privileged in source.
 *
 *   D-116/D-117 — the post-cancellation grace window. How long a cancelled
 *   workspace's drafts survive is a commercial promise an owner should be able
 *   to change without a release.
 *
 * WHAT IS DELIBERATELY NOT HERE: the credit PRICE of a generation. That is
 * `ai.credit-rules` and it stays there — one price, one place. And the system
 * instruction that keeps generation grounded is not here either, for the same
 * reason Brand Brain's is not: it is the safety contract of the feature, and an
 * operator able to edit "never invent a statistic" out of it from an admin
 * screen could turn a grounded writer into an ungrounded one without a review.
 */
const contentStudioSchema = z.object({
  dialects: z
    .object({
      /**
       * The dialect a workspace that has configured none writes in.
       *
       * MSA by owner decision (D-115). It must be a member of `supported`,
       * which the refinement below enforces rather than trusts.
       */
      defaultKey: z.string().min(1).default('msa'),
      /**
       * The dialects an operator may offer. `labelKey` is a TRANSLATION KEY,
       * never a display string: CLAUDE.md §4 forbids user-facing copy in
       * configuration as firmly as in components, and a dialect named here in
       * English would appear untranslated in an Arabic interface.
       */
      supported: z
        .array(
          z.object({
            key: z
              .string()
              .min(1)
              .regex(/^[a-z0-9-]+$/, 'A dialect key is lowercase letters, digits and hyphens.'),
            labelKey: z.string().min(1),
            /** BCP-47, for `lang` attributes and locale-aware formatting. */
            bcp47: z.string().min(2),
          }),
        )
        .min(1)
        .default([
          { key: 'msa', labelKey: 'content.dialect.msa', bcp47: 'ar' },
          { key: 'gulf', labelKey: 'content.dialect.gulf', bcp47: 'ar-SA' },
          { key: 'egyptian', labelKey: 'content.dialect.egyptian', bcp47: 'ar-EG' },
          { key: 'levantine', labelKey: 'content.dialect.levantine', bcp47: 'ar-LB' },
        ]),
    })
    .default({})
    .refine((value) => value.supported.some((d) => d.key === value.defaultKey), {
      message: 'The default dialect must be one of the supported dialects.',
      path: ['defaultKey'],
    }),

  /**
   * The platforms a variant may be written for, with the limits that decide
   * whether a caption VALIDATES.
   *
   * Character limits are configuration because platforms change them and a
   * release should not be what tracks that. Phase 6 adds real connections; this
   * phase only needs to know what a caption must fit into.
   */
  platforms: z
    .array(
      z.object({
        key: z
          .string()
          .min(1)
          .regex(/^[a-z0-9-]+$/, 'A platform key is lowercase letters, digits and hyphens.'),
        labelKey: z.string().min(1),
        maxBodyChars: z.number().int().positive(),
        maxHashtags: z.number().int().min(0),
        allowsFirstComment: z.boolean().default(false),
        /**
         * PHASE 8 — how many media items this platform accepts on one post.
         *
         * AN OPERATOR'S FACT, like every other number beside it (CLAUDE.md
         * §2.2): platforms change their carousel limits and a product that
         * hard-coded ten would be wrong the week one of them changed. ZERO is a
         * legal value and means "this platform takes no media from us", which
         * the composer reads as "do not offer a picker here".
         *
         * THE PUBLISHING POLICY HAS ITS OWN `maxMediaItems`, and that is the one
         * the publish preflight enforces against the provider. This one governs
         * AUTHORING, so a composer can refuse an eleventh image before the
         * author has written a caption for it.
         */
        maxMediaItems: z.number().int().min(0).max(20).default(10),
      }),
    )
    .min(1)
    .default([
      {
        key: 'instagram',
        labelKey: 'content.platform.instagram',
        maxBodyChars: 2_200,
        maxHashtags: 30,
        allowsFirstComment: true,
        maxMediaItems: 10,
      },
      {
        key: 'linkedin',
        labelKey: 'content.platform.linkedin',
        maxBodyChars: 3_000,
        maxHashtags: 10,
        allowsFirstComment: false,
        maxMediaItems: 9,
      },
      {
        key: 'x',
        labelKey: 'content.platform.x',
        maxBodyChars: 280,
        maxHashtags: 5,
        allowsFirstComment: false,
        maxMediaItems: 4,
      },
      {
        key: 'tiktok',
        labelKey: 'content.platform.tiktok',
        maxBodyChars: 2_200,
        maxHashtags: 20,
        allowsFirstComment: false,
        maxMediaItems: 1,
      },
    ]),

  generation: z
    .object({
      /** Variants one generation may produce, so one request cannot fan out. */
      maxVariantsPerRequest: z.number().int().min(1).max(20).default(4),
      /** Live drafts per brand — the same shape as the Brand Brain ceiling. */
      maxDraftsPerBrand: z.number().int().positive().default(500),
      /** Bounds on the grounding context spent, mirroring Brand Brain's. */
      maxContextItems: z.number().int().min(1).max(100).default(12),
      maxContextChunks: z.number().int().min(0).max(100).default(8),
      maxContextChars: z.number().int().min(500).max(200_000).default(12_000),
      /** Ceiling on the customer's own brief, so a prompt cannot be unbounded. */
      maxBriefChars: z.number().int().min(50).max(20_000).default(2_000),
    })
    .default({}),

  retention: z
    .object({
      /**
       * D-116. Days a cancelled workspace's content survives before the purge
       * may take it. Retention while the subscription is ACTIVE is not a number
       * here on purpose — it is "until it is not active", and expressing that as
       * a very large integer would be a number somebody eventually trims.
       */
      cancellationGraceDays: z.number().int().min(1).max(365).default(30),
      /**
       * D-117. The shortest window a customer may choose. A floor exists so the
       * control cannot be set to something that deletes work before the person
       * who generated it has come back from lunch.
       */
      minCustomerRetentionDays: z.number().int().min(1).max(365).default(7),
    })
    .default({}),

  /**
   * The Content Calendar — Phase 5B-2's planning half.
   *
   * EVERY VALUE HERE IS AN OPERATOR'S FACT, not a developer's. Which day a week
   * starts on differs by market before it differs by locale; how far ahead a
   * post may be planned is a product decision; and whether an item must be
   * approved before it can be scheduled is a policy the owner turns on when the
   * Approvals module ships. Hard-coding any of them would be CLAUDE.md §2.2
   * exactly.
   */
  calendar: z
    .object({
      /**
       * 0 = Sunday … 6 = Saturday. Defaults to SUNDAY because the platform's
       * first market runs a Sunday–Thursday week, and because a calendar whose
       * week starts on the wrong day is wrong in a way people notice
       * immediately. It is configuration precisely so the next market can
       * differ without a release.
       */
      weekStartsOn: z.number().int().min(0).max(6).default(0),
      /**
       * How far ahead a slot may be placed. A ceiling rather than none, because
       * an unbounded date is how a typo puts a post in the year 20260.
       */
      maxDaysAhead: z.number().int().min(1).max(3_650).default(365),
      /**
       * The shortest notice a slot may be given, in minutes. Zero would allow
       * scheduling something for a moment already past by the time the request
       * lands, which is not a plan.
       */
      minLeadMinutes: z.number().int().min(0).max(10_080).default(5),
      /** A bound on one day's plan, so the grid stays a grid. */
      maxSlotsPerDay: z.number().int().min(1).max(200).default(25),
      /**
       * AC-14.6. When true, only an APPROVED item may be scheduled.
       *
       * DEFAULT FALSE, and that is honesty rather than laxity: the Approvals
       * module is Phase 5B-3, so until it ships nothing can move an item into
       * `APPROVED` and a default of `true` would make the calendar unusable
       * while appearing to enforce a policy nobody can satisfy. The GATE is
       * built and tested now; the owner turns it on when there is a workflow
       * behind it.
       */
      requireApprovalBeforeScheduling: z.boolean().default(false),
    })
    .default({}),

  /**
   * Phase 5B-3 — the WORKSPACE-WIDE DEFAULTS for the approval workflow. A brand
   * may depart from any of them through `approval_policy`; a brand with no row
   * uses these, so changing one still reaches every brand that never chose
   * otherwise.
   */
  approvals: z
    .object({
      /**
       * AC-14.6, and the default form of the gate D-120 shipped OFF because
       * nothing could grant approval yet. The workflow now exists, so the gate
       * is switchable per brand — but the platform-wide default stays FALSE:
       * turning review on for every existing workspace at once would strand
       * every draft already in flight behind a queue nobody asked for.
       */
      requireApprovalBeforeScheduling: z.boolean().default(false),
      /**
       * D-122. Whether a member holding `content.approve` may approve content
       * they themselves authored.
       *
       * DEFAULT DENY, because an approval record whose approver is its author
       * is not evidence of a second pair of eyes. It is a DEFAULT rather than a
       * law: a one-person workspace would otherwise be unable to move its own
       * content past review at all, which turns a safety property into a
       * deadlock. The owner relaxes it deliberately, per brand, and the choice
       * is snapshotted onto every approval it affects.
       */
      allowSelfApproval: z.boolean().default(false),
      /**
       * RESERVED AND INERT — D-62 supersedes D-121 for the MVP.
       *
       * `z.literal(false)` rather than `z.boolean()`: Viewer (read-only) is
       * strictly read-only, so there is no configuration in which this may be
       * true, and a configuration version that tried to activate it is
       * REFUSED at validation rather than activated and then ignored. Nothing
       * reads it to authorize anything in any case — `mayApproveForBrand` is
       * `content.approve` and nothing else.
       *
       * Kept in the schema because a future External Review / Guest Approval
       * capability is expected to want a switch of this shape, as its own
       * narrow actor rather than a repurposing of `client_viewer`.
       */
      clientApprovalEnabled: z.literal(false).default(false),
      /** A bound on the free-text note a requester or reviewer may attach. */
      maxNoteLength: z.number().int().min(40).max(4_000).default(1_000),
      /** How many review cycles one item may go through before it is stuck. */
      maxCyclesPerItem: z.number().int().min(1).max(100).default(25),
    })
    .default({}),
});

/**
 * Brand Brain operational policy (Phase 5).
 *
 * CLAUDE.md §2.2: none of this may be hard-coded. What a customer may upload,
 * how long knowledge stays fresh, how long a persisted chat answer is kept
 * (D-78) and how text is chunked are all OPERATIONAL settings the owner tunes
 * without a release.
 *
 * WHAT IS DELIBERATELY NOT HERE: the per-area completion requirements. Those
 * are a PRODUCT definition of what "complete" means, and a tenant- or
 * plan-tunable version of them would make the same badge mean different things
 * to different customers. They live in `packages/brand-brain/src/areas.ts`.
 */
const brandBrainSchema = z.object({
  upload: z
    .object({
      /**
       * Accepted media types. A list rather than a wildcard: extraction has to
       * KNOW a format to read it, and admitting one it cannot parse produces a
       * document that sits in FAILED forever.
       *
       * IMAGES ARE NOT ON THIS LIST, and that is a decision rather than an
       * omission (D-93). The only way to get text out of a PNG or a JPEG is
       * OCR, and no OCR option clears the bar this feature sets: the maintained
       * JavaScript engine fetches its language model over the network at run
       * time, its output is not reproducible across versions — which D-65
       * requires, because a citation recorded today must still point at the
       * same text next year — and its Arabic accuracy is far below its Latin
       * accuracy, so a bilingual product would be quietly writing mistranscribed
       * Arabic into approved brand knowledge. Refusing the upload is the honest
       * answer until an option exists that does not have those properties.
       *
       * An operator CAN add a type here, and extraction will then refuse it at
       * ingest with a customer-safe message rather than accepting a document it
       * cannot read.
       */
      allowedMimeTypes: z
        .array(z.string().min(1))
        .default([
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'text/plain',
          'text/csv',
          'text/markdown',
        ]),
      maxFileBytes: z
        .number()
        .int()
        .positive()
        .default(25 * 1024 * 1024),
      /** Per-brand ceiling on live source documents. */
      maxDocumentsPerBrand: z.number().int().positive().default(200),
    })
    .default({}),

  ingestion: z
    .object({
      maxAttempts: z.number().int().min(1).max(10).default(3),
      /** Backoff before a failed job is retried. */
      retryBackoffSeconds: z.number().int().min(1).default(60),
      /** A job past this is stuck, and the sweep reconciles it. */
      stuckAfterSeconds: z.number().int().min(60).default(900),
      chunkTargetChars: z.number().int().min(200).max(8_000).default(1_200),
      chunkOverlapChars: z.number().int().min(0).max(2_000).default(150),
      /** Ceiling on chunks per document, so one huge upload cannot dominate. */
      maxChunksPerDocument: z.number().int().min(1).default(400),
    })
    .default({}),

  /*
   * EXTRACTION BOUNDS (Phase 5B).
   *
   * Every one of these exists because a customer upload is HOSTILE INPUT until
   * proven otherwise, and because the cost of parsing it is paid by the whole
   * platform. A PDF can declare fifty thousand pages; a 40 KB .docx can expand
   * to gigabytes; an XML part can nest until a scanner gives up. Unbounded, any
   * of those is a denial of service that one customer can aim at every other.
   *
   * They are configuration rather than constants for the usual reason: the
   * right ceiling depends on the hardware the workers run on, which is an
   * operator's fact and not a developer's (CLAUDE.md §2.2).
   */
  extraction: z
    .object({
      /** Pages read from one PDF. Pages past this are not read at all. */
      maxPages: z.number().int().min(1).max(5_000).default(300),
      /** Characters kept from one document, across every page or slide. */
      maxTextChars: z.number().int().min(1_000).default(2_000_000),
      /** Entries examined in one OOXML archive. */
      maxArchiveEntries: z.number().int().min(1).max(10_000).default(512),
      /** Total uncompressed bytes read from one archive. */
      maxArchiveBytes: z
        .number()
        .int()
        .min(1_024)
        .default(64 * 1024 * 1024),
      /**
       * Uncompressed-to-compressed ratio at which an archive is refused.
       *
       * A zip bomb IS this number: 42.zip is roughly 4,500,000:1. Real Office
       * documents sit between 2:1 and 20:1, so 200 refuses the attack with a
       * wide margin above anything legitimate.
       */
      maxCompressionRatio: z.number().int().min(2).max(10_000).default(200),
      /** Wall-clock ceiling on extracting one document. */
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(10 * 60_000)
        .default(60_000),
    })
    .default({}),

  knowledge: z
    .object({
      /** How long an ACTIVE item stays fresh before it is marked STALE. */
      reviewIntervalDays: z.number().int().min(1).default(180),
      /** Candidates below this confidence are never auto-surfaced as ready. */
      minimumCandidateConfidenceMilli: z.number().int().min(0).max(1000).default(400),
    })
    .default({}),

  chat: z
    .object({
      /**
       * D-78 RETENTION. Brand Brain chat is the first feature that persists
       * customer-visible AI output, so it owns the artifact and must declare
       * how long it keeps it. There is no "forever": the value is bounded, and
       * `purgeExpiredChatContent` clears bodies past it while leaving the
       * accounting intact.
       */
      retentionDays: z.number().int().min(1).max(3650).default(90),
      /** Retrieved knowledge items allowed into one answer context. */
      maxContextItems: z.number().int().min(1).max(100).default(12),
      /** Retrieved document chunks allowed into one answer context. */
      maxContextChunks: z.number().int().min(0).max(100).default(8),
      /** Total characters of grounding text. A context window is finite. */
      maxContextChars: z.number().int().min(500).default(12_000),
    })
    .default({}),
});

// --- Asset Library ----------------------------------------------------------

/**
 * The largest file size the schema can record: PostgreSQL `integer`.
 *
 * Named rather than inlined so the reason travels with the number. Raising it
 * is a MIGRATION — `asset.sizeBytes` and `asset_upload_session.declaredSizeBytes`
 * would both have to become `bigint` — not a configuration change.
 */
const MAX_STORED_FILE_BYTES = 2_147_483_647;

/**
 * Asset Library operational policy (Phase 5B-1).
 *
 * CLAUDE.md §2.2: none of this may be hard-coded. What a customer may upload,
 * how large a file may be, how many versions are kept, how long a download link
 * lives and how long a deleted object is retained are all OPERATIONAL settings
 * the owner tunes without a release — and every one of them depends on the
 * hardware and the storage vendor, which are an operator fact rather than a
 * developer one.
 *
 * WHAT IS DELIBERATELY NOT HERE. The STORAGE QUOTA. It is per-plan, it lives in
 * the `plans` document as `limit.storage_gb` (D-10), and it is resolved through
 * the entitlements engine like every other quota. Restating a ceiling here that
 * a plan already sets would be two limits for one question, and the stricter
 * one would win by accident rather than by design.
 */
const assetsSchema = z.object({
  upload: z
    .object({
      /**
       * Accepted media types, per asset kind.
       *
       * KEYED BY KIND rather than a flat list, because the kind decides what
       * the pipeline DOES: an image gets a thumbnail, a document does not, and
       * a font gets neither. A flat list would leave the mapping to be
       * re-derived in code from the MIME string, which is how a type ends up
       * accepted by the door and unhandled by the pipeline.
       *
       * IMAGES ARE ON THIS LIST, unlike `brand-brain`, and the difference is
       * the point rather than an inconsistency: D-93 refuses images as a
       * KNOWLEDGE SOURCE because the only way to get text out of one is OCR
       * and no OCR option clears that feature bar. An Asset Library does not
       * read its files — it stores, lists and serves them — so nothing about
       * D-93 applies. OCR remains unsupported and unbuilt.
       *
       * SVG IS ABSENT, and that is a decision. docs/SECURITY.md §11.5 requires
       * it to be sanitised or converted before it is ever served, because an
       * SVG is a script-bearing document. Nothing sanitises one yet, so
       * admitting it would mean storing an XSS payload the product promises to
       * neutralise and does not. An operator can add it, and the signature
       * check will still refuse a file whose bytes disagree.
       */
      allowedMimeTypes: z
        .object({
          image: z.array(z.string().min(1)).default(['image/png', 'image/jpeg', 'image/webp']),
          video: z.array(z.string().min(1)).default(['video/mp4', 'video/webm']),
          audio: z.array(z.string().min(1)).default(['audio/mpeg', 'audio/wav']),
          document: z
            .array(z.string().min(1))
            .default([
              'application/pdf',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              'text/plain',
              'text/csv',
              'text/markdown',
            ]),
          font: z.array(z.string().min(1)).default(['font/woff2', 'font/ttf']),
        })
        .default({}),

      /**
       * Size ceiling per kind. A video is legitimately larger than a font, and
       * one ceiling for both would either refuse real video or admit a font
       * nobody should be storing.
       *
       * EVERY CEILING IS CAPPED AT WHAT THE COLUMN CAN HOLD. `asset.sizeBytes`
       * and `asset_upload_session.declaredSizeBytes` are 32-bit integers, so a
       * value above 2,147,483,647 is not a generous limit — it is an upload
       * that reaches the database and fails with "value out of range", which a
       * customer sees as an unexplained error and an operator has no way to
       * connect back to the number they typed.
       *
       * Refusing it at ACTIVATION turns that into a configuration error the
       * operator sees immediately, next to the field they are editing. Found by
       * the isolation suite, which set a ceiling above the range and got the
       * opaque failure.
       */
      maxFileBytes: z
        .object({
          image: z
            .number()
            .int()
            .positive()
            .max(MAX_STORED_FILE_BYTES)
            .default(25 * 1024 * 1024),
          video: z
            .number()
            .int()
            .positive()
            .max(MAX_STORED_FILE_BYTES)
            .default(500 * 1024 * 1024),
          audio: z
            .number()
            .int()
            .positive()
            .max(MAX_STORED_FILE_BYTES)
            .default(100 * 1024 * 1024),
          document: z
            .number()
            .int()
            .positive()
            .max(MAX_STORED_FILE_BYTES)
            .default(50 * 1024 * 1024),
          font: z
            .number()
            .int()
            .positive()
            .max(MAX_STORED_FILE_BYTES)
            .default(10 * 1024 * 1024),
        })
        .default({}),

      /** Per-brand ceiling on live assets, so one brand cannot fill a plan. */
      maxAssetsPerBrand: z.number().int().positive().default(5_000),
      /**
       * How long an initiated upload session may be completed within.
       *
       * SHORT ON PURPOSE. A session is a reserved storage key and a spent
       * quota check; one that lives for hours is a way to hold both without
       * uploading anything.
       */
      sessionTtlSeconds: z
        .number()
        .int()
        .min(60)
        .max(24 * 3600)
        .default(900),
      /** Ceiling on the length of a normalised file name. */
      maxFileNameLength: z.number().int().min(16).max(512).default(180),
      /** Ceiling on tags per asset, and on the length of one tag. */
      maxTagsPerAsset: z.number().int().min(0).max(100).default(20),
      maxTagLength: z.number().int().min(1).max(128).default(48),
      /** How deep the folder tree may nest. An unbounded tree is a recursion. */
      maxFolderDepth: z.number().int().min(1).max(20).default(6),
    })
    .default({}),

  versions: z
    .object({
      /**
       * Versions kept per asset, the current one included.
       *
       * A CEILING RATHER THAN "UNLIMITED", because every version is a stored
       * object that counts against the plan quota, and a customer who
       * re-uploads a working file forty times should not silently pay for
       * forty copies.
       */
      maxVersionsPerAsset: z.number().int().min(1).max(100).default(10),
    })
    .default({}),

  derivatives: z
    .object({
      /**
       * Which derivatives are produced, and how large they may be.
       *
       * BOUNDED AND APPROVED, never open-ended. Every derivative is work one
       * customer causes and the whole platform pays for, so the set is a
       * schema fact (`AssetDerivativeKind`) and the dimensions are an
       * operator setting.
       */
      thumbnailEnabled: z.boolean().default(true),
      thumbnailMaxEdgePx: z.number().int().min(16).max(2_048).default(320),
      previewEnabled: z.boolean().default(true),
      previewMaxEdgePx: z.number().int().min(64).max(8_192).default(1_280),
      /**
       * Ceiling on derivatives per asset.
       *
       * The database already allows one row per kind, so this is the SECOND
       * bound rather than the only one. It exists so an operator can turn the
       * whole pipeline down without editing the enum, and so the ceiling is
       * assertable in a test that does not have to provoke a unique violation.
       */
      maxPerAsset: z.number().int().min(0).max(10).default(2),
      /** Wall-clock ceiling on deriving one asset. */
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(10 * 60_000)
        .default(60_000),
    })
    .default({}),

  scanning: z
    .object({
      /**
       * Whether an asset must be scanned before it may become READY.
       *
       * TRUE BY DEFAULT, and turning it off is an operator decision that must
       * be deliberate. docs/SECURITY.md §11.3 requires scanning before an
       * asset becomes usable; the switch exists because an operator with no
       * scanner configured needs a way to say so explicitly rather than having
       * every upload sit in PENDING forever with no explanation.
       */
      required: z.boolean().default(true),
      /**
       * Which scanner the platform uses.
       *
       * `mock` is the only implementation that exists, it is deterministic,
       * and it is what development and tests run against. No production
       * scanner has been approved, so naming one here would be inventing a
       * vendor decision — `resolveScanner` refuses `mock` in production, which
       * is the fail-closed behaviour CLAUDE.md §2.2 asks for.
       */
      provider: z.enum(['mock']).default('mock'),
      /** Wall-clock ceiling on scanning one asset. */
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(10 * 60_000)
        .default(30_000),
    })
    .default({}),

  processing: z
    .object({
      maxAttempts: z.number().int().min(1).max(10).default(3),
      retryBackoffSeconds: z.number().int().min(1).default(60),
      /** A job past this is stuck, and the sweep reconciles it. */
      stuckAfterSeconds: z.number().int().min(60).default(900),
    })
    .default({}),

  download: z
    .object({
      /**
       * How long a signed download grant lives.
       *
       * SHORT, because a grant is a bearer capability: anyone holding the
       * token can fetch those bytes until it expires. Long enough that a
       * library page full of thumbnails does not start 404ing while the
       * customer reads it.
       */
      grantTtlSeconds: z
        .number()
        .int()
        .min(30)
        .max(24 * 3600)
        .default(300),
    })
    .default({}),

  retention: z
    .object({
      /**
       * How long a soft-deleted asset is recoverable before its objects and
       * derivatives are purged.
       *
       * U-08 recommends a 30-day grace after cancellation, and the same
       * reasoning applies to a deletion a person may regret. There is no
       * "forever": the value is bounded, and the purge is what stops a delete
       * button from being a promise the platform does not keep.
       */
      purgeDeletedAfterDays: z.number().int().min(1).max(365).default(30),
      /** How long an expired upload session and its partial bytes are kept. */
      purgeExpiredSessionsAfterHours: z.number().int().min(1).max(720).default(24),
    })
    .default({}),
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

/**
 * Phase 6 — the PUBLISHING policy, and the half of it a customer may see.
 *
 * WHAT A PLATFORM CAN DO IS CONFIGURATION, NOT CODE (CLAUDE.md §2.2). Post
 * kinds, character ceilings, media counts, whether a first comment exists,
 * whether a post can be deleted — every one of these changes when a platform
 * changes its API, and every one of them is something the customer's own screen
 * has to state BEFORE they build something the platform will reject.
 *
 * CAPABILITIES ARE DECLARED, NEVER ASSUMED EQUAL. That is the rule
 * docs/SOCIAL-INTEGRATIONS.md §1.7 sets, and this schema is where it lives: the
 * UI is generated from these declarations, so an option a platform does not
 * support never appears rather than failing at publish time.
 *
 * NO CREDENTIAL IS IN HERE. App ids, client-secret refs and webhook-secret refs
 * stay in `integrations.social-apps`, which is not projected to tenants. What a
 * platform can do is public; what our app may do it with is not.
 */
const publishingCapabilitySchema = z.object({
  /** Whether this provider may be connected at all right now. */
  enabled: z.boolean().default(false),
  /** Post shapes the platform accepts. The composer offers exactly these. */
  postKinds: z
    .array(z.enum(['text', 'image', 'carousel', 'video', 'reel', 'story', 'article', 'thread']))
    .default(['text']),
  maxBodyCharacters: z.number().int().positive().max(100_000).default(2_200),
  maxHashtags: z.number().int().min(0).max(100).default(30),
  maxMediaItems: z.number().int().min(0).max(50).default(10),
  supportsFirstComment: z.boolean().default(false),
  supportsDelete: z.boolean().default(false),
  /**
   * Whether the platform will schedule the post itself. FALSE everywhere in
   * this phase: BrandSpace holds the schedule, so a customer sees one calendar
   * rather than one per platform.
   */
  supportsNativeScheduling: z.boolean().default(false),
  /**
   * Whether the adapter can ask "did this post land?" after an uncertain
   * outcome. Where this is false, an indeterminate attempt is NEVER retried —
   * a duplicate post is worse than a missing one (docs/SOCIAL-INTEGRATIONS.md
   * §7.2).
   */
  supportsPostLookup: z.boolean().default(false),
  /** OAuth scopes requested at connection time. */
  scopes: z.array(z.string()).default([]),
  /** What kind of thing gets connected: page, profile, channel, organization. */
  targetKind: z.string().min(1).default('profile'),
});

const publishingSchema = z.object({
  providers: z
    .object({
      facebook: publishingCapabilitySchema.default({}),
      instagram: publishingCapabilitySchema.default({}),
      tiktok: publishingCapabilitySchema.default({}),
      linkedin: publishingCapabilitySchema.default({}),
      x: publishingCapabilitySchema.default({}),
    })
    .default({}),

  oauth: z
    .object({
      /**
       * How long an authorization may stay in flight. Short on purpose: the
       * state row is a live CSRF token, and a long window is a long replay
       * window.
       */
      stateTtlSeconds: z.number().int().positive().max(3_600).default(600),
      /**
       * Connections a single workspace may hold. A ceiling rather than a plan
       * limit: the plan limit lives in `plans` and is enforced separately.
       */
      maxConnectionsPerWorkspace: z.number().int().positive().max(200).default(25),
    })
    .default({}),

  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(10).default(5),
      initialBackoffSeconds: z.number().int().positive().max(3_600).default(30),
      backoffMultiplier: z.number().min(1).max(10).default(2),
      maxBackoffSeconds: z.number().int().positive().max(86_400).default(1_800),
      /** Jitter spreads a thundering herd after a platform outage. */
      jitterRatio: z.number().min(0).max(1).default(0.2),
    })
    .default({}),

  dispatch: z
    .object({
      /**
       * How late a post may go out before we stop and ask. Beyond this the job
       * is held rather than published: a time-sensitive message posted six
       * hours late is worse than one not posted at all
       * (docs/SOCIAL-INTEGRATIONS.md §8).
       */
      latenessToleranceMinutes: z.number().int().positive().max(1_440).default(120),
      /** Slots a single reconciliation pass may claim. */
      sweepBatchSize: z.number().int().positive().max(500).default(50),
      /**
       * How long before expiry a token is refreshed. 0.75 of its lifetime, the
       * proactive refresh docs/SOCIAL-INTEGRATIONS.md §5 describes.
       */
      tokenRefreshAtLifetimeRatio: z.number().min(0.1).max(0.95).default(0.75),
      /**
       * How long a worker's claim on a job is believed (D-143).
       *
       * `execute()` moves a job to PUBLISHING BEFORE the external call, so a
       * worker that dies mid-flight leaves a row saying "we may have sent
       * this". Past this lease the claim is treated as dead and the job is
       * RECOVERED — verified where the provider can be asked, handed to a human
       * where it cannot. Never resent on the strength of a timer.
       *
       * It must comfortably exceed the slowest realistic provider call plus the
       * BullMQ lock duration; too short recovers a job a live worker still
       * holds, which is the one way this mechanism could itself cause a
       * duplicate. Fifteen minutes against a two-minute lock.
       */
      claimLeaseSeconds: z.number().int().positive().min(60).max(3_600).default(900),
      /** Stale claims examined per recovery pass. */
      staleClaimBatchSize: z.number().int().positive().max(500).default(50),
    })
    .default({}),
});

// --- Phase 7: Analytics, Copilot and Automations ----------------------------

/**
 * Analytics ingestion, presentation and retention policy (Phase 7).
 *
 * CLAUDE.md §2.2 again, and this domain is unusually dense with owner decisions
 * because almost every number in an ingestion pipeline is one: how often to ask
 * a platform, how far back to go, when a figure stops being current, how long to
 * keep it, and how large an export a customer may pull. None of it is a
 * developer's choice, and every one of them changes with the hardware, the
 * platform's own limits and the commercial promise.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 *   - THE METRIC VOCABULARY. Metric keys and their units are CODE
 *     (packages/analytics/src/metrics.ts) for the reason AI task keys are:
 *     application code asks for `engagement_rate` by name, and an operator
 *     renaming it would break the anomaly detector rather than retune it.
 *   - THE ANALYTICS RETENTION CEILING PER PLAN. `limit.analytics_retention_days`
 *     lives in `plans` (D-10) and is resolved through the entitlements engine.
 *     `retention.maxRetentionDays` here is the PLATFORM ceiling; the stricter of
 *     the two wins, and the plan is the one that varies by customer.
 *   - ANY CREDENTIAL. Analytics reads a CUSTOMER token from `social_credential`,
 *     resolved on the worker. Nothing about a credential appears in
 *     configuration, projected or otherwise.
 */
const analyticsSchema = z.object({
  ingestion: z
    .object({
      /**
       * How often a connection's recent window is refreshed, per granularity.
       *
       * Daily figures settle slowly — a platform revises yesterday's numbers for
       * hours — so asking every few minutes spends a rate limit to learn
       * nothing. Hourly figures move faster and are asked for more often.
       */
      dailyIntervalMinutes: z.number().int().min(5).max(1_440).default(180),
      hourlyIntervalMinutes: z.number().int().min(5).max(1_440).default(60),
      /**
       * The trailing window a scheduled pull re-asks for.
       *
       * NOT "since we last looked". Platforms revise recent figures for days,
       * and a cursor that only ever moved forward would freeze the first,
       * lowest reading of every day for ever. Re-asking a short trailing window
       * is what lets a revision land — and the idempotent upsert is what makes
       * re-asking free.
       */
      refreshWindowDays: z.number().int().min(1).max(30).default(3),
      /** Post subjects asked about in one provider request. */
      subjectsPerRequest: z.number().int().min(1).max(200).default(25),
      /** Cursors a single scheduling pass may claim. */
      claimBatchSize: z.number().int().min(1).max(500).default(25),
      /**
       * How long a claim on a cursor is believed.
       *
       * Past this lease the claim is treated as abandoned and another pass may
       * take it — the same mechanism, and the same hazard, as D-143's publish
       * claim: too short recovers a cursor a live worker still holds. Generous
       * against a pull measured in seconds.
       */
      claimLeaseSeconds: z.number().int().min(60).max(3_600).default(600),
      /**
       * The share of a provider's request budget that analytics may NOT spend,
       * in parts per mille. Publishing may spend it; a chart may wait.
       */
      publishingReserveMilli: z.number().int().min(0).max(900).default(250),
    })
    .default({}),

  backfill: z
    .object({
      /** Whether a newly connected account is backfilled at all. */
      enabled: z.boolean().default(true),
      /**
       * BOUNDED, and the bound matters. An unbounded backfill against a
       * platform that answers for two years is a rate limit spent for a chart
       * nobody asked for, and a bill in provider quota rather than in money.
       * The adapter's own `maxBackfillDays` narrows this further per platform.
       */
      maxDays: z.number().int().min(1).max(730).default(90),
      /** Days fetched per backfill pass, so one account cannot monopolise. */
      daysPerPass: z.number().int().min(1).max(90).default(7),
    })
    .default({}),

  freshness: z
    .object({
      /** Within this, a figure is FRESH and the screen says nothing. */
      freshWithinMinutes: z.number().int().min(5).max(10_080).default(360),
      /** Past this, a figure is STALE and every surface drawing it must say so. */
      staleAfterMinutes: z.number().int().min(15).max(43_200).default(1_440),
    })
    .default({}),

  retry: z
    .object({
      maxConsecutiveFailures: z.number().int().min(1).max(50).default(8),
      initialBackoffSeconds: z.number().int().min(1).max(3_600).default(60),
      backoffMultiplier: z.number().min(1).max(10).default(2),
      maxBackoffSeconds: z.number().int().min(60).max(86_400).default(7_200),
      /** Jitter spreads a thundering herd after a platform outage. */
      jitterRatio: z.number().min(0).max(1).default(0.2),
    })
    .default({}),

  anomaly: z
    .object({
      /**
       * How far from the baseline a value must sit before it is called
       * anomalous, in parts per mille of the baseline.
       *
       * A THRESHOLD IS NOT A MYSTERY. Every anomaly this product reports carries
       * the baseline, the window it was computed over and the observed change,
       * so a customer can disagree with it. This number is what "unusual" means,
       * and it is an owner's judgement rather than a developer's.
       */
      deviationThresholdMilli: z.number().int().min(100).max(10_000).default(500),
      /** Periods the baseline is averaged over. Fewer than this, no anomaly. */
      baselinePeriods: z.number().int().min(3).max(90).default(14),
      /**
       * Below this baseline value, no anomaly is reported at all. A post that
       * went from 2 impressions to 6 is not a 200% surge; it is noise, and
       * calling it a surge is how an insights feed becomes unreadable.
       */
      minimumBaselineValue: z.number().int().min(0).max(1_000_000).default(50),
    })
    .default({}),

  explain: z
    .object({
      /** Evidence rows allowed into one explanation's context. */
      maxEvidenceItems: z.number().int().min(1).max(200).default(24),
      /**
       * The minimum evidence an explanation may be attempted on.
       *
       * BELOW IT, NOTHING IS GENERATED AND NOTHING IS CHARGED. A model asked to
       * explain three numbers will produce a confident paragraph about three
       * numbers, and a customer cannot tell that from insight. The honest answer
       * is that there is not enough data yet, and it costs nothing to give.
       */
      minEvidenceItems: z.number().int().min(1).max(50).default(4),
      /** Days of history one explanation may range over. */
      maxWindowDays: z.number().int().min(1).max(400).default(92),
    })
    .default({}),

  export: z
    .object({
      /** The widest date range one export may cover. */
      maxWindowDays: z.number().int().min(1).max(400).default(92),
      /** The most rows one export may contain. A bound, not a promise. */
      maxRows: z.number().int().min(100).max(1_000_000).default(50_000),
    })
    .default({}),

  retention: z
    .object({
      /**
       * The PLATFORM ceiling on how long observations are kept. The PLAN's
       * `limit.analytics_retention_days` narrows it per customer, and the
       * stricter of the two wins.
       */
      maxRetentionDays: z.number().int().min(30).max(3_650).default(730),
      /** How long an ingestion RUN record is kept. Operations evidence, not data. */
      runRetentionDays: z.number().int().min(1).max(365).default(30),
      /** How long a generated insight is kept before it is purged (D-116/D-117). */
      insightRetentionDays: z.number().int().min(1).max(3_650).default(180),
      /** Rows a single pruning pass may remove. */
      pruneBatchSize: z.number().int().min(1).max(100_000).default(5_000),
    })
    .default({}),
});

/**
 * AI Copilot policy (Phase 7).
 *
 * THE CONFIRMATION REQUIREMENT IS NOT HERE, AND THAT IS THE POINT. CLAUDE.md
 * §2.5 and A-17 say the Copilot may never silently perform an external or
 * destructive action; a configuration key that could switch that off would make
 * a permanent product rule an operator setting. It is a CHECK constraint on
 * `copilot_action_plan` instead. What an operator legitimately tunes is how LONG
 * a confirmation stays valid, how large a plan may be, and how much of a
 * conversation is kept — all of which are below.
 */
const copilotSchema = z.object({
  plans: z
    .object({
      /**
       * Steps one plan may contain. A ceiling, because a plan a person cannot
       * read is a plan they cannot meaningfully confirm.
       */
      maxSteps: z.number().int().min(1).max(50).default(8),
      /**
       * How long a confirmation stays valid.
       *
       * SHORT ON PURPOSE. The token is a live authorization to change tenant
       * state, and a long window is a long replay window — the same reasoning
       * `publishing.oauth.stateTtlSeconds` carries.
       */
      confirmationTtlSeconds: z.number().int().min(30).max(3_600).default(600),
      /** How long after execution the undo path stays open. */
      undoWindowSeconds: z.number().int().min(60).max(86_400).default(3_600),
      /** Plans one member may have awaiting confirmation at once. */
      maxOpenPlansPerUser: z.number().int().min(1).max(50).default(5),
    })
    .default({}),

  conversation: z
    .object({
      /** Turns kept as context for the next turn. A context window is finite. */
      maxContextMessages: z.number().int().min(1).max(50).default(10),
      /** Total characters of grounding text allowed into one turn. */
      maxContextChars: z.number().int().min(500).max(200_000).default(16_000),
      /** The longest request a customer may send. */
      maxRequestChars: z.number().int().min(10).max(20_000).default(2_000),
      /**
       * D-116 / D-117 RETENTION. The Copilot persists what a customer asked and
       * what they were told, so it owns the artifact and must declare how long
       * it keeps it. There is no "forever".
       */
      retentionDays: z.number().int().min(1).max(3_650).default(90),
    })
    .default({}),
});

/**
 * Automation engine policy (Phase 7).
 *
 * WHAT IS DELIBERATELY NOT CONFIGURABLE: the trigger, condition and action
 * REGISTRIES. They are closed sets in code (packages/automation/src/registry.ts),
 * because a configurable action list is one migration away from an arbitrary
 * webhook, and an arbitrary webhook is customer-controlled egress from a
 * multi-tenant platform. The same reasoning keeps
 * `requiresConfirmationForExternal` out of configuration and in a CHECK
 * constraint.
 */
const automationsSchema = z.object({
  limits: z
    .object({
      /** Rules one workspace may hold. A ceiling, not a plan limit. */
      maxRulesPerWorkspace: z.number().int().min(1).max(1_000).default(50),
      maxRulesPerBrand: z.number().int().min(1).max(500).default(20),
      /** The platform ceiling on a rule's own daily run limit. */
      maxRunsPerRulePerDay: z.number().int().min(1).max(10_000).default(50),
      /** Conditions one rule may carry, so evaluation stays bounded. */
      maxConditionsPerRule: z.number().int().min(1).max(20).default(5),
    })
    .default({}),

  execution: z
    .object({
      /**
       * How long an AWAITING_CONFIRMATION run stays open before it expires.
       *
       * An external action proposed on Monday and confirmed on Friday is an
       * action nobody remembers agreeing to. Longer than the Copilot's window
       * because an automation fires without anyone watching.
       */
      confirmationTtlSeconds: z.number().int().min(300).max(604_800).default(86_400),
      /** Runs a single sweeping pass may dispatch. */
      dispatchBatchSize: z.number().int().min(1).max(500).default(50),
      /** How long a run may hold its claim before it is treated as abandoned. */
      claimLeaseSeconds: z.number().int().min(60).max(3_600).default(300),
      /** How long a completed run record is kept. */
      runRetentionDays: z.number().int().min(1).max(365).default(90),
    })
    .default({}),
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

// --- Commerce (Phase 9) ------------------------------------------------------
/*
 * THE COMMERCIAL GEOGRAPHY OF THE PRODUCT — currencies, markets, tax policies,
 * credit packs, dunning and the invoice's legal identity.
 *
 * WHY IT IS ONE DOMAIN. Every value here answers "what do we sell, where, in
 * what money, under whose tax rules" — an owner's commercial decision, not an
 * engineer's (CLAUDE.md §2.2). Splitting it would mean a plan could be sellable
 * in a market whose currency had been retired, because the two documents would
 * activate independently.
 *
 * WHAT IS DELIBERATELY ABSENT. No payment provider is named, no percentage is
 * presented as a universal tax, and NO CURRENCY IS A DEFAULT. There is no
 * `defaultCurrency` field anywhere in this schema: a workspace's currency is
 * chosen explicitly during onboarding and stored on the workspace (D-194), and
 * a field here would be exactly the silent assumption that decision removed.
 */
const commerceCurrencySchema = z.object({
  code: z.string().length(3),
  name: localizedText,
  /**
   * How many decimal digits this currency's minor unit has.
   *
   * NOT ASSUMED TO BE 2. KWD, BHD and OMR are three-digit currencies, and code
   * that assumed two would be wrong about the price in three of the seven
   * launch markets. `Money` reads this and refuses to combine amounts whose
   * scales disagree.
   */
  minorUnitDigits: z.number().int().min(0).max(4),
  status: z.enum(['active', 'inactive']).default('inactive'),
  sortOrder: z.number().int().nonnegative().default(0),
});

const commerceTaxPolicySchema = z.object({
  key: z.string().min(1),
  name: localizedText,
  /**
   * `none` — nothing is added and no tax line is written.
   * `exclusive` — tax is added on top of the subtotal.
   * `inclusive` — the price already contains the tax, which is shown separately.
   *
   * NO JURISDICTION IS NAMED and no rate is a default. A percentage in source
   * would be this file deciding a country's tax law (§32 of the Phase 9 brief),
   * and the platform sells in several.
   */
  mode: z.enum(['none', 'exclusive', 'inclusive']).default('none'),
  /** Basis points — 1500 is 15%. Integer, because a tax total is not a float. */
  rateBasisPoints: z.number().int().min(0).max(100_000).default(0),
  /** What the customer's own tax identifier is CALLED here, if one is collected. */
  taxIdLabel: localizedText.nullable().default(null),
  taxIdRequired: z.boolean().default(false),
  /** Printed on the invoice under the totals. Owner text, never generated. */
  invoiceNote: localizedText.nullable().default(null),
});

const commerceMarketSchema = z.object({
  /** ISO 3166-1 alpha-2. */
  country: z.string().length(2),
  name: localizedText,
  /**
   * The currencies a customer in this country may CHOOSE from.
   *
   * A list, never a single value: the country may narrow what is offered, but
   * it must not pick for the customer (§4 of the Phase 9 brief). An onboarding
   * screen shows these and requires an explicit selection.
   */
  currencies: z.array(z.string().length(3)).default([]),
  /**
   * Which plans are sellable here. `null` means every active plan.
   *
   * THIS IS HOW A PLAN IS AVAILABLE IN ONE MARKET AND NOT ANOTHER, and it is
   * configuration precisely so the answer is not a conditional inside a React
   * component (§33).
   */
  planKeys: z.array(z.string().min(1)).nullable().default(null),
  taxPolicyKey: z.string().min(1).nullable().default(null),
  status: z.enum(['active', 'inactive']).default('inactive'),
});

const commerceCreditPackSchema = z.object({
  key: z.string().min(1),
  name: localizedText,
  description: localizedText.nullable().default(null),
  /** Whole credits granted by one purchase. */
  credits: z.number().int().positive(),
  prices: z
    .array(
      z.object({
        currency: z.string().length(3),
        amountMinor: z.number().int().nonnegative(),
      }),
    )
    .default([]),
  /** `null` means every market. Otherwise the ISO-2 countries it is sold in. */
  countries: z.array(z.string().length(2)).nullable().default(null),
  /**
   * D-12: purchased packs expire after twelve months. Kept configurable and
   * nullable — `null` is a non-expiring pack, which the decision allows.
   */
  expiryDays: z.number().int().positive().nullable().default(365),
  status: z.enum(['draft', 'active', 'retired']).default('draft'),
  sortOrder: z.number().int().nonnegative().default(0),
});

const commerceSchema = z.object({
  currencies: z.array(commerceCurrencySchema).default([]),
  markets: z.array(commerceMarketSchema).default([]),
  taxPolicies: z.array(commerceTaxPolicySchema).default([]),
  creditPacks: z.array(commerceCreditPackSchema).default([]),

  /**
   * Which payment provider serves which market.
   *
   * The ADAPTER KEY only. Credentials live in the Secret Service and the
   * provider's own settings live in `integrations.payment`; a key here is a
   * routing decision (docs/BILLING-AND-CREDITS.md §1.1). D-204 leaves the
   * production vendor unchosen, so the only key this resolves to before Phase
   * 10 is the development adapter.
   */
  providerRouting: z
    .array(
      z.object({
        providerKey: z.string().min(1),
        countries: z.array(z.string().length(2)).nullable().default(null),
        currencies: z.array(z.string().length(3)).nullable().default(null),
        priority: z.number().int().nonnegative().default(0),
      }),
    )
    .default([]),

  checkout: z
    .object({
      /** How long a hosted session stays usable before it must be re-created. */
      sessionTtlMinutes: z.number().int().min(5).max(1_440).default(60),
      /**
       * Whether a returning browser may be shown "payment received".
       *
       * ALWAYS FALSE AND NOT MEANT TO BE CHANGED — the redirect is a navigation
       * event, not money (§22). It is a field so the refusal is visible in the
       * document an operator reads, rather than an unstated assumption.
       */
      trustBrowserRedirect: z.literal(false).default(false),
    })
    .default({}),

  dunning: z
    .object({
      /** Days after the failure on which a retry is attempted. */
      retryOffsetDays: z.array(z.number().int().min(0).max(90)).default([1, 3, 5, 7]),
      /** How long full access continues after the first failure. */
      graceDays: z.number().int().min(0).max(90).default(7),
      /** Days suspended before the subscription is cancelled outright. */
      cancelAfterSuspendedDays: z.number().int().min(1).max(365).default(30),
    })
    .default({}),

  invoice: z
    .object({
      /** Prefix for the human-readable number — `BS` gives `BS-2026-000001`. */
      numberPrefix: z.string().min(1).max(8).default('BS'),
      numberPadding: z.number().int().min(4).max(12).default(6),
      /** The seller. Owner text: the legal entity is D-05 and still open. */
      legalName: localizedText.nullable().default(null),
      address: localizedText.nullable().default(null),
      taxRegistrationNumber: z.string().min(1).nullable().default(null),
      footerNote: localizedText.nullable().default(null),
    })
    .default({}),
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

  /*
   * BACKGROUND MAINTENANCE CADENCES.
   *
   * How often the platform reconciles unclaimed work and clears content past
   * its retention window. Configuration rather than constants for the same
   * reason as every other operational number here: the right cadence depends on
   * how much traffic the platform is carrying and how many workers are running,
   * which is an operator's fact (CLAUDE.md §2.2). A retention WINDOW is a
   * privacy commitment and lives with the feature that makes it; this is only
   * how often the sweep that enforces it runs.
   */
  maintenance: z
    .object({
      /**
       * How often unclaimed ingestion jobs are re-dispatched.
       *
       * Dispatch is an optimisation and this sweep is the correctness path
       * (docs/ARCHITECTURE.md §9), so the interval is the worst-case delay
       * before a document whose queue message was lost is picked up.
       */
      ingestionReconcileSeconds: z.number().int().min(5).max(3_600).default(30),
      /** How often expired AI content is cleared. */
      retentionPurgeSeconds: z.number().int().min(60).max(86_400).default(900),
      /** Rows cleared per pass, so one sweep cannot monopolise the database. */
      retentionPurgeBatch: z.number().int().min(1).max(10_000).default(500),
      /** Ingestion jobs re-dispatched per pass, for the same reason. */
      ingestionReconcileBatch: z.number().int().min(1).max(10_000).default(200),
    })
    .default({}),
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
  // Phase 5. Upload rules, ingestion tuning, knowledge freshness and the D-78
  // chat retention window — every one an owner setting, none of them in source.
  'brand-brain': { schema: brandBrainSchema, schemaVersion: 1 },
  // Phase 5B-1. Asset Library upload rules, version and derivative ceilings,
  // scanning, the download-grant window and retention. The storage QUOTA is
  // deliberately absent: it is per-plan and lives in `plans` (D-10).
  assets: { schema: assetsSchema, schemaVersion: 1 },
  // Phase 5B-2. Supported Arabic dialects and the default (D-115), the
  // platforms a variant may target with the limits that decide validation, the
  // generation bounds, and the D-116/D-117 retention windows. It carries no
  // provider, no model, no price and no credential.
  content: { schema: contentStudioSchema, schemaVersion: 1 },
  'integrations.email': { schema: providerIntegrationSchema(), schemaVersion: 1 },
  'integrations.storage': { schema: providerIntegrationSchema(), schemaVersion: 1 },
  'integrations.payment': { schema: providerIntegrationSchema(), schemaVersion: 1 },
  'integrations.observability': { schema: providerIntegrationSchema(), schemaVersion: 1 },
  'integrations.social-apps': { schema: socialAppsSchema, schemaVersion: 1 },
  publishing: { schema: publishingSchema, schemaVersion: 1 },
  // Phase 7. Ingestion cadence, backfill bounds, freshness thresholds, anomaly
  // thresholds, export ceilings and the retention windows. It carries no metric
  // vocabulary (that is code), no plan limit (that is `plans`), no provider and
  // no credential.
  analytics: { schema: analyticsSchema, schemaVersion: 1 },
  // Phase 7. Plan ceilings, the confirmation and undo windows, and the D-116 /
  // D-117 conversation retention. The CONFIRMATION REQUIREMENT itself is not
  // here — it is a CHECK constraint, because CLAUDE.md §2.5 is a product rule
  // rather than an operator setting.
  copilot: { schema: copilotSchema, schemaVersion: 1 },
  // Phase 7. Rule and run ceilings and the confirmation window. The trigger,
  // condition and action registries are closed sets in code: a configurable
  // action list is one step from an arbitrary webhook.
  automations: { schema: automationsSchema, schemaVersion: 1 },
  templates: { schema: templatesSchema, schemaVersion: 1 },
  website: { schema: websiteSchema, schemaVersion: 1 },
  operations: { schema: operationsSchema, schemaVersion: 1 },
  // Phase 9. The commercial geography: the currency catalogue with each
  // currency's own minor-unit scale, the markets that decide which currencies
  // and plans a country is offered, tax policies, credit packs, provider
  // routing, dunning and the invoice's legal identity. It names no payment
  // provider (D-204) and carries NO default currency (D-194).
  commerce: { schema: commerceSchema, schemaVersion: 1 },
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

/**
 * Parse a stored payload against its domain schema.
 *
 * The one entrance for reading a configuration document that did not come from
 * `ConfigurationService.get` — in practice, a row from the tenant-readable
 * catalogue projection. Parsing rather than casting is what makes the schema's
 * defaults apply: a document written before a field existed comes back complete,
 * so a caller never has to supply a default of its own (CLAUDE.md §2.2).
 */
export function parseConfigPayload<D extends ConfigDomain>(
  domain: D,
  payload: unknown,
): ConfigPayload<D> {
  return CONFIG_DOMAINS[domain].schema.parse(payload ?? {}) as ConfigPayload<D>;
}
