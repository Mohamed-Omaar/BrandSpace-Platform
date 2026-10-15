import type { AreaSpec, CollectionSpec, Docs, FieldSpec, ItemView } from '../types';
import { arrayOf, num, rec, str, upsertBy } from '../json';

/**
 * TRIAL AND CREDITS — what a new workspace gets, in numbers.
 *
 * WHICH PLAN A NEW WORKSPACE STARTS ON is not a separate setting: the API
 * starts the trial of the lowest-tier active plan that has trial days
 * (`apps/api/src/routes/onboarding.ts`). This area reads the same rule and
 * edits that plan's trial numbers, through the `plans` document — the same
 * values the Plans card shows. Credit expiry lives in `credits`.
 */

type Plan = Record<string, unknown>;

export function trialPlanOf(docs: Docs): Plan | null {
  const plans = arrayOf(docs.plans?.['plans']).map(rec);
  return (
    [...plans]
      .filter((plan) => str(plan['status']) === 'active' && (num(plan['trialDays']) ?? 0) > 0)
      .sort((a, b) => (num(a['tier']) ?? 0) - (num(b['tier']) ?? 0))[0] ??
    [...plans]
      .filter((plan) => str(plan['status']) === 'active')
      .sort((a, b) => (num(a['tier']) ?? 0) - (num(b['tier']) ?? 0))[0] ??
    null
  );
}

const trialFields: readonly FieldSpec[] = [
  { id: 'trialDays', kind: 'number', label: 'trial.f.days', help: 'trial.h.days', impact: 'plans.i.trial', unit: 'u.days', min: 0, max: 365 },
  { id: 'trialCredits', kind: 'number', label: 'plans.f.trialCredits', help: 'plans.h.trialCredits', impact: 'plans.i.trialCredits', unit: 'u.credits', min: 0, max: 1_000_000 },
  { id: 'monthlyCredits', kind: 'number', label: 'plans.f.monthlyCredits', help: 'plans.h.monthlyCredits', impact: 'plans.i.monthlyCredits', unit: 'u.credits', min: 0, max: 1_000_000 },
];

const newWorkspace: CollectionSpec = {
  id: 'trial',
  title: 'trial.c.title',
  intro: 'trial.c.intro',
  domains: ['plans'],
  fields: () => trialFields,
  keyOf: () => 'trial',
  items: (docs, ctx): readonly ItemView[] => {
    const plan = trialPlanOf(docs);
    if (!plan) return [];
    const name = rec(plan['name']);
    const days = num(plan['trialDays']) ?? 0;
    return [
      {
        key: str(plan['key']),
        title: ctx.t('trial.c.cardTitle'),
        subtitle: ctx.t('trial.c.plan', { plan: str(ctx.locale === 'ar' ? name['ar'] : name['en']) || str(plan['key']) }),
        status: days > 0 ? { label: ctx.t('w.on'), tone: 'success' } : { label: ctx.t('trial.c.noTrial'), tone: 'neutral' },
        facts: [
          { label: ctx.t('trial.f.days'), value: `${days} ${ctx.t('u.days')}` },
          { label: ctx.t('plans.f.trialCredits'), value: String(num(plan['trialCredits']) ?? 0) },
          { label: ctx.t('plans.f.monthlyCredits'), value: String(num(plan['monthlyCredits']) ?? 0) },
          { label: ctx.t('plans.f.q.brands'), value: String(rec(plan['quotas'])['brands'] ?? ctx.t('w.noLimit')) },
          { label: ctx.t('plans.f.q.workspaces'), value: String(rec(plan['quotas'])['workspaces'] ?? ctx.t('w.noLimit')) },
        ],
        values: {
          trialDays: days,
          trialCredits: num(plan['trialCredits']) ?? 0,
          monthlyCredits: num(plan['monthlyCredits']) ?? 0,
        },
      },
    ];
  },
  apply: (docs, _ctx, { itemKey, values }) => {
    const plans = arrayOf(docs.plans?.['plans']).map(rec);
    const plan = plans.find((candidate) => str(candidate['key']) === itemKey);
    if (!plan) return {};
    return {
      plans: {
        ...docs.plans,
        plans: upsertBy(
          plans,
          'key',
          { ...plan, trialDays: values['trialDays'], trialCredits: values['trialCredits'], monthlyCredits: values['monthlyCredits'] },
          itemKey,
        ),
      },
    };
  },
  impact: (before, after, ctx, itemKey) => {
    const find = (docs: Docs) => arrayOf(docs.plans?.['plans']).map(rec).find((plan) => str(plan['key']) === itemKey) ?? {};
    const was = find(before);
    const now = find(after);
    const out: string[] = [];
    if (num(was['trialDays']) !== num(now['trialDays']) || num(was['trialCredits']) !== num(now['trialCredits'])) out.push(ctx.t('plans.p.trial'));
    if (num(was['monthlyCredits']) !== num(now['monthlyCredits'])) out.push(ctx.t('plans.p.monthlyCredits'));
    return out.length > 0 ? out : [ctx.t('w.noCustomerChange')];
  },
  slices: (itemKey) => [
    {
      domain: 'plans',
      read: (doc) => {
        const plan = arrayOf(doc['plans']).map(rec).find((candidate) => str(candidate['key']) === itemKey);
        return plan ? { trialDays: plan['trialDays'], trialCredits: plan['trialCredits'], monthlyCredits: plan['monthlyCredits'] } : undefined;
      },
      write: (doc, value) => ({
        ...doc,
        plans: arrayOf(doc['plans'])
          .map(rec)
          .map((plan) => (str(plan['key']) === itemKey && value ? { ...plan, ...rec(value) } : plan)),
      }),
    },
  ],
};

const creditFields: readonly FieldSpec[] = [
  { id: 'planGrantExpiryMonths', kind: 'number', label: 'trial.f.planExpiry', help: 'trial.h.expiry', impact: 'trial.i.expiry', unit: 'u.months', min: 0, max: 120 },
  { id: 'promotionalExpiryMonths', kind: 'number', label: 'trial.f.promoExpiry', help: 'trial.h.expiry', impact: 'trial.i.expiry', unit: 'u.months', min: 0, max: 120 },
  { id: 'purchasedPackExpiryMonths', kind: 'number', label: 'trial.f.packExpiry', help: 'trial.h.expiry', impact: 'trial.i.expiry', unit: 'u.months', min: 0, max: 120 },
  { id: 'warnFirst', kind: 'number', label: 'trial.f.warnFirst', help: 'trial.h.warn', impact: 'trial.i.warn', unit: 'u.percent', min: 0, max: 100 },
  { id: 'warnSecond', kind: 'number', label: 'trial.f.warnSecond', help: 'trial.h.warn', impact: 'trial.i.warn', unit: 'u.percent', min: 0, max: 100 },
];

const months = (value: unknown, never: string, unit: string) =>
  (num(value) ?? 0) === 0 ? never : `${num(value)} ${unit}`;

const credits: CollectionSpec = {
  id: 'credits',
  title: 'trial.k.title',
  intro: 'trial.k.intro',
  domains: ['credits'],
  fields: () => creditFields,
  keyOf: () => 'credits',
  items: (docs, ctx): readonly ItemView[] => {
    const doc = docs.credits ?? {};
    const warn = arrayOf(doc['lowBalanceThresholdPercents']).map((value) => num(value) ?? 0).sort((a, b) => b - a);
    return [
      {
        key: 'credits',
        title: ctx.t('trial.k.cardTitle'),
        facts: [
          { label: ctx.t('trial.f.planExpiry'), value: months(doc['planGrantExpiryMonths'], ctx.t('trial.c.never'), ctx.t('u.months')) },
          { label: ctx.t('trial.f.promoExpiry'), value: months(doc['promotionalExpiryMonths'], ctx.t('trial.c.never'), ctx.t('u.months')) },
          { label: ctx.t('trial.f.packExpiry'), value: months(doc['purchasedPackExpiryMonths'], ctx.t('trial.c.never'), ctx.t('u.months')) },
          { label: ctx.t('trial.c.warnings'), value: warn.length === 0 ? ctx.t('w.none') : warn.map((value) => `${value}%`).join(' · ') },
        ],
        values: {
          planGrantExpiryMonths: num(doc['planGrantExpiryMonths']) ?? 0,
          promotionalExpiryMonths: num(doc['promotionalExpiryMonths']) ?? 0,
          purchasedPackExpiryMonths: num(doc['purchasedPackExpiryMonths']) ?? 0,
          warnFirst: warn[0] ?? 0,
          warnSecond: warn[1] ?? 0,
        },
      },
    ];
  },
  apply: (docs, _ctx, { values }) => ({
    credits: {
      ...docs.credits,
      planGrantExpiryMonths: values['planGrantExpiryMonths'],
      promotionalExpiryMonths: values['promotionalExpiryMonths'],
      purchasedPackExpiryMonths: values['purchasedPackExpiryMonths'],
      lowBalanceThresholdPercents: [...new Set([values['warnFirst'], values['warnSecond']])]
        .filter((value): value is number => typeof value === 'number' && value > 0)
        .sort((a, b) => b - a),
    },
  }),
  impact: (before, after, ctx) => {
    const was = before.credits ?? {};
    const now = after.credits ?? {};
    const out: string[] = [];
    if (['planGrantExpiryMonths', 'promotionalExpiryMonths', 'purchasedPackExpiryMonths'].some((key) => num(was[key]) !== num(now[key]))) out.push(ctx.t('trial.i.expiry'));
    if (JSON.stringify(was['lowBalanceThresholdPercents']) !== JSON.stringify(now['lowBalanceThresholdPercents'])) out.push(ctx.t('trial.i.warn'));
    return out.length > 0 ? out : [ctx.t('w.noCustomerChange')];
  },
  slices: () => [
    {
      domain: 'credits',
      read: (doc) => ({
        planGrantExpiryMonths: doc['planGrantExpiryMonths'],
        promotionalExpiryMonths: doc['promotionalExpiryMonths'],
        purchasedPackExpiryMonths: doc['purchasedPackExpiryMonths'],
        lowBalanceThresholdPercents: doc['lowBalanceThresholdPercents'],
      }),
      write: (doc, value) => ({ ...doc, ...rec(value) }),
    },
  ],
};

export const trialArea: AreaSpec = {
  key: 'trial',
  title: 'trial.title',
  intro: 'trial.intro',
  href: (locale) => `/${locale}/console/manage/trial`,
  collections: [newWorkspace, credits],
  developer: [
    { label: 'trial.d.hardStop', value: (docs, ctx) => ctx.t(docs.credits?.['hardStopAtZero'] === false ? 'w.no' : 'w.yes') },
    { label: 'trial.d.order', value: (docs, ctx) => (str(docs.credits?.['consumptionOrder']) === 'fifo_by_expiry' ? ctx.t('trial.d.orderValue') : str(docs.credits?.['consumptionOrder'])) },
    { label: 'trial.d.reservation', value: (docs) => `${num(docs.credits?.['reservationTimeoutSeconds']) ?? '—'} s` },
    { label: 'trial.d.whichPlan', value: (docs) => str(trialPlanOf(docs)?.['key']) || '—' },
  ],
};
