import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfigPayload, type ConfigDomain } from '@brandspace/config';
import { AI_APPS_FEATURE } from '@brandspace/entitlements';
import { areaCopy } from '../../apps/admin/src/i18n/simple-areas';
import { sourceOf } from '../../apps/admin/src/server/simple-areas/fields';
import { prepareEdit } from '../../apps/admin/src/server/simple-areas/edit';
import { findArea, findCollection } from '../../apps/admin/src/server/simple-areas/registry';
import { duration } from '../../apps/admin/src/server/simple-areas/plain';
import type { AreaContext, Docs } from '../../apps/admin/src/server/simple-areas/types';

/**
 * D-566 — CONTROL CENTER → AI APPS, the card engine's pure parts, run on the
 * PRODUCTION configuration documents: the whole feature on or off, the calls a
 * connection may make, and which plans include `feature.ai_apps` — written
 * through the Features page's own grant rule, the feature's registry entry
 * added the first time a plan gets it. A kill switch refuses the change.
 */

const ROOT = path.resolve(__dirname, '../..');
const FILES: Partial<Record<ConfigDomain, string>> = {
  plans: 'plans.json',
  entitlements: 'entitlements.json',
  'feature-flags': 'feature-flags.json',
  'ai-apps': 'ai-apps.json',
};

function productionDocs(): Docs {
  const docs: Docs = {};
  for (const [domain, file] of Object.entries(FILES) as [ConfigDomain, string][]) {
    docs[domain] = parseConfigPayload(
      domain,
      JSON.parse(readFileSync(path.join(ROOT, 'docs/production-config', file), 'utf8')),
    ) as unknown as Record<string, unknown>;
  }
  return docs;
}

function context(locale: string): AreaContext {
  const t = areaCopy(locale);
  return {
    locale,
    t: (key, values) => t(key, values),
    customersPerPlan: {},
    variantsPerPlatform: {},
    currencies: ['USD'],
  };
}

const area = findArea('ai-apps')!;
const everyone = findCollection(area, 'ai-apps')!;
const perPlan = findCollection(area, 'plans')!;
const planKeys = (docs: Docs) =>
  (docs.plans?.['plans'] as { key: string; status: string }[])
    .filter((plan) => plan.status !== 'retired')
    .map((plan) => plan.key);

describe('D-566 · Control Center → AI apps', () => {
  it('opens on the production documents: off for everyone, on no plan, in both languages', () => {
    const docs = productionDocs();
    for (const locale of ['en', 'ar']) {
      const ctx = context(locale);
      const card = everyone.items(docs, ctx)[0]!;
      expect(card.status?.label).toBe(ctx.t('w.off'));
      expect(card.values).toEqual({ enabled: false, maxCalls: 60 });
      const plans = perPlan.items(docs, ctx)[0]!;
      expect(plans.values).toEqual({ plans: [] });
      expect(plans.status?.label).toBe(ctx.t('aa.s.noPlan'));
    }
  });

  it('turning it on writes only ai-apps.enabled and the call ceiling', () => {
    const docs = productionDocs();
    const ctx = context('en');
    const edit = prepareEdit({
      collection: everyone,
      docs,
      ctx,
      context: {},
      mode: 'edit',
      itemKey: 'ai-apps',
      source: sourceOf({ 'f.enabled': 'on', 'f.maxCalls': '30' }),
    });
    if ('missing' in edit) throw new Error('missing');
    expect(edit.problems).toEqual([]);
    expect(edit.after['ai-apps']?.['enabled']).toBe(true);
    expect(edit.after['ai-apps']?.['rateLimit']).toEqual({
      windowSeconds: 60,
      maxCallsPerConnection: 30,
    });
    expect(edit.after.entitlements).toBe(docs.entitlements);
    expect(edit.impacts).toContain(ctx.t('aa.p.on'));
  });

  it('choosing plans registers the feature once and grants exactly those plans', () => {
    const docs = productionDocs();
    const ctx = context('en');
    const keys = planKeys(docs);
    expect(keys.length).toBeGreaterThan(0);
    const chosen = keys.slice(0, 1);
    const edit = prepareEdit({
      collection: perPlan,
      docs,
      ctx,
      context: {},
      mode: 'edit',
      itemKey: 'plans',
      source: sourceOf({ 'f.plans': chosen }),
    });
    if ('missing' in edit) throw new Error('missing');
    expect(edit.problems).toEqual([]);
    const after = edit.after.entitlements as {
      features: { key: string }[];
      planEntitlements: { planKey: string; featureKey: string; enabled: boolean }[];
    };
    expect(after.features.filter((feature) => feature.key === AI_APPS_FEATURE)).toHaveLength(1);
    expect(
      after.planEntitlements
        .filter((grant) => grant.featureKey === AI_APPS_FEATURE && grant.enabled)
        .map((grant) => grant.planKey),
    ).toEqual(chosen);
    // Still off for everyone: the owner is told nobody notices yet.
    expect(edit.impacts).toContain(ctx.t('aa.p.stillOff'));
    // Parses as the service will validate it.
    expect(() => parseConfigPayload('entitlements', after)).not.toThrow();
  });

  it('opening a card and saving it unchanged changes nothing', () => {
    const docs = productionDocs();
    const ctx = context('en');
    for (const [collection, source] of [
      [everyone, sourceOf({ 'f.maxCalls': '60' })],
      [perPlan, sourceOf({})],
    ] as const) {
      const item = collection.items(docs, ctx)[0]!;
      const edit = prepareEdit({
        collection,
        docs,
        ctx,
        context: {},
        mode: 'edit',
        itemKey: item.key,
        source,
      });
      if ('missing' in edit) throw new Error('missing');
      expect(edit.unchanged).toBe(true);
    }
  });

  it('a kill switch on the feature refuses the plan change, in plain words', () => {
    const docs = productionDocs();
    const flags = (docs['feature-flags']?.['flags'] as Record<string, unknown>[]) ?? [];
    const withKill: Docs = {
      ...docs,
      'feature-flags': {
        ...docs['feature-flags'],
        flags: [
          ...flags,
          parseConfigPayload('feature-flags', {
            flags: [{ featureKey: AI_APPS_FEATURE, killSwitch: true }],
          }).flags[0],
        ],
      },
    };
    const ctx = context('en');
    expect(perPlan.items(withKill, ctx)[0]!.status?.label).toBe(ctx.t('aa.s.killed'));
    const edit = prepareEdit({
      collection: perPlan,
      docs: withKill,
      ctx,
      context: {},
      mode: 'edit',
      itemKey: 'plans',
      source: sourceOf({ 'f.plans': planKeys(docs).slice(0, 1) }),
    });
    if ('missing' in edit) throw new Error('missing');
    expect(edit.problems).toContain(ctx.t('aa.r.killed'));
  });
});

describe('D-563 · every length of time on the AI apps page reads in plain units', () => {
  it('the production numbers: the audited ceilings, in hours, minutes and days, en and ar', () => {
    const docs = productionDocs();
    const expected = {
      en: {
        'aa.d.window': '1 minute',
        'aa.d.access': '1 hour',
        'aa.d.refresh': '30 days',
        'aa.d.code': '1 minute',
        'aa.d.register': '20 every 1 hour',
        'aa.d.token': '60 every 1 minute',
        'aa.d.unused': '30 days',
        calls: '60 every 1 minute',
      },
      ar: {
        'aa.d.window': 'دقيقة',
        'aa.d.access': 'ساعة',
        'aa.d.refresh': '30 يومًا',
        'aa.d.code': 'دقيقة',
        'aa.d.register': '20 كل ساعة',
        'aa.d.token': '60 كل دقيقة',
        'aa.d.unused': '30 يومًا',
        calls: '60 كل دقيقة',
      },
    } as const;
    for (const locale of ['en', 'ar'] as const) {
      const ctx = context(locale);
      const rows = Object.fromEntries(
        (area.developer ?? [])
          .filter((row) => row.label !== 'aa.d.origins')
          .map((row) => [row.label, row.value(docs, ctx)]),
      );
      const calls = everyone
        .items(docs, ctx)[0]!
        .facts?.find((fact) => fact.label === ctx.t('aa.f.calls'))?.value;
      expect({ ...rows, calls }).toEqual(expected[locale]);
      expect(JSON.stringify(rows)).not.toMatch(/seconds|ثانية/);
    }
  });

  it('duration() takes the largest whole unit and keeps seconds only when nothing larger divides', () => {
    const en = context('en');
    const ar = context('ar');
    expect(duration(en, 3_600)).toBe('1 hour');
    expect(duration(en, 60)).toBe('1 minute');
    expect(duration(en, 2_592_000)).toBe('30 days');
    expect(duration(en, 7_200)).toBe('2 hours');
    expect(duration(en, 90)).toBe('90 seconds');
    expect(duration(en, undefined)).toBe('—');
    expect(duration(ar, 7_200)).toBe('ساعتان');
    expect(duration(ar, 600)).toBe('10 دقائق');
    expect(duration(ar, 90)).toBe('90 ثانية');
  });
});
