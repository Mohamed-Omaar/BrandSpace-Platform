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

function structural(domain: ConfigDomain, payload: unknown): ValidationIssue[] {
  const schema = CONFIG_DOMAINS[domain].schema as z.ZodTypeAny;
  const result = schema.safeParse(payload);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    severity: 'error' as const,
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
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
    const features = (doc['features'] ?? []) as { key: string; dependsOn: string[] }[];
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
    for (const [i, ent] of (
      (doc['planEntitlements'] ?? []) as Record<string, unknown>[]
    ).entries()) {
      if (!featureKeys.has(String(ent['featureKey']))) {
        issues.push({
          severity: 'error',
          path: `planEntitlements.${i}.featureKey`,
          message: `Grants feature "${String(ent['featureKey'])}", which is not defined.`,
        });
      }
      if (planKeys.size > 0 && !planKeys.has(String(ent['planKey']))) {
        issues.push({
          severity: 'error',
          path: `planEntitlements.${i}.planKey`,
          message: `References plan "${String(ent['planKey'])}", which is not defined in plans.`,
        });
      }
    }
  }

  if (domain === 'plans') {
    for (const [i, plan] of ((doc['plans'] ?? []) as Record<string, unknown>[]).entries()) {
      const prices = (plan['prices'] ?? []) as { currency: string }[];
      if (plan['status'] === 'active' && prices.length === 0) {
        issues.push({
          severity: 'error',
          path: `plans.${i}.prices`,
          message: 'An active plan must define at least one currency price (owner decision D-07).',
        });
      }
      const currencies = prices.map((p) => p.currency);
      if (new Set(currencies).size !== currencies.length) {
        issues.push({
          severity: 'error',
          path: `plans.${i}.prices`,
          message: 'Duplicate currency in the price table.',
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
  const structuralIssues = structural(domain, payload);
  // Semantic checks assume a well-formed document, so they only run once the
  // structure holds — otherwise every error would be reported twice.
  const semanticIssues = structuralIssues.length === 0 ? semantic(domain, payload, context) : [];
  const issues = [...structuralIssues, ...semanticIssues];
  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
    // A report stamp, not an input to any decision — the same exemption the
    // logger takes for its own timestamps.
    checkedAt: systemClock.now().toISOString(),
  };
}
