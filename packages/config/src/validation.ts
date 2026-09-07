import type { z } from 'zod';
import { systemClock } from '@brandspace/shared';
import { CONFIG_DOMAINS, type ConfigDomain } from './domains';

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
}
interface ProviderLike {
  key: string;
  status: string;
  apiKeySecretRef: string | null;
  noTrainingGuarantee: boolean;
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
    for (const [i, model] of ((doc['models'] ?? []) as ModelLike[]).entries()) {
      if (known.size > 0 && !known.has(model.providerKey)) {
        issues.push({
          severity: 'error',
          path: `models.${i}.providerKey`,
          message: `References provider "${model.providerKey}", which is not defined in ai.providers.`,
        });
      }
    }
  }

  if (domain === 'ai.routing') {
    const models = ((context['ai.models'] as { models?: ModelLike[] })?.models ??
      []) as ModelLike[];
    const usable = new Map(models.map((m) => [m.key, m]));
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
      if (provider.status === 'active' && !provider.noTrainingGuarantee) {
        issues.push({
          severity: 'warning',
          path: `providers.${i}.noTrainingGuarantee`,
          message:
            'Only providers with no-training / zero-retention terms are eligible for production (D-13).',
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
