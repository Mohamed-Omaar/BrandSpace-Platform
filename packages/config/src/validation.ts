import type { z } from 'zod';
import { systemClock } from '@brandspace/shared';
import { AI_CAPABILITY_REQUIREMENTS, CONFIG_DOMAINS, type ConfigDomain } from './domains';

/**
 * Two-stage validation — docs/ARCHITECTURE.md §7.2.
 *
 *   Stage 1 STRUCTURAL: does the document match its Zod schema?
 *   Stage 2 SEMANTIC:   is it referentially coherent? A routing rule may not
 *                       point at a disabled model; a plan entitlement may not
 *                       grant a feature that does not exist; a credit cost may
 *                       not be negative.
 *
 * Stage 2 is where most real mistakes live, and it is the reason activation
 * needs the *other* active domains as context rather than validating in
 * isolation.
 */

export interface ValidationIssue {
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly message: string;
}

export interface ValidationReport {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly checkedAt: string;
}

/** Other domains' currently-active payloads, for cross-domain checks. */
export type ConfigContext = Partial<Record<ConfigDomain, unknown>>;

interface StructuralResult {
  readonly issues: ValidationIssue[];
  /**
   * The payload with every schema default applied.
   *
   * Stage 2 runs against THIS rather than the raw document. An absent optional
   * field is `undefined` in the raw document and its default — usually `null` —
   * in the parsed one, and a semantic rule that compares against `null` would
   * otherwise fire on every document that simply omitted the field. That is not
   * hypothetical: it is exactly what made "a boolean feature takes no limit"
   * reject a plan that had never mentioned a limit at all.
   */
  readonly parsed: unknown;
}

function structural(domain: ConfigDomain, payload: unknown): StructuralResult {
  const schema = CONFIG_DOMAINS[domain].schema as z.ZodTypeAny;
  const result = schema.safeParse(payload);
  if (result.success) return { issues: [], parsed: result.data };
  return {
    issues: result.error.issues.map((issue) => ({
      severity: 'error' as const,
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
    parsed: payload,
  };
}

interface ModelLike {
  key: string;
  providerKey: string;
  status: string;
  disableSwitch?: boolean;
  inputCostPerUnitMicroMinor?: number | null;
  outputCostPerUnitMicroMinor?: number | null;
  qualityBenchmarkRef?: string | null;
  // Phase 10 — the catalogue fields a capability check reads.
  modality?: string;
  qualityTier?: string;
  capabilities?: string[];
  supportsVision?: boolean;
  supportsStructuredOutput?: boolean;
  supportsToolUse?: boolean;
  supportsAudioInput?: boolean;
  supportsAudioOutput?: boolean;
  supportsEmbeddings?: boolean;
}

/**
 * Why a model may not serve a capability, or null when it may — Phase 10 §7.
 *
 * The SAME rule the router applies at request time, applied here at activation
 * time. Two places rather than one is deliberate: the router must check because
 * a model can be disabled after a route is activated, and activation must check
 * because discovering an impossible route on a customer request means the
 * customer discovers it too.
 */
function capabilityRefusalFor(capability: string, model: ModelLike): string | null {
  const requirement = AI_CAPABILITY_REQUIREMENTS[capability];
  if (!requirement) return `names capability "${capability}", which is not defined`;
  if (!(model.capabilities ?? []).includes(capability)) {
    return `model "${model.key}" is not declared for ${capability}`;
  }
  if (model.modality !== undefined && model.modality !== requirement.executionModality) {
    return (
      `${capability} needs a ${requirement.executionModality} model, ` +
      `and "${model.key}" is ${model.modality}`
    );
  }
  const missing = requirement.requires.filter(
    (flag) => (model as unknown as Record<string, boolean | undefined>)[flag] !== true,
  );
  if (missing.length > 0) {
    return `model "${model.key}" does not declare ${missing.join(', ')}, which ${capability} requires`;
  }
  return null;
}
interface ProviderLike {
  key: string;
  status: string;
  apiKeySecretRef: string | null;
  noTrainingGuarantee: boolean;
  dataRetentionPolicy?: string;
  privacyReviewRef?: string | null;
}

function semantic(
  domain: ConfigDomain,
  payload: unknown,
  context: ConfigContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const doc = payload as Record<string, unknown>;

  if (domain === 'ai.models') {
    const providers = ((context['ai.providers'] as { providers?: ProviderLike[] })?.providers ??
      []) as ProviderLike[];
    const known = new Set(providers.map((p) => p.key));
    const seenModelKeys = new Set<string>();
    for (const [i, model] of ((doc['models'] ?? []) as ModelLike[]).entries()) {
      if (known.size > 0 && !known.has(model.providerKey)) {
        issues.push({
          severity: 'error',
          path: `models.${i}.providerKey`,
          message: `References provider "${model.providerKey}", which is not defined in ai.providers.`,
        });
      }

      // A duplicate key makes routing ambiguous and margin double-counted.
      if (seenModelKeys.has(model.key)) {
        issues.push({
          severity: 'error',
          path: `models.${i}.key`,
          message: `Duplicate model key "${model.key}".`,
        });
      }
      seenModelKeys.add(model.key);

      /*
       * docs/AI-GATEWAY.md §4: "cost fields must be present before a model can
       * be activated". A servable model with no cost basis records a provider
       * cost of zero on every request, which reports infinite margin — the one
       * number the margin floor exists to catch.
       */
      const servable = model.status === 'available' || model.status === 'beta';
      const missingCost =
        model.inputCostPerUnitMicroMinor === null ||
        model.inputCostPerUnitMicroMinor === undefined ||
        model.outputCostPerUnitMicroMinor === null ||
        model.outputCostPerUnitMicroMinor === undefined;
      /*
       * D-17 (approved 2026-09-13): no model reaches production customer
       * routing until it has passed a documented side-by-side Arabic
       * marketing-content benchmark. `available` is the status that puts
       * customer traffic on a model, so that is where the gate sits.
       *
       * `beta` is deliberately exempt — beta is the status a model occupies
       * WHILE it is being benchmarked, and a gate that blocked the evaluation
       * itself would make the evaluation impossible to run.
       */
      if (model.status === 'available' && !model.disableSwitch && !model.qualityBenchmarkRef) {
        issues.push({
          severity: 'error',
          path: `models.${i}.qualityBenchmarkRef`,
          message:
            `D-17: model "${model.key}" cannot be generally available until it has passed the Arabic ` +
            'quality benchmark. Record the benchmark reference, or keep the model in beta while it is evaluated. ' +
            'See docs/AI-QUALITY-BENCHMARK.md.',
        });
      }

      if (servable && !model.disableSwitch && missingCost) {
        issues.push({
          severity: 'error',
          path: `models.${i}.inputCostPerUnitMicroMinor`,
          message:
            `Model "${model.key}" is servable but has no cost basis. ` +
            'Enter the provider input and output rates before activating it.',
        });
      }
    }

    /*
     * PHASE 10 — a capability a model DECLARES but cannot actually serve.
     *
     * A tick box is not a capability. If an operator declares VISION_ANALYSIS
     * on a model whose vision flag is off, the declaration is refused here
     * rather than becoming a route that fails on a customer request.
     */
    for (const [i, model] of ((doc['models'] ?? []) as ModelLike[]).entries()) {
      for (const capability of model.capabilities ?? []) {
        if (!AI_CAPABILITY_REQUIREMENTS[capability]) continue; // the enum refused it
        const refusal = capabilityRefusalFor(capability, model);
        if (refusal !== null) {
          issues.push({
            severity: 'error',
            path: `models.${i}.capabilities`,
            message: `Declares ${capability} but ${refusal}.`,
          });
        }
      }
    }
  }

  if (domain === 'ai.capability-routing') {
    const models = ((context['ai.models'] as { models?: ModelLike[] })?.models ??
      []) as ModelLike[];
    const byKey = new Map(models.map((m) => [m.key, m]));
    const profile = String(doc['activeProfile'] ?? 'custom');
    const seen = new Set<string>();

    for (const [i, raw] of ((doc['routes'] ?? []) as Record<string, unknown>[]).entries()) {
      const capability = String(raw['capability']);
      if (seen.has(capability)) {
        issues.push({
          severity: 'error',
          path: `routes.${i}.capability`,
          message: `A route for ${capability} is already defined. One capability, one route.`,
        });
      }
      seen.add(capability);

      const enabled = raw['enabled'] !== false;
      const primary = raw['primaryModelKey'] === null ? null : String(raw['primaryModelKey'] ?? '');
      const fallbacks = ((raw['fallbackModelKeys'] ?? []) as unknown[]).map(String);

      /*
       * `custom` means the routes ARE the answer, so an enabled capability with
       * no primary model is a gap the operator has to close. Under a strategy
       * profile the same row legitimately means "let the profile choose".
       */
      if (profile === 'custom' && enabled && !primary) {
        issues.push({
          severity: 'error',
          path: `routes.${i}.primaryModelKey`,
          message:
            `The custom profile routes by this table, and ${capability} has no primary model. ` +
            'Name one, switch the capability off, or choose a routing profile.',
        });
      }

      // A named model must be able to do the work — PRIMARY AND FALLBACK ALIKE.
      // §7: a fallback may never silently violate the required capabilities.
      for (const [position, key] of [primary, ...fallbacks].entries()) {
        if (!key) continue;
        const model = byKey.get(key);
        if (byKey.size === 0) continue; // no catalogue in context yet
        const where = position === 0 ? 'primaryModelKey' : `fallbackModelKeys.${position - 1}`;
        if (!model) {
          issues.push({
            severity: 'error',
            path: `routes.${i}.${where}`,
            message: `Routes to model "${key}", which is not defined in ai.models.`,
          });
          continue;
        }
        if (model.status === 'disabled' || model.disableSwitch === true) {
          issues.push({
            severity: 'error',
            path: `routes.${i}.${where}`,
            message: `Routes to model "${key}", which is disabled.`,
          });
          continue;
        }
        const refusal = capabilityRefusalFor(capability, model);
        if (refusal !== null) {
          issues.push({
            severity: 'error',
            path: `routes.${i}.${where}`,
            message: `${position === 0 ? 'Primary' : 'Fallback'} for ${capability} cannot serve it: ${refusal}.`,
          });
        }
      }

      const minimum = raw['minimumQualityTier'];
      if (typeof minimum === 'string' && byKey.size > 0) {
        const rank: Record<string, number> = { fast: 1, balanced: 2, premium: 3 };
        const floor = rank[minimum] ?? 0;
        const anyAbove = models.some(
          (m) =>
            (m.capabilities ?? []).includes(capability) &&
            (rank[m.qualityTier ?? 'fast'] ?? 0) >= floor,
        );
        if (!anyAbove) {
          issues.push({
            severity: 'warning',
            path: `routes.${i}.minimumQualityTier`,
            message:
              `No model declared for ${capability} reaches the "${minimum}" tier, so this route ` +
              'cannot resolve. Lower the floor or add a model.',
          });
        }
      }
    }
  }

  if (domain === 'ai.routing') {
    const models = ((context['ai.models'] as { models?: ModelLike[] })?.models ??
      []) as ModelLike[];
    const usable = new Map(models.map((m) => [m.key, m]));

    /*
     * Two rules that select the same task, in the same scope, for the same
     * plan or workspace, at the same priority express no operator intent: the
     * resolver would have to pick one, and whichever it picked would be a
     * guess. docs/AI-GATEWAY.md §5.3 forbids the gateway guessing a model, so
     * the ambiguity is refused here, at activation, rather than resolved
     * silently on a live request.
     */
    const seenSelectors = new Map<string, number>();
    for (const [i, rule] of ((doc['rules'] ?? []) as Record<string, unknown>[]).entries()) {
      const selector = [
        String(rule['taskKey']),
        String(rule['scope'] ?? 'global'),
        String(rule['planKey'] ?? ''),
        String(rule['workspaceId'] ?? ''),
        String(rule['priority'] ?? 0),
      ].join('|');
      const first = seenSelectors.get(selector);
      if (first === undefined) {
        seenSelectors.set(selector, i);
      } else {
        issues.push({
          severity: 'error',
          path: `rules.${i}.priority`,
          message:
            `Duplicates rule ${first}: same task, scope and target at the same priority. ` +
            'Give one of them a higher priority so the resolution order is unambiguous.',
        });
      }
    }

    for (const [i, rule] of ((doc['rules'] ?? []) as Record<string, unknown>[]).entries()) {
      const primary = String(rule['primaryModelKey']);
      const model = usable.get(primary);
      if (usable.size > 0 && !model) {
        issues.push({
          severity: 'error',
          path: `rules.${i}.primaryModelKey`,
          message: `Routes to model "${primary}", which is not defined in ai.models.`,
        });
      } else if (model && (model.status === 'disabled' || model.disableSwitch)) {
        // Exactly the case docs/ARCHITECTURE.md §7.2 names.
        issues.push({
          severity: 'error',
          path: `rules.${i}.primaryModelKey`,
          message: `Routes to model "${primary}", which is disabled.`,
        });
      }
      /*
       * The approved output-persistence policy (2026-09-13) requires a DEFINED
       * retention and deletion policy for anything persisted. Persisting with
       * no expiry is how a gateway quietly becomes a permanent content store,
       * which the policy explicitly forbids, so the two settings are refused
       * apart.
       */
      const parameters = (rule['parameters'] ?? {}) as Record<string, unknown>;
      if (parameters['persistOutput'] === true && !parameters['outputRetentionDays']) {
        issues.push({
          severity: 'error',
          path: `rules.${i}.parameters.outputRetentionDays`,
          message:
            'Persisting AI output requires a retention window. Set outputRetentionDays, or turn persistOutput off.',
        });
      }

      if (rule['moderateInput'] === true && !rule['moderationModelKey']) {
        // A moderation step with no model would have to either pass everything
        // or fail everything. Both are worse than not claiming to moderate.
        issues.push({
          severity: 'error',
          path: `rules.${i}.moderationModelKey`,
          message: 'Input moderation is enabled but no moderation model is named.',
        });
      }
      if (rule['moderationModelKey']) {
        const moderationModel = usable.get(String(rule['moderationModelKey']));
        if (usable.size > 0 && !moderationModel) {
          issues.push({
            severity: 'error',
            path: `rules.${i}.moderationModelKey`,
            message: `Moderates with "${String(rule['moderationModelKey'])}", which is not defined in ai.models.`,
          });
        }
      }

      for (const [j, fallback] of ((rule['fallbackModelKeys'] ?? []) as string[]).entries()) {
        const fb = usable.get(fallback);
        if (usable.size > 0 && !fb) {
          issues.push({
            severity: 'error',
            path: `rules.${i}.fallbackModelKeys.${j}`,
            message: `Fallback model "${fallback}" is not defined in ai.models.`,
          });
        } else if (fb && (fb.status === 'disabled' || fb.disableSwitch)) {
          issues.push({
            severity: 'error',
            path: `rules.${i}.fallbackModelKeys.${j}`,
            message: `Fallback model "${fallback}" is disabled.`,
          });
        }
        if (fallback === primary) {
          issues.push({
            severity: 'warning',
            path: `rules.${i}.fallbackModelKeys.${j}`,
            message: 'The fallback is the same as the primary, so it adds no resilience.',
          });
        }
      }
    }
  }

  if (domain === 'ai.providers') {
    for (const [i, provider] of ((doc['providers'] ?? []) as ProviderLike[]).entries()) {
      if (provider.status === 'active' && !provider.apiKeySecretRef) {
        issues.push({
          severity: 'error',
          path: `providers.${i}.apiKeySecretRef`,
          message: 'An active provider must reference a stored API key secret.',
        });
      }
      /*
       * D-13 (approved 2026-09-13) turned these from advice into gates.
       *
       * The owner approved the provider ARCHITECTURE and made vendor selection
       * conditional on a privacy and data-processing review, a confirmation
       * that customer data is not used for training, and zero retention or an
       * acceptable equivalent. A warning was the right severity while the
       * decision was open; now that it is approved, a provider that has not
       * cleared these must not be activatable at all. An advisory gate is one
       * somebody eventually clicks past.
       */
      if (provider.status === 'active' && !provider.noTrainingGuarantee) {
        issues.push({
          severity: 'error',
          path: `providers.${i}.noTrainingGuarantee`,
          message:
            'D-13: a provider may not be activated until it is confirmed that customer data is not used for its training.',
        });
      }
      const retention = provider.dataRetentionPolicy ?? 'unverified';
      if (provider.status === 'active' && retention === 'unverified') {
        issues.push({
          severity: 'error',
          path: `providers.${i}.dataRetentionPolicy`,
          message:
            'D-13: a provider may not be activated before its data-retention terms have been reviewed.',
        });
      }
      if (provider.status === 'active' && retention === 'retains_data') {
        issues.push({
          severity: 'error',
          path: `providers.${i}.dataRetentionPolicy`,
          message:
            'D-13: this provider retains our data, which is not an acceptable equivalent to zero retention.',
        });
      }
      if (provider.status === 'active' && !provider.privacyReviewRef) {
        issues.push({
          severity: 'error',
          path: `providers.${i}.privacyReviewRef`,
          message:
            'D-13: record where the privacy and data-processing review is written down before activating this provider.',
        });
      }
    }
  }

  if (domain === 'entitlements') {
    const features = (doc['features'] ?? []) as {
      key: string;
      dependsOn: string[];
      valueType?: string;
      enumValues?: string[];
    }[];
    const featureKeys = new Set(features.map((f) => f.key));
    for (const [i, feature] of features.entries()) {
      for (const [j, dep] of (feature.dependsOn ?? []).entries()) {
        if (!featureKeys.has(dep)) {
          issues.push({
            severity: 'error',
            path: `features.${i}.dependsOn.${j}`,
            message: `Depends on feature "${dep}", which is not defined.`,
          });
        }
      }
    }
    const planKeys = new Set(
      (((context['plans'] as { plans?: { key: string }[] })?.plans ?? []) as { key: string }[]).map(
        (p) => p.key,
      ),
    );
    const entitlements = (doc['planEntitlements'] ?? []) as Record<string, unknown>[];
    const byFeature = new Map(features.map((f) => [f.key, f]));

    /** Which features one plan turns ON — the input to the dependency check. */
    const enabledByPlan = new Map<string, Set<string>>();
    for (const ent of entitlements) {
      if (ent['enabled'] !== true) continue;
      const planKey = String(ent['planKey']);
      const set = enabledByPlan.get(planKey) ?? new Set<string>();
      set.add(String(ent['featureKey']));
      enabledByPlan.set(planKey, set);
    }

    const seenPairs = new Set<string>();

    for (const [i, ent] of entitlements.entries()) {
      const featureKey = String(ent['featureKey']);
      const planKey = String(ent['planKey']);

      if (!featureKeys.has(featureKey)) {
        issues.push({
          severity: 'error',
          path: `planEntitlements.${i}.featureKey`,
          message: `Grants feature "${featureKey}", which is not defined.`,
        });
      }
      if (planKeys.size > 0 && !planKeys.has(planKey)) {
        issues.push({
          severity: 'error',
          path: `planEntitlements.${i}.planKey`,
          message: `References plan "${planKey}", which is not defined in plans.`,
        });
      }

      const pair = `${planKey}::${featureKey}`;
      if (seenPairs.has(pair)) {
        issues.push({
          severity: 'error',
          path: `planEntitlements.${i}`,
          message: `Plan "${planKey}" grants "${featureKey}" twice, so which row wins is undefined.`,
        });
      }
      seenPairs.add(pair);

      // D-62 / AC-04.9. The `client_viewer` RBAC key stays in the role catalogue
      // untouched; what the decision removed is SELLING it as a plan feature.
      if (/client[._-]?viewer/i.test(featureKey)) {
        issues.push({
          severity: 'error',
          path: `planEntitlements.${i}.featureKey`,
          message:
            'D-62: Client Viewer is not offered as a plan feature. The RBAC key is unchanged; it is simply not sold.',
        });
      }

      // AC-05.4, per plan rather than globally: enabling a feature whose
      // dependency that SAME plan leaves off is rejected here, at validation
      // time, with the dependency named — not discovered at runtime by a
      // customer whose button does nothing.
      if (ent['enabled'] === true) {
        const feature = byFeature.get(featureKey);
        for (const dependency of feature?.dependsOn ?? []) {
          if (!(enabledByPlan.get(planKey)?.has(dependency) ?? false)) {
            issues.push({
              severity: 'error',
              path: `planEntitlements.${i}.featureKey`,
              message: `Plan "${planKey}" enables "${featureKey}", which depends on "${dependency}" — and that is not enabled on this plan.`,
            });
          }
        }

        const valueType = feature?.valueType;
        if (valueType === 'enum') {
          const allowed = feature?.enumValues ?? [];
          const value = ent['enumValue'];
          if (typeof value !== 'string' || value.length === 0) {
            issues.push({
              severity: 'error',
              path: `planEntitlements.${i}.enumValue`,
              message: `"${featureKey}" is an enum feature, so the plan must say which value it grants.`,
            });
          } else if (allowed.length > 0 && !allowed.includes(value)) {
            issues.push({
              severity: 'error',
              path: `planEntitlements.${i}.enumValue`,
              message: `"${value}" is not one of the values "${featureKey}" defines.`,
            });
          }
        }
        if (valueType === 'boolean' && ent['limitValue'] !== null) {
          issues.push({
            severity: 'error',
            path: `planEntitlements.${i}.limitValue`,
            message: `"${featureKey}" is a boolean feature and takes no limit.`,
          });
        }
      }
    }
  }

  if (domain === 'plans') {
    const plans = (doc['plans'] ?? []) as Record<string, unknown>[];

    // The supported-currency list is the `operations` domain's, so "complete
    // price table" means complete against what the owner actually sells in —
    // not against whatever this document happens to mention (AC-04.4, AC-04.10).
    const supported = (
      ((context['operations'] as { supportedCurrencies?: string[] })?.supportedCurrencies ??
        []) as string[]
    ).map((c) => c.toUpperCase());

    // D-11 is a policy in the `credits` domain. A plan may not promise postpaid
    // overage while the platform is configured to hard-stop, because nothing
    // implements the charge — the plan would be selling a capability that does
    // not exist.
    const hardStop = (context['credits'] as { hardStopAtZero?: boolean })?.hardStopAtZero ?? true;

    const seenKeys = new Set<string>();

    for (const [i, plan] of plans.entries()) {
      const key = String(plan['key'] ?? '');
      if (seenKeys.has(key)) {
        issues.push({
          severity: 'error',
          path: `plans.${i}.key`,
          message: `Duplicate plan key "${key}".`,
        });
      }
      seenKeys.add(key);

      // D-62: BrandSpace is not an agency operating system. This is a commercial
      // decision the owner recorded, so it is enforced where plans are created
      // rather than left to reviewer memory (AC-04.9).
      const name = (plan['name'] ?? {}) as Record<string, string>;
      const agencyNamed = [key, name['en'] ?? '', name['ar'] ?? ''].some((value) =>
        /agency|وكالة/i.test(value),
      );
      if (agencyNamed) {
        issues.push({
          severity: 'error',
          path: `plans.${i}.key`,
          message:
            'D-62: the MVP is not an agency operating system, so there is no Agency plan. Use "scale" for larger and multi-brand businesses.',
        });
      }

      const prices = (plan['prices'] ?? []) as {
        currency: string;
        monthlyMinor: number;
        annualMinor: number;
      }[];
      const isActive = plan['status'] === 'active';

      if (isActive && prices.length === 0) {
        issues.push({
          severity: 'error',
          path: `plans.${i}.prices`,
          message: 'An active plan must define at least one currency price (owner decision D-07).',
        });
      }

      const currencies = prices.map((p) => p.currency.toUpperCase());
      if (new Set(currencies).size !== currencies.length) {
        issues.push({
          severity: 'error',
          path: `plans.${i}.prices`,
          message: 'Duplicate currency in the price table.',
        });
      }

      // AC-04.10. Every supported currency needs its OWN explicitly set price:
      // there is no runtime FX conversion anywhere, so a missing row is not a
      // gap the system can fill — it is a plan nobody in that market can buy.
      if (isActive) {
        for (const currency of supported) {
          if (!currencies.includes(currency)) {
            issues.push({
              severity: 'error',
              path: `plans.${i}.prices`,
              message: `No ${currency} price. Every supported currency needs an explicit price — no rate converts one at runtime (D-08).`,
            });
          }
        }
      }

      for (const [j, price] of prices.entries()) {
        if (price.annualMinor > price.monthlyMinor * 12) {
          issues.push({
            severity: 'warning',
            path: `plans.${i}.prices.${j}.annualMinor`,
            message: 'The annual price is higher than twelve monthly payments.',
          });
        }
      }

      const overage = (plan['overagePolicy'] ?? {}) as { mode?: string };
      if (hardStop && overage.mode && overage.mode !== 'block') {
        issues.push({
          severity: 'error',
          path: `plans.${i}.overagePolicy.mode`,
          message:
            'D-11: the MVP hard-stops at zero credits. Postpaid overage is not implemented, so a plan cannot promise it.',
        });
      }

      const downgrade = (plan['downgradeBehavior'] ?? {}) as { excessResources?: string };
      if (downgrade.excessResources && downgrade.excessResources !== 'read_only') {
        issues.push({
          severity: 'error',
          path: `plans.${i}.downgradeBehavior.excessResources`,
          message:
            'D-12: a downgrade never deletes or archives a customer resource. Excess resources become read-only.',
        });
      }

      const rollover = (plan['creditRollover'] ?? {}) as {
        policy?: string;
        capMultiplier?: number;
      };
      if (rollover.policy === 'capped' && !(Number(rollover.capMultiplier) > 0)) {
        issues.push({
          severity: 'error',
          path: `plans.${i}.creditRollover.capMultiplier`,
          message: 'A capped rollover needs a cap above zero, or the policy is really "none".',
        });
      }

      if (Number(plan['trialDays'] ?? 0) > 0 && Number(plan['trialCredits'] ?? 0) === 0) {
        issues.push({
          severity: 'warning',
          path: `plans.${i}.trialCredits`,
          message: 'The trial grants no credits, so no AI action can be tried during it.',
        });
      }

      for (const [j, addOn] of ((plan['addOns'] ?? []) as Record<string, unknown>[]).entries()) {
        const addOnCurrencies = ((addOn['prices'] ?? []) as { currency: string }[]).map((p) =>
          p.currency.toUpperCase(),
        );
        for (const currency of supported) {
          if (isActive && !addOnCurrencies.includes(currency)) {
            issues.push({
              severity: 'error',
              path: `plans.${i}.addOns.${j}.prices`,
              message: `Add-on "${String(addOn['key'])}" has no ${currency} price.`,
            });
          }
        }
      }
    }
  }

  if (domain === 'credits') {
    // D-11 was approved and nothing implements postpaid overage. Letting this
    // be switched off would silently produce a wallet that goes negative with
    // no billing path behind it.
    if (doc['hardStopAtZero'] === false) {
      issues.push({
        severity: 'error',
        path: 'hardStopAtZero',
        message:
          'D-11: postpaid overage is not implemented for the MVP. The hard stop cannot be switched off until it is.',
      });
    }
    const thresholds = (doc['lowBalanceThresholdPercents'] ?? []) as number[];
    if (new Set(thresholds).size !== thresholds.length) {
      issues.push({
        severity: 'error',
        path: 'lowBalanceThresholdPercents',
        message: 'Duplicate low-balance threshold.',
      });
    }
  }

  if (domain === 'beta-cohorts') {
    const cohorts = (doc['cohorts'] ?? []) as { key: string }[];
    const seen = new Set<string>();
    for (const [i, cohort] of cohorts.entries()) {
      if (seen.has(cohort.key)) {
        issues.push({
          severity: 'error',
          path: `cohorts.${i}.key`,
          message: `Duplicate cohort key "${cohort.key}".`,
        });
      }
      seen.add(cohort.key);
    }
  }

  if (domain === 'ai.budgets') {
    const perPlan = (doc['perPlan'] ?? []) as { planKey: string }[];
    const seen = new Set<string>();
    for (const [i, entry] of perPlan.entries()) {
      if (seen.has(entry.planKey)) {
        // Two entries for one plan means the ceiling depends on iteration
        // order, so a customer's refusal would too.
        issues.push({
          severity: 'error',
          path: `perPlan.${i}.planKey`,
          message: `Duplicate budget entry for plan "${entry.planKey}".`,
        });
      }
      seen.add(entry.planKey);
    }

    const scopes = [
      { path: 'defaults', value: doc['defaults'] },
      ...perPlan.map((entry, i) => ({ path: `perPlan.${i}`, value: entry })),
    ];
    for (const scope of scopes) {
      const limits = (scope.value ?? {}) as Record<string, number | null>;
      const day = limits['creditsPerDayMilli'];
      const month = limits['creditsPerMonthMilli'];
      const dayIsSet = typeof day === 'number';
      const monthIsSet = typeof month === 'number';
      if (dayIsSet && monthIsSet && day > month) {
        // The monthly ceiling would be unreachable, and the daily one would
        // never bind — an operator has almost certainly transposed them.
        issues.push({
          severity: 'error',
          path: `${scope.path}.creditsPerDayMilli`,
          message:
            'The daily credit ceiling exceeds the monthly one, so the monthly one is unreachable.',
        });
      }
    }
  }

  if (domain === 'ai.credit-rules') {
    for (const [i, cost] of ((doc['costs'] ?? []) as Record<string, unknown>[]).entries()) {
      if (Number(cost['baseMilliCredits']) === 0 && Number(cost['perUnitMilliCredits']) === 0) {
        issues.push({
          severity: 'warning',
          path: `costs.${i}`,
          message: 'This task is free at every volume. Confirm that is intended.',
        });
      }
    }
  }

  if (domain === 'feature-flags') {
    const flags = (doc['flags'] ?? []) as Record<string, unknown>[];
    for (const [i, flag] of flags.entries()) {
      const enabled = (flag['enabledForWorkspaces'] ?? []) as string[];
      const disabled = (flag['disabledForWorkspaces'] ?? []) as string[];
      const overlap = enabled.filter((w) => disabled.includes(w));
      if (overlap.length > 0) {
        issues.push({
          severity: 'error',
          path: `flags.${i}`,
          message: `Workspace ${overlap[0]} appears in both the enabled and disabled lists.`,
        });
      }
    }
  }

  return issues;
}

export function validateConfiguration(
  domain: ConfigDomain,
  payload: unknown,
  context: ConfigContext = {},
): ValidationReport {
  const { issues: structuralIssues, parsed } = structural(domain, payload);
  // Semantic checks assume a well-formed document, so they only run once the
  // structure holds — otherwise every error would be reported twice. They run
  // against the PARSED document, so a field the author omitted is seen as its
  // default rather than as `undefined`.
  const semanticIssues = structuralIssues.length === 0 ? semantic(domain, parsed, context) : [];
  const issues = [...structuralIssues, ...semanticIssues];
  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
    // A report stamp, not an input to any decision — the same exemption the
    // logger takes for its own timestamps.
    checkedAt: systemClock.now().toISOString(),
  };
}
