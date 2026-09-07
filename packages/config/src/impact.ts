import { systemClock } from '@brandspace/shared';
import type { ConfigDomain } from './domains';

/**
 * Impact preview — docs/ARCHITECTURE.md §7.2.
 *
 * "Activation shows what changes." Activating configuration blind is how a
 * platform silently reprices every customer or disables a model that live
 * traffic depends on, so the diff is computed and shown BEFORE the owner
 * confirms.
 */

export interface ImpactChange {
  readonly kind: 'added' | 'removed' | 'changed';
  readonly path: string;
  readonly summary: string;
  /** `high` requires a typed confirmation in the UI. */
  readonly severity: 'info' | 'notice' | 'high';
}

export interface ImpactPreview {
  readonly domain: ConfigDomain;
  readonly changes: readonly ImpactChange[];
  readonly highImpactCount: number;
  readonly generatedAt: string;
  /** Set for the `plans` domain when workspace counts were supplied. */
  readonly affected?: AffectedWorkspaces;
}

/**
 * Who this activation actually lands on — AC-04.5.
 *
 * "3 plans changed, 128 workspaces affected, 12 would exceed their new brand
 * limit." The last clause is the one that matters: a preview that reports only
 * a count tells the owner nothing about whether confirming is safe.
 *
 * Workspaces are named by ID and slug. No customer name, no owner email: the
 * operator needs to identify the workspace, not read its address book.
 */
export interface AffectedWorkspaces {
  readonly totalOnChangedPlans: number;
  readonly overLimit: readonly {
    readonly workspaceId: string;
    readonly slug: string;
    readonly planKey: string;
    readonly dimension: string;
    readonly current: number;
    readonly newLimit: number;
  }[];
}

/** One workspace's current consumption, for the over-limit check. */
export interface WorkspaceUsageSnapshot {
  readonly workspaceId: string;
  readonly slug: string;
  readonly planKey: string;
  /** Quota dimension -> current usage. Missing dimensions are not checked. */
  readonly usage: Readonly<Record<string, number>>;
}

type Doc = Record<string, unknown>;

/** Domains whose documents are keyed collections, and the key field to match on. */
const COLLECTIONS: Partial<Record<ConfigDomain, { field: string; key: string; label: string }>> = {
  'ai.providers': { field: 'providers', key: 'key', label: 'provider' },
  'ai.models': { field: 'models', key: 'key', label: 'model' },
  'ai.routing': { field: 'rules', key: 'taskKey', label: 'routing rule' },
  'ai.credit-rules': { field: 'costs', key: 'taskKey', label: 'credit cost' },
  plans: { field: 'plans', key: 'key', label: 'plan' },
  'feature-flags': { field: 'flags', key: 'featureKey', label: 'feature flag' },
  'usage-limits': { field: 'limits', key: 'key', label: 'usage limit' },
  templates: { field: 'templates', key: 'key', label: 'template' },
  'integrations.social-apps': { field: 'applications', key: 'providerKey', label: 'social app' },
};

/** Changes that deserve a typed confirmation rather than a click-through. */
function severityFor(
  domain: ConfigDomain,
  kind: string,
  before: Doc | undefined,
  after: Doc | undefined,
): ImpactChange['severity'] {
  if (kind === 'removed') return 'high';

  if (domain === 'plans' && before && after) {
    // Repricing an existing plan affects real money.
    const b = JSON.stringify(before['prices'] ?? []);
    const a = JSON.stringify(after['prices'] ?? []);
    if (b !== a) return 'high';
  }
  if (domain === 'ai.credit-rules') return 'high';
  if (
    domain === 'ai.models' &&
    after &&
    (after['disableSwitch'] === true || after['status'] === 'disabled')
  ) {
    return 'high';
  }
  if (domain === 'feature-flags' && after && after['killSwitch'] === true) return 'high';
  return 'notice';
}

function describe(
  label: string,
  key: string,
  before: Doc | undefined,
  after: Doc | undefined,
): string {
  if (!before) return `${label} "${key}" will be added`;
  if (!after) return `${label} "${key}" will be REMOVED`;
  const changed = Object.keys({ ...before, ...after }).filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
  return `${label} "${key}" changes: ${changed.join(', ')}`;
}

/**
 * Diff two configuration documents for the same domain.
 *
 * Collection domains are diffed by their natural key so the preview reads as
 * "model X disabled" rather than "array index 3 changed" — the difference
 * between a preview someone actually reads and one they click past.
 */
export function buildImpactPreview(
  domain: ConfigDomain,
  currentPayload: unknown,
  nextPayload: unknown,
): ImpactPreview {
  const changes: ImpactChange[] = [];
  const collection = COLLECTIONS[domain];
  const current = (currentPayload ?? {}) as Doc;
  const next = (nextPayload ?? {}) as Doc;

  if (collection) {
    const before = new Map(
      ((current[collection.field] ?? []) as Doc[]).map((x) => [String(x[collection.key]), x]),
    );
    const after = new Map(
      ((next[collection.field] ?? []) as Doc[]).map((x) => [String(x[collection.key]), x]),
    );

    for (const [key, item] of after) {
      const existing = before.get(key);
      if (!existing) {
        changes.push({
          kind: 'added',
          path: `${collection.field}.${key}`,
          summary: describe(collection.label, key, undefined, item),
          severity: severityFor(domain, 'added', undefined, item),
        });
      } else if (JSON.stringify(existing) !== JSON.stringify(item)) {
        changes.push({
          kind: 'changed',
          path: `${collection.field}.${key}`,
          summary: describe(collection.label, key, existing, item),
          severity: severityFor(domain, 'changed', existing, item),
        });
      }
    }
    for (const [key, item] of before) {
      if (!after.has(key)) {
        changes.push({
          kind: 'removed',
          path: `${collection.field}.${key}`,
          summary: describe(collection.label, key, item, undefined),
          severity: 'high',
        });
      }
    }
  } else {
    // Scalar/nested domains: report top-level fields that differ.
    for (const field of new Set([...Object.keys(current), ...Object.keys(next)])) {
      if (JSON.stringify(current[field]) !== JSON.stringify(next[field])) {
        changes.push({
          kind: field in current ? (field in next ? 'changed' : 'removed') : 'added',
          path: field,
          summary: `"${field}" will change`,
          severity: field === 'maintenanceMode' ? 'high' : 'notice',
        });
      }
    }
  }

  return {
    domain,
    changes,
    highImpactCount: changes.filter((c) => c.severity === 'high').length,
    // A report stamp, not an input to any decision.
    generatedAt: systemClock.now().toISOString(),
  };
}

/** The six quota fields, and the usage key each is compared against. */
const QUOTA_DIMENSIONS: ReadonlyArray<{ field: string; usageKey: string }> = [
  { field: 'seats', usageKey: 'seats' },
  { field: 'brands', usageKey: 'brands' },
  { field: 'socialAccounts', usageKey: 'socialAccounts' },
  { field: 'scheduledPostsPerMonth', usageKey: 'scheduledPostsPerMonth' },
  { field: 'storageGb', usageKey: 'storageGb' },
];

/**
 * Add the affected-workspace analysis to a `plans` preview.
 *
 * Separated from `buildImpactPreview` because it needs the DATABASE, and the
 * diff must stay a pure function the unit tests can drive without one.
 *
 * A workspace is "over limit" when the plan it is on is being changed AND its
 * current consumption exceeds the NEW limit. Tightening a limit nobody has
 * reached is not an impact worth alarming about; tightening one twelve
 * customers are past is the whole reason this exists. D-12 means none of them
 * loses anything — excess becomes read-only — but the owner still has to know
 * before confirming.
 */
export function withAffectedWorkspaces(
  preview: ImpactPreview,
  nextPayload: unknown,
  snapshots: readonly WorkspaceUsageSnapshot[],
): ImpactPreview {
  if (preview.domain !== 'plans') return preview;

  const changedPlanKeys = new Set(
    preview.changes
      .filter((c) => c.kind !== 'removed')
      .map((c) => c.path.split('.').slice(1).join('.')),
  );
  const next = (nextPayload ?? {}) as Doc;
  const nextPlans = new Map(((next['plans'] ?? []) as Doc[]).map((p) => [String(p['key']), p]));

  const onChangedPlans = snapshots.filter((s) => changedPlanKeys.has(s.planKey));
  const overLimit: AffectedWorkspaces['overLimit'][number][] = [];

  for (const snapshot of onChangedPlans) {
    const plan = nextPlans.get(snapshot.planKey);
    if (!plan) continue;
    const quotas = (plan['quotas'] ?? {}) as Doc;

    for (const dimension of QUOTA_DIMENSIONS) {
      const raw = quotas[dimension.field];
      // null is "unlimited/negotiated". Nobody can be over an absent limit.
      if (raw === null || raw === undefined) continue;
      const newLimit = Number(raw);
      if (!Number.isFinite(newLimit)) continue;

      const current = snapshot.usage[dimension.usageKey];
      if (typeof current !== 'number') continue;
      if (current <= newLimit) continue;

      overLimit.push({
        workspaceId: snapshot.workspaceId,
        slug: snapshot.slug,
        planKey: snapshot.planKey,
        dimension: dimension.field,
        current,
        newLimit,
      });
    }
  }

  return {
    ...preview,
    affected: { totalOnChangedPlans: onChangedPlans.length, overLimit },
  };
}
