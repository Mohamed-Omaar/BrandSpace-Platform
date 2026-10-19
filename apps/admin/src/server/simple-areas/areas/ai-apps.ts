import { parseConfigPayload, type ConfigPayload } from '@brandspace/config';
import { AI_APPS_FEATURE, AI_APPS_FEATURE_DEFINITION } from '@brandspace/entitlements';
import {
  featureAccess,
  withPlanGrants,
  type FlagShape,
  type GrantShape,
} from '../../feature-access';
import type { AreaContext, AreaSpec, CollectionSpec, Docs, FieldSpec, ItemView } from '../types';
import { arrayOf, rec, str } from '../json';
import { duration, joined, planName } from '../plain';

/**
 * AI APPS — CONNECTING CLAUDE, CHATGPT OR ANY MCP CLIENT (D-566).
 *
 * Two cards. "For everyone": the whole feature on or off (`ai-apps.enabled`)
 * and how many tool calls one connection may make per window. "Plans": which
 * plans include it — the yes/no feature `feature.ai_apps`, written through
 * the Features page's own grant rule (`withPlanGrants`), so it means exactly
 * what the plan cards and the engine mean by it. The feature's registry entry
 * is added the first time a plan is given it.
 *
 * A kill switch or custom targeting on the feature is shown and left to
 * Advanced: rewriting it from a plan list would discard targeting set on
 * purpose (D-314). The sign-in timings and source-address ceilings are shown
 * under "Changed by your developer".
 */

type AiAppsDoc = ConfigPayload<'ai-apps'>;

/** The active document, or the defaults when none was ever activated. */
function aiApps(docs: Docs): AiAppsDoc {
  return parseConfigPayload('ai-apps', docs['ai-apps'] ?? {});
}

const switchFields: readonly FieldSpec[] = [
  {
    id: 'enabled',
    kind: 'switch',
    label: 'aa.f.enabled',
    help: 'aa.h.enabled',
    impact: 'aa.i.enabled',
  },
  {
    id: 'maxCalls',
    kind: 'number',
    label: 'aa.f.calls',
    help: 'aa.h.calls',
    impact: 'aa.i.calls',
    unit: 'u.calls',
    min: 1,
    max: 10_000,
  },
];

const everyone: CollectionSpec = {
  id: 'ai-apps',
  title: 'aa.e.title',
  intro: 'aa.e.intro',
  domains: ['ai-apps'],
  fields: () => switchFields,
  keyOf: () => 'ai-apps',
  items: (docs, ctx): readonly ItemView[] => {
    const doc = aiApps(docs);
    return [
      {
        key: 'ai-apps',
        title: ctx.t('aa.e.cardTitle'),
        status: doc.enabled
          ? { label: ctx.t('w.on'), tone: 'success' }
          : { label: ctx.t('w.off'), tone: 'neutral' },
        facts: [
          {
            label: ctx.t('aa.f.calls'),
            value: ctx.t('w.perWindow', {
              count: doc.rateLimit.maxCallsPerConnection,
              window: duration(ctx, doc.rateLimit.windowSeconds),
            }),
          },
          { label: ctx.t('aa.e.credits'), value: ctx.t('aa.e.noCredits') },
        ],
        values: { enabled: doc.enabled, maxCalls: doc.rateLimit.maxCallsPerConnection },
      },
    ];
  },
  apply: (docs, _ctx, { values }) => {
    const doc = aiApps(docs);
    if (
      values['enabled'] === doc.enabled &&
      values['maxCalls'] === doc.rateLimit.maxCallsPerConnection
    )
      return {};
    return {
      'ai-apps': {
        ...rec(docs['ai-apps'] ?? doc),
        enabled: values['enabled'],
        rateLimit: { ...doc.rateLimit, maxCallsPerConnection: values['maxCalls'] },
      },
    };
  },
  impact: (before, after, ctx) => {
    const was = aiApps(before);
    const now = aiApps(after);
    const out: string[] = [];
    if (!was.enabled && now.enabled) out.push(ctx.t('aa.p.on'));
    if (was.enabled && !now.enabled) out.push(ctx.t('aa.p.off'));
    if (was.rateLimit.maxCallsPerConnection !== now.rateLimit.maxCallsPerConnection)
      out.push(ctx.t('aa.i.calls'));
    return out.length > 0 ? out : [ctx.t('w.noCustomerChange')];
  },
  slices: () => [
    {
      domain: 'ai-apps',
      read: (doc) => ({
        enabled: doc['enabled'],
        maxCallsPerConnection: rec(doc['rateLimit'])['maxCallsPerConnection'],
      }),
      write: (doc, value) => {
        const v = rec(value);
        return {
          ...doc,
          enabled: v['enabled'],
          rateLimit: {
            ...rec(doc['rateLimit']),
            maxCallsPerConnection: v['maxCallsPerConnection'],
          },
        };
      },
    },
  ],
};

const planKeysOf = (docs: Docs): string[] =>
  arrayOf(docs.plans?.['plans'])
    .map(rec)
    .filter((plan) => str(plan['status']) !== 'retired')
    .map((plan) => str(plan['key']))
    .filter(Boolean);

function access(docs: Docs) {
  const entitlements = docs.entitlements ?? {};
  const feature = arrayOf(entitlements['features'])
    .map(rec)
    .find((row) => str(row['key']) === AI_APPS_FEATURE);
  return featureAccess({
    valueType: 'boolean',
    defaultValue: feature ? feature['defaultValue'] : AI_APPS_FEATURE_DEFINITION.defaultValue,
    flag:
      (arrayOf(docs['feature-flags']?.['flags']) as unknown as FlagShape[]).find(
        (flag) => flag.featureKey === AI_APPS_FEATURE,
      ) ?? null,
    grants: (arrayOf(entitlements['planEntitlements']) as unknown as GrantShape[]).filter(
      (grant) => grant.featureKey === AI_APPS_FEATURE,
    ),
    planKeys: planKeysOf(docs),
  });
}

function plansStatus(docs: Docs, ctx: AreaContext): NonNullable<ItemView['status']> {
  const now = access(docs);
  switch (now.kind) {
    case 'kill_switch':
      return { label: ctx.t('aa.s.killed'), tone: 'danger' };
    case 'custom':
      return { label: ctx.t('aa.s.custom'), tone: 'warning' };
    case 'everyone':
      return { label: ctx.t('aa.s.everyPlan'), tone: 'success' };
    case 'plans':
      return now.plans.length > 0
        ? { label: ctx.t('w.on'), tone: 'success' }
        : { label: ctx.t('aa.s.noPlan'), tone: 'neutral' };
    default:
      return { label: ctx.t('aa.s.noPlan'), tone: 'neutral' };
  }
}

const perPlan: CollectionSpec = {
  id: 'plans',
  title: 'aa.p.title',
  intro: 'aa.p.intro',
  domains: ['entitlements'],
  reads: ['plans', 'feature-flags'],
  fields: (docs, ctx) => [
    {
      id: 'plans',
      kind: 'multi',
      label: 'aa.f.plans',
      help: 'aa.h.plans',
      impact: 'aa.i.plans',
      options: planKeysOf(docs).map((key) => ({
        value: key,
        label: { literal: planName(docs, key, ctx) },
      })),
    },
  ],
  keyOf: () => 'plans',
  items: (docs, ctx): readonly ItemView[] => {
    const now = access(docs);
    const chosen = now.kind === 'plans' ? now.plans : [];
    return [
      {
        key: 'plans',
        title: ctx.t('aa.p.cardTitle'),
        status: plansStatus(docs, ctx),
        facts: [
          {
            label: ctx.t('aa.f.plans'),
            value:
              now.kind === 'everyone'
                ? ctx.t('aa.s.everyPlan')
                : now.kind === 'plans'
                  ? chosen.length > 0
                    ? joined(
                        ctx,
                        chosen.map((key) => planName(docs, key, ctx)),
                      )
                    : ctx.t('w.none')
                  : ctx.t('aa.s.advanced'),
          },
        ],
        values: { plans: chosen },
      },
    ];
  },
  apply: (docs, _ctx, { values }) => {
    const entitlements = docs.entitlements;
    if (!entitlements) return {};
    const now = access(docs);
    if (now.kind !== 'plans') return {};
    const want = arrayOf(values['plans']).map(str).filter(Boolean);
    const same = want.length === now.plans.length && want.every((key) => now.plans.includes(key));
    if (same) return {};
    const features = arrayOf(entitlements['features']).map(rec);
    const defined = features.some((row) => str(row['key']) === AI_APPS_FEATURE);
    const withFeature = {
      ...entitlements,
      features: defined ? features : [...features, { ...AI_APPS_FEATURE_DEFINITION }],
      planEntitlements: arrayOf(entitlements['planEntitlements']) as unknown as GrantShape[],
    };
    return {
      entitlements: withPlanGrants(
        withFeature,
        AI_APPS_FEATURE,
        planKeysOf(docs),
        want,
        AI_APPS_FEATURE_DEFINITION.defaultValue,
      ),
    };
  },
  check: (before, _after, ctx) => {
    const now = access(before);
    if (now.kind === 'kill_switch') return [ctx.t('aa.r.killed')];
    if (now.kind === 'custom' || now.kind === 'everyone' || now.kind === 'nobody')
      return [ctx.t('aa.r.advanced')];
    return [];
  },
  impact: (before, after, ctx) => {
    const was = access(before);
    const now = access(after);
    const wasPlans = was.kind === 'plans' ? was.plans : [];
    const nowPlans = now.kind === 'plans' ? now.plans : [];
    const out: string[] = [];
    const added = nowPlans.filter((key) => !wasPlans.includes(key));
    const removed = wasPlans.filter((key) => !nowPlans.includes(key));
    if (added.length > 0)
      out.push(
        ctx.t('aa.p.added', {
          plans: joined(
            ctx,
            added.map((key) => planName(after, key, ctx)),
          ),
        }),
      );
    if (removed.length > 0)
      out.push(
        ctx.t('aa.p.removed', {
          plans: joined(
            ctx,
            removed.map((key) => planName(after, key, ctx)),
          ),
        }),
      );
    if (!aiApps(after).enabled && added.length > 0) out.push(ctx.t('aa.p.stillOff'));
    return out.length > 0 ? out : [ctx.t('w.noCustomerChange')];
  },
  slices: () => [
    {
      domain: 'entitlements',
      read: (doc) =>
        arrayOf(doc['planEntitlements'])
          .map(rec)
          .filter((grant) => str(grant['featureKey']) === AI_APPS_FEATURE),
      write: (doc, value) => ({
        ...doc,
        planEntitlements: [
          ...arrayOf(doc['planEntitlements'])
            .map(rec)
            .filter((grant) => str(grant['featureKey']) !== AI_APPS_FEATURE),
          ...arrayOf(value).map(rec),
        ],
      }),
    },
  ],
};

export const aiAppsArea: AreaSpec = {
  key: 'ai-apps',
  title: 'aa.title',
  intro: 'aa.intro',
  href: (locale) => `/${locale}/console/manage/ai-apps`,
  collections: [everyone, perPlan],
  developer: [
    {
      label: 'aa.d.window',
      value: (docs, ctx) => duration(ctx, aiApps(docs).rateLimit.windowSeconds),
    },
    {
      label: 'aa.d.access',
      value: (docs, ctx) => duration(ctx, aiApps(docs).oauth.accessTokenTtlSeconds),
    },
    {
      label: 'aa.d.refresh',
      value: (docs, ctx) => duration(ctx, aiApps(docs).oauth.refreshTokenTtlDays * 86_400),
    },
    {
      label: 'aa.d.code',
      value: (docs, ctx) => duration(ctx, aiApps(docs).oauth.authorizationCodeTtlSeconds),
    },
    {
      label: 'aa.d.register',
      value: (docs, ctx) =>
        ctx.t('w.perWindow', {
          count: aiApps(docs).oauth.registrationPerIpPerHour,
          window: duration(ctx, 3_600),
        }),
    },
    {
      label: 'aa.d.token',
      value: (docs, ctx) =>
        ctx.t('w.perWindow', {
          count: aiApps(docs).oauth.tokenPerIpPerMinute,
          window: duration(ctx, 60),
        }),
    },
    {
      label: 'aa.d.unused',
      value: (docs, ctx) => duration(ctx, aiApps(docs).oauth.unusedClientRetentionDays * 86_400),
    },
    {
      label: 'aa.d.origins',
      value: (docs, ctx) => {
        const origins = aiApps(docs).allowedOrigins;
        return origins.length === 0 ? ctx.t('aa.d.noOrigins') : String(origins.length);
      },
    },
  ],
};
