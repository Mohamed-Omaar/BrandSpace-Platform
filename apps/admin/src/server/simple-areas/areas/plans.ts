import { featureAccess, withPlanGrants, type FlagShape, type GrantShape } from '../../feature-access';
import type {
  AreaContext,
  AreaSpec,
  CollectionSpec,
  Docs,
  FieldSpec,
  FieldValues,
  ItemView,
  MoneyValue,
} from '../types';
import { formatMinor } from '../../money';
import { arrayOf, num, rec, str, upsertBy } from '../json';

/**
 * PLANS — one card per plan; create, edit, duplicate, archive (owner, D-557+).
 *
 * Writes the `plans` document and, for the features a plan includes, the
 * `entitlements` document through the Features page's own grant rule
 * (`withPlanGrants`), so "which features it includes" means exactly what the
 * Features page and the engine mean by it (D-314). Prices are shown to
 * customers only; payments stay off, and nothing here charges anyone.
 */

type Plan = Record<string, unknown>;

/** The limits the owner edits, in the order a customer reads them. */
export const PLAN_QUOTAS = [
  'brands',
  'workspaces',
  'seats',
  'socialAccounts',
  'scheduledPostsPerMonth',
  'storageGb',
] as const;

const plans = (docs: Docs): Plan[] => arrayOf(docs.plans?.['plans']).map(rec);

/** Which of the four the owner reads: on sale, unlisted, not ready, archived. */
export function availabilityOf(plan: Plan): 'public' | 'private' | 'draft' | 'archived' {
  const status = str(plan['status']);
  if (status === 'retired' || status === 'grandfathered') return 'archived';
  if (status === 'draft') return 'draft';
  return str(plan['visibility']) === 'public' ? 'public' : 'private';
}

function withAvailability(plan: Plan, availability: string): Plan {
  switch (availability) {
    case 'public':
      return { ...plan, status: 'active', visibility: 'public' };
    case 'private':
      return { ...plan, status: 'active', visibility: 'private' };
    case 'draft':
      return { ...plan, status: 'draft', visibility: 'private' };
    default:
      // Archiving keeps whoever is on it; nobody new can choose it (D-01's retire).
      return { ...plan, status: 'retired' };
  }
}

interface BooleanFeature {
  readonly key: string;
  readonly name: string;
  /** The plans that get it, when the Features page decides it per plan. */
  readonly plans: readonly string[] | null;
  readonly defaultValue: unknown;
}

/** The yes/no features, and per plan only where the Features page decides per plan. */
export function booleanFeatures(docs: Docs, locale: string): readonly BooleanFeature[] {
  const entitlements = docs.entitlements ?? {};
  const flags = arrayOf(docs['feature-flags']?.['flags']) as unknown as FlagShape[];
  const grants = arrayOf(entitlements['planEntitlements']) as unknown as GrantShape[];
  const planKeys = plans(docs).map((plan) => str(plan['key']));
  return arrayOf(entitlements['features'])
    .map(rec)
    .filter((feature) => str(feature['valueType']) === 'boolean')
    .map((feature) => {
      const key = str(feature['key']);
      const access = featureAccess({
        valueType: 'boolean',
        defaultValue: feature['defaultValue'],
        flag: flags.find((flag) => flag.featureKey === key) ?? null,
        grants: grants.filter((grant) => grant.featureKey === key),
        planKeys,
      });
      const name = rec(feature['name']);
      return {
        key,
        name: str(locale === 'ar' ? name['ar'] : name['en']) || str(name['en']) || key,
        plans: access.kind === 'plans' ? access.plans : null,
        defaultValue: feature['defaultValue'],
      };
    });
}

function priceFields(ctx: AreaContext): readonly FieldSpec[] {
  return [
    {
      id: 'priceMonthly',
      kind: 'money',
      label: 'plans.f.priceMonthly',
      help: 'plans.h.priceMonthly',
      impact: 'plans.i.price',
      currencies: ctx.currencies,
    },
    {
      id: 'priceAnnual',
      kind: 'money',
      label: 'plans.f.priceAnnual',
      help: 'plans.h.priceAnnual',
      impact: 'plans.i.price',
      currencies: ctx.currencies,
    },
  ];
}

const quotaUnit = {
  brands: 'u.brands',
  workspaces: 'u.workspaces',
  seats: 'u.people',
  socialAccounts: 'u.accounts',
  scheduledPostsPerMonth: 'u.postsPerMonth',
  storageGb: 'u.gb',
} as const;

function fields(docs: Docs, ctx: AreaContext, mode: string): readonly FieldSpec[] {
  const features = booleanFeatures(docs, ctx.locale).filter((feature) => feature.plans !== null);
  return [
    {
      id: 'key',
      kind: 'text',
      label: 'plans.f.key',
      help: 'plans.h.key',
      required: true,
      maxLength: 40,
      dir: 'ltr',
      lockedOnEdit: true,
      pattern: /^[a-z][a-z0-9-]{1,39}$/,
      patternMessage: 'v.key',
    },
    { id: 'nameEn', kind: 'text', label: 'plans.f.nameEn', help: 'plans.h.name', required: true, maxLength: 60, dir: 'ltr', impact: 'plans.i.name' },
    { id: 'nameAr', kind: 'text', label: 'plans.f.nameAr', help: 'plans.h.name', required: true, maxLength: 60, dir: 'rtl', impact: 'plans.i.name' },
    { id: 'descriptionEn', kind: 'text', label: 'plans.f.descriptionEn', help: 'plans.h.description', maxLength: 200, dir: 'ltr' },
    { id: 'descriptionAr', kind: 'text', label: 'plans.f.descriptionAr', help: 'plans.h.description', maxLength: 200, dir: 'rtl' },
    {
      id: 'availability',
      kind: 'choice',
      label: 'plans.f.availability',
      help: 'plans.h.availability',
      impact: 'plans.i.availability',
      options: [
        { value: 'public', label: 'plans.o.public' },
        { value: 'private', label: 'plans.o.private' },
        { value: 'draft', label: 'plans.o.draft' },
        ...(mode === 'edit' ? [{ value: 'archived', label: 'plans.o.archived' as const }] : []),
      ],
    },
    ...priceFields(ctx),
    { id: 'trialOn', kind: 'switch', label: 'plans.f.trialOn', help: 'plans.h.trialOn', impact: 'plans.i.trial' },
    { id: 'trialDays', kind: 'number', label: 'plans.f.trialDays', help: 'plans.h.trialDays', impact: 'plans.i.trial', unit: 'u.days', min: 0, max: 365 },
    { id: 'trialCredits', kind: 'number', label: 'plans.f.trialCredits', help: 'plans.h.trialCredits', impact: 'plans.i.trialCredits', unit: 'u.credits', min: 0, max: 1_000_000 },
    { id: 'monthlyCredits', kind: 'number', label: 'plans.f.monthlyCredits', help: 'plans.h.monthlyCredits', impact: 'plans.i.monthlyCredits', unit: 'u.credits', min: 0, max: 1_000_000 },
    ...PLAN_QUOTAS.map(
      (quota): FieldSpec => ({
        id: `q.${quota}`,
        kind: 'number',
        label: `plans.f.q.${quota}`,
        help: `plans.h.q.${quota}`,
        impact: 'plans.i.limit',
        unit: quotaUnit[quota],
        min: 1,
        max: 1_000_000,
        unlimited: true,
      }),
    ),
    ...(features.length > 0
      ? [
          {
            id: 'features',
            kind: 'multi',
            label: 'plans.f.features',
            help: 'plans.h.features',
            impact: 'plans.i.features',
            options: features.map((feature) => ({ value: feature.key, label: { literal: feature.name } })),
          } satisfies FieldSpec,
        ]
      : []),
  ];
}

function moneyOf(plan: Plan, field: 'monthlyMinor' | 'annualMinor', currencies: readonly string[]): MoneyValue {
  const prices = arrayOf(plan['prices']).map(rec);
  return {
    kind: 'money',
    minor: Object.fromEntries(
      currencies.map((currency) => [
        currency,
        num(prices.find((price) => str(price['currency']) === currency)?.[field]) ?? 0,
      ]),
    ),
  };
}

function valuesOf(plan: Plan, docs: Docs, ctx: AreaContext): FieldValues {
  const name = rec(plan['name']);
  const description = rec(plan['description']);
  const quotas = rec(plan['quotas']);
  const key = str(plan['key']);
  return {
    key,
    nameEn: str(name['en']),
    nameAr: str(name['ar']),
    descriptionEn: str(description['en']),
    descriptionAr: str(description['ar']),
    availability: availabilityOf(plan),
    priceMonthly: moneyOf(plan, 'monthlyMinor', ctx.currencies),
    priceAnnual: moneyOf(plan, 'annualMinor', ctx.currencies),
    trialOn: (num(plan['trialDays']) ?? 0) > 0,
    trialDays: num(plan['trialDays']) ?? 0,
    trialCredits: num(plan['trialCredits']) ?? 0,
    monthlyCredits: num(plan['monthlyCredits']) ?? 0,
    ...Object.fromEntries(PLAN_QUOTAS.map((quota) => [`q.${quota}`, num(quotas[quota]) ?? null])),
    features: booleanFeatures(docs, ctx.locale)
      .filter((feature) => feature.plans?.includes(key))
      .map((feature) => feature.key),
  };
}

/** The plan as its card reads it; the customer preview reads the same facts. */
function facts(plan: Plan, docs: Docs, ctx: AreaContext) {
  const quotas = rec(plan['quotas']);
  const limit = (value: unknown, unit: string) =>
    value === null || value === undefined ? ctx.t('w.noLimit') : `${num(value)} ${unit}`;
  const firstPrice = arrayOf(plan['prices']).map(rec)[0];
  return [
    {
      label: ctx.t('plans.c.price'),
      value: firstPrice
        ? ctx.t('plans.c.perMonth', {
            amount: formatMinor(num(firstPrice['monthlyMinor']) ?? 0, str(firstPrice['currency']), ctx.locale),
          })
        : ctx.t('plans.c.noPrice'),
    },
    {
      label: ctx.t('plans.c.trial'),
      value:
        (num(plan['trialDays']) ?? 0) > 0
          ? ctx.t('plans.c.trialDays', { days: num(plan['trialDays']) ?? 0, credits: num(plan['trialCredits']) ?? 0 })
          : ctx.t('plans.c.noTrial'),
    },
    { label: ctx.t('plans.c.monthlyCredits'), value: String(num(plan['monthlyCredits']) ?? 0) },
    ...PLAN_QUOTAS.map((quota) => ({
      label: ctx.t(`plans.f.q.${quota}`),
      value: limit(quotas[quota], ctx.t(quotaUnit[quota])),
    })),
    {
      label: ctx.t('plans.c.customers'),
      value: String(ctx.customersPerPlan[str(plan['key'])] ?? 0),
    },
    {
      label: ctx.t('plans.f.features'),
      value:
        booleanFeatures(docs, ctx.locale)
          .filter((feature) =>
            feature.plans === null ? false : feature.plans.includes(str(plan['key'])),
          )
          .map((feature) => feature.name)
          .join(ctx.locale === 'ar' ? '، ' : ', ') || ctx.t('w.none'),
    },
  ];
}

const STATUS_TONE = { public: 'success', private: 'info', draft: 'neutral', archived: 'neutral' } as const;

function items(docs: Docs, ctx: AreaContext): readonly ItemView[] {
  return plans(docs).map((plan) => {
    const name = rec(plan['name']);
    const availability = availabilityOf(plan);
    return {
      key: str(plan['key']),
      title: str(ctx.locale === 'ar' ? name['ar'] : name['en']) || str(name['en']) || str(plan['key']),
      subtitle: str(rec(plan['description'])[ctx.locale === 'ar' ? 'ar' : 'en']) || undefined,
      status: { label: ctx.t(`plans.o.${availability}`), tone: STATUS_TONE[availability] },
      facts: facts(plan, docs, ctx),
      values: valuesOf(plan, docs, ctx),
      previewKind: 'plan',
      ...(availability === 'archived' ? { archiveBlockedReason: ctx.t('plans.r.alreadyArchived') } : {}),
    } satisfies ItemView;
  });
}

function applyValues(plan: Plan, values: FieldValues, ctx: AreaContext): Plan {
  const monthly = values['priceMonthly'] as MoneyValue;
  const annual = values['priceAnnual'] as MoneyValue;
  const quotas = rec(plan['quotas']);
  const trialOn = values['trialOn'] === true;
  let next: Plan = {
    ...plan,
    key: values['key'],
    name: { en: values['nameEn'], ar: values['nameAr'] },
    description: { en: values['descriptionEn'], ar: values['descriptionAr'] },
    prices: ctx.currencies.map((currency) => ({
      currency,
      monthlyMinor: monthly.minor[currency] ?? 0,
      annualMinor: annual.minor[currency] ?? 0,
    })),
    trialDays: trialOn ? values['trialDays'] : 0,
    trialCredits: values['trialCredits'],
    monthlyCredits: values['monthlyCredits'],
    quotas: {
      ...quotas,
      ...Object.fromEntries(PLAN_QUOTAS.map((quota) => [quota, values[`q.${quota}`]])),
    },
  };
  next = withAvailability(next, String(values['availability']));
  return next;
}

function withFeatures(docs: Docs, planKey: string, chosen: readonly string[], ctx: AreaContext): Docs {
  const entitlements = docs.entitlements;
  if (!entitlements) return {};
  const features = booleanFeatures(docs, ctx.locale).filter((feature) => feature.plans !== null);
  let next = entitlements as { planEntitlements: GrantShape[] } & Record<string, unknown>;
  const planKeys = [...new Set([...plans(docs).map((plan) => str(plan['key'])), planKey])];
  for (const feature of features) {
    const now = new Set(feature.plans ?? []);
    const want = chosen.includes(feature.key);
    if (now.has(planKey) === want) continue;
    if (want) now.add(planKey);
    else now.delete(planKey);
    next = withPlanGrants(next, feature.key, planKeys, [...now], feature.defaultValue);
  }
  return next === entitlements ? {} : { entitlements: next };
}

const collection: CollectionSpec = {
  id: 'plans',
  title: 'plans.title',
  domains: ['plans', 'entitlements'],
  canCreate: true,
  canDuplicate: true,
  archiveLabel: 'a.archive',
  fields,
  items,
  keyOf: (values) => String(values['key']),
  apply: (docs, ctx, { mode, itemKey, values }) => {
    const list = plans(docs);
    const key = String(values['key']);
    const source =
      mode === 'new'
        ? { key, tier: Math.max(0, ...list.map((plan) => num(plan['tier']) ?? 0)) + 1, sortOrder: list.length }
        : (list.find((plan) => str(plan['key']) === itemKey) ?? {});
    const base = mode === 'duplicate' ? { ...source, key, sortOrder: list.length } : source;
    const plan = applyValues(base, values, ctx);
    const out: Docs = { plans: { ...docs.plans, plans: upsertBy(list, 'key', plan, mode === 'edit' ? itemKey : null) } };
    const chosen = (values['features'] as readonly string[] | undefined) ?? [];
    if (values['features'] !== undefined) Object.assign(out, withFeatures({ ...docs, ...out }, key, chosen, ctx));
    return out;
  },
  archive: (docs, _ctx, itemKey) => ({
    plans: {
      ...docs.plans,
      plans: plans(docs).map((plan) => (str(plan['key']) === itemKey ? withAvailability(plan, 'archived') : plan)),
    },
  }),
  impact: (before, after, ctx, itemKey) => {
    const out: string[] = [];
    const was = plans(before).find((plan) => str(plan['key']) === itemKey);
    const now = plans(after).find((plan) => str(plan['key']) === itemKey);
    const customers = ctx.customersPerPlan[itemKey] ?? 0;
    if (!was && now) out.push(ctx.t('plans.p.new'));
    if (was && now) {
      if (customers > 0) out.push(ctx.t('plans.p.customers', { count: customers }));
      const quotas = (plan: Plan) => rec(plan['quotas']);
      const lowered = PLAN_QUOTAS.filter((quota) => {
        const a = num(quotas(was)[quota]);
        const b = num(quotas(now)[quota]);
        return b !== null && (a === null || b < a);
      });
      if (lowered.length > 0) out.push(ctx.t('plans.p.lowered'));
      if (num(was['monthlyCredits']) !== num(now['monthlyCredits'])) out.push(ctx.t('plans.p.monthlyCredits'));
      if (num(was['trialCredits']) !== num(now['trialCredits']) || num(was['trialDays']) !== num(now['trialDays']))
        out.push(ctx.t('plans.p.trial'));
      if (availabilityOf(was) !== availabilityOf(now)) {
        out.push(ctx.t(`plans.p.availability.${availabilityOf(now)}`));
      }
      if (JSON.stringify(was['prices']) !== JSON.stringify(now['prices'])) out.push(ctx.t('plans.p.price'));
    }
    if (out.length === 0) out.push(ctx.t('w.noCustomerChange'));
    return out;
  },
  slices: (itemKey) => [
    {
      domain: 'plans',
      read: (doc) => arrayOf(doc['plans']).map(rec).find((plan) => str(plan['key']) === itemKey),
      write: (doc, value) => ({
        ...doc,
        plans:
          value === undefined
            ? arrayOf(doc['plans']).map(rec).filter((plan) => str(plan['key']) !== itemKey)
            : upsertBy(arrayOf(doc['plans']).map(rec), 'key', rec(value), itemKey),
      }),
    },
    {
      domain: 'entitlements',
      read: (doc) =>
        arrayOf(doc['planEntitlements']).map(rec).filter((grant) => str(grant['planKey']) === itemKey),
      write: (doc, value) => ({
        ...doc,
        planEntitlements: [
          ...arrayOf(doc['planEntitlements']).map(rec).filter((grant) => str(grant['planKey']) !== itemKey),
          ...arrayOf(value).map(rec),
        ],
      }),
    },
  ],
};

export const plansArea: AreaSpec = {
  key: 'plans',
  title: 'plans.title',
  intro: 'plans.intro',
  href: (locale) => `/${locale}/console/plans`,
  collections: [collection],
  developer: [
    { label: 'plans.d.rollover', value: (docs) => developerList(docs, (plan) => str(rec(plan['creditRollover'])['policy'])) },
    { label: 'plans.d.analyticsRetention', value: (docs) => developerList(docs, (plan) => String(rec(plan['quotas'])['analyticsRetentionDays'] ?? '—')) },
    { label: 'plans.d.addOns', value: (docs) => developerList(docs, (plan) => String(arrayOf(plan['addOns']).length)) },
    { label: 'plans.d.tax', value: (docs) => developerList(docs, (plan) => str(plan['taxBehavior'])) },
    { label: 'plans.d.aiCaps', value: (docs) => developerList(docs, (plan) => (rec(plan['quotas'])['automationAiActionsPerMonth'] ? '✓' : '—')) },
  ],
};

function developerList(docs: Docs, read: (plan: Plan) => string): string {
  const list = plans(docs);
  return list.length === 0 ? '—' : list.map((plan) => `${str(plan['key'])}: ${read(plan) || '—'}`).join(' · ');
}
