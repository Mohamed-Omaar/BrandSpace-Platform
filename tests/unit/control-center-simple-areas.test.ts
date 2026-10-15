import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_DOMAIN_KEYS,
  configLeafDiff,
  parseConfigPayload,
  type ConfigDomain,
} from '@brandspace/config';
import { AREA_COPY, areaCopy } from '../../apps/admin/src/i18n/simple-areas';
import { parseFields, sourceOf } from '../../apps/admin/src/server/simple-areas/fields';
import { prepareArchive, prepareEdit } from '../../apps/admin/src/server/simple-areas/edit';
import { AREAS, findArea, findCollection } from '../../apps/admin/src/server/simple-areas/registry';
import type { AreaContext, Docs, FieldSpec } from '../../apps/admin/src/server/simple-areas/types';
import { plainChange } from '../../apps/admin/src/server/simple-areas/history';
import {
  domainName,
  pendingName,
  plainDetail,
  quotaName,
} from '../../apps/admin/src/i18n/simple-names';

/**
 * CONTROL CENTER SIMPLE MODE (owner decision) — the card engine's pure parts:
 * the audit diff, field parsing, an edit from form to next documents, and the
 * area rules. Run against the PRODUCTION configuration files, so the cards
 * are proved on the documents the owner will actually edit.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

const FILES: Partial<Record<ConfigDomain, string>> = {
  plans: 'plans.json',
  entitlements: 'entitlements.json',
  'feature-flags': 'feature-flags.json',
  credits: 'credits.json',
  content: 'content.json',
  publishing: 'publishing.json',
  onboarding: 'onboarding.json',
  assets: 'assets.json',
  'integrations.email': 'integrations-email.json',
};

function productionDocs(): Docs {
  const docs: Docs = {};
  for (const [domain, file] of Object.entries(FILES) as [ConfigDomain, string][]) {
    docs[domain] = parseConfigPayload(
      domain,
      JSON.parse(read(`docs/production-config/${file}`)),
    ) as unknown as Record<string, unknown>;
  }
  docs['brand-brain'] = parseConfigPayload('brand-brain', {}) as unknown as Record<string, unknown>;
  return docs;
}

function context(locale: string, variants: Record<string, number> = {}): AreaContext {
  const t = areaCopy(locale);
  return {
    locale,
    t: (key, values) => t(key, values),
    customersPerPlan: { starter: 3 },
    variantsPerPlatform: variants,
    currencies: ['USD'],
  };
}

const form = (values: Record<string, string | string[]>) => sourceOf(values);

describe('the audit diff records every changed value old -> new', () => {
  it('matches keyed lists by key, so an insertion is not every entry changing', () => {
    const before = {
      plans: [
        { key: 'a', credits: 1 },
        { key: 'b', credits: 2 },
      ],
    };
    const after = {
      plans: [
        { key: 'new', credits: 9 },
        { key: 'a', credits: 1 },
        { key: 'b', credits: 3 },
      ],
    };
    const { changes, truncated } = configLeafDiff(before, after);
    expect(truncated).toBe(false);
    expect(changes).toEqual([
      { path: 'plans[b].credits', before: 2, after: 3 },
      { path: 'plans[new]', before: null, after: { key: 'new', credits: 9 } },
    ]);
  });

  it('never copies a value whose name looks like a credential', () => {
    const { changes } = configLeafDiff({ apiKey: 'old-value' }, { apiKey: 'new-value' });
    expect(changes).toEqual([{ path: 'apiKey', before: '(changed)', after: '(changed)' }]);
  });

  it('is bounded and says so', () => {
    const before = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    const after = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i + 1]));
    const diff = configLeafDiff(before, after, 4);
    expect(diff.changes).toHaveLength(4);
    expect(diff.truncated).toBe(true);
  });
});

describe('fields are read by kind, refused in plain words, in the reader’s language', () => {
  const number: FieldSpec = {
    id: 'n',
    kind: 'number',
    label: 'plans.f.trialCredits',
    help: 'plans.h.trialCredits',
    min: 0,
    max: 10,
    unlimited: true,
  };

  it('accepts a whole number, and "No limit" as null', () => {
    expect(parseFields([number], form({ 'f.n': '7' }), context('en')).values).toEqual({ n: 7 });
    expect(parseFields([number], form({ 'f.n.none': 'on' }), context('en')).values).toEqual({
      n: null,
    });
  });

  it('refuses what does not fit, naming the field, in English and Arabic', () => {
    expect(parseFields([number], form({ 'f.n': '11' }), context('en')).errors['n']).toBe(
      'Trial credits: it must be at most 10.',
    );
    expect(parseFields([number], form({ 'f.n': '2.5' }), context('en')).errors['n']).toBe(
      'Trial credits: please enter a whole number, like 12.',
    );
    expect(parseFields([number], form({ 'f.n': '-1' }), context('ar')).errors['n']).toBe(
      'رصيد التجربة: يُرجى إدخال رقم صحيح، مثل 12.',
    );
  });

  it('reads times of day as a sorted, de-duplicated list', () => {
    const times: FieldSpec = {
      id: 't',
      kind: 'times',
      label: 'ct.f.times',
      help: 'ct.h.times',
      max: 3,
    };
    expect(
      parseFields([times], form({ 'f.t': '18:00, 09:30، 18:00' }), context('en')).values,
    ).toEqual({
      t: ['09:30', '18:00'],
    });
    expect(parseFields([times], form({ 'f.t': '25:00' }), context('en')).errors['t']).toContain(
      '24-hour',
    );
  });
});

describe('an edit becomes the next documents, checked the way the service checks them', () => {
  const docs = productionDocs();
  const config = {};

  it('Trial: the trial plan’s credits change, old -> new, with what customers notice', () => {
    const area = findArea('trial')!;
    const collection = findCollection(area, 'trial')!;
    const ctx = context('en');
    const item = collection.items(docs, ctx)[0]!;
    const edit = prepareEdit({
      collection,
      docs,
      ctx,
      context: config,
      mode: 'edit',
      itemKey: item.key,
      source: form({
        'f.trialDays': String(item.values['trialDays']),
        'f.trialCredits': '777',
        'f.monthlyCredits': String(item.values['monthlyCredits']),
      }),
    });
    if ('missing' in edit) throw new Error('missing');
    expect(edit.problems).toEqual([]);
    expect(edit.changes).toEqual([
      {
        label: 'Trial credits',
        before: `${String(item.values['trialCredits'])} credits`,
        after: '777 credits',
      },
    ]);
    expect(edit.impacts).toEqual([ctx.t('plans.p.trial')]);
    const plan = (edit.after.plans?.['plans'] as Record<string, unknown>[]).find(
      (p) => p['key'] === item.key,
    );
    expect(plan?.['trialCredits']).toBe(777);
  });

  it('Plans: a new plan with a short name already in use is refused', () => {
    const area = findArea('plans')!;
    const collection = findCollection(area, 'plans')!;
    const ctx = context('en');
    const fields = collection.fields(docs, ctx, 'new', null);
    const values: Record<string, string> = {};
    for (const field of fields) {
      if (field.kind === 'number') values[`f.${field.id}`] = '1';
      if (field.kind === 'text') values[`f.${field.id}`] = 'x';
      if (field.kind === 'choice') values[`f.${field.id}`] = field.options?.[0]?.value ?? '';
      if (field.kind === 'money') values[`f.${field.id}.USD`] = '1';
    }
    values['f.key'] = 'starter';
    const edit = prepareEdit({
      collection,
      docs,
      ctx,
      context: config,
      mode: 'new',
      itemKey: null,
      source: form(values),
    });
    if ('missing' in edit) throw new Error('missing');
    expect(edit.fieldErrors['key']).toBe(ctx.t('v.keyTaken'));
  });

  it('Channels: a channel with posts cannot be hidden', () => {
    const collection = findCollection(findArea('channels')!, 'channels')!;
    const ctx = context('en', { instagram: 3 });
    const archive = prepareArchive({
      collection,
      docs,
      ctx,
      context: config,
      itemKey: 'instagram',
    });
    expect(archive?.problems.join(' ')).toContain('cannot be hidden: 3 posts');
  });

  it('Uploads: scanning cannot be required while it is off', () => {
    const collection = findCollection(findArea('uploads')!, 'scanning')!;
    const ctx = context('en');
    const edit = prepareEdit({
      collection,
      docs,
      ctx,
      context: config,
      mode: 'edit',
      itemKey: 'scanning',
      source: form({ 'f.provider': 'none', 'f.required': 'on', 'f.endpoint': '' }),
    });
    if ('missing' in edit) throw new Error('missing');
    expect(edit.problems).toContain(ctx.t('up.r.noneRequired'));
  });

  it('Sign-ups: a shorter password than 8 is refused before anything is written', () => {
    const collection = findCollection(findArea('signups')!, 'signups')!;
    const ctx = context('en');
    const edit = prepareEdit({
      collection,
      docs,
      ctx,
      context: config,
      mode: 'edit',
      itemKey: 'signups',
      source: form({ 'f.open': 'on', 'f.minPasswordLength': '7', 'f.mfaOffered': 'on' }),
    });
    if ('missing' in edit) throw new Error('missing');
    expect(edit.fieldErrors['minPasswordLength']).toBe('Shortest password: it must be at least 8.');
    expect(edit.after).toBe(docs);
  });

  it('every area opens on the production documents in both languages, each card with a title', () => {
    for (const locale of ['en', 'ar']) {
      const ctx = context(locale);
      for (const area of AREAS) {
        for (const collection of area.collections) {
          for (const item of collection.items(docs, ctx))
            expect(item.title, `${area.key}/${item.key}`).not.toBe('');
          expect(collection.fields(docs, ctx, 'edit', null).length).toBeGreaterThan(0);
        }
        for (const setting of area.developer) expect(setting.value(docs, ctx)).not.toBe('');
      }
    }
  });

  it('opening any card and checking without changing anything changes nothing', async () => {
    const { toQuery } = await import('../../apps/admin/src/server/simple-areas/fields');
    const ctx = { ...context('en'), currencies: ['USD', 'SAR'] };
    const offenders: string[] = [];
    for (const area of AREAS) {
      for (const collection of area.collections) {
        for (const item of collection.items(docs, ctx)) {
          const fields = collection.fields(docs, ctx, 'edit', item.key);
          const edit = prepareEdit({
            collection,
            docs,
            ctx,
            context: config,
            mode: 'edit',
            itemKey: item.key,
            source: sourceOf(toQuery(fields, item.values)),
          });
          if ('missing' in edit) offenders.push(`${area.key}/${item.key}: missing`);
          else if (Object.keys(edit.fieldErrors).length > 0)
            offenders.push(`${area.key}/${item.key}: ${JSON.stringify(edit.fieldErrors)}`);
          else if (!edit.unchanged) {
            const changed = Object.keys(edit.after).filter(
              (d) =>
                JSON.stringify(edit.after[d as ConfigDomain]) !==
                JSON.stringify(docs[d as ConfigDomain]),
            );
            const detail = changed.map((d) =>
              configLeafDiff(docs[d as ConfigDomain], edit.after[d as ConfigDomain])
                .changes.map((c) => c.path)
                .join(','),
            );
            offenders.push(`${area.key}/${item.key}: ${detail.join(' | ')}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the Arabic copy has every English sentence, and no domain key leaks into either', () => {
    expect(Object.keys(AREA_COPY.ar).sort()).toEqual(Object.keys(AREA_COPY.en).sort());
    for (const text of [...Object.values(AREA_COPY.en), ...Object.values(AREA_COPY.ar)]) {
      expect(text).not.toMatch(/\b(?:onboarding|publishing|entitlements|feature-flags)\.[a-z]/);
    }
  });
});

describe('Simple writes through the Configuration Service only (D-312)', () => {
  function sources(dir: string): string[] {
    return readdirSync(path.join(ROOT, dir)).flatMap((name) => {
      const file = path.join(dir, name);
      return statSync(path.join(ROOT, file)).isDirectory() ? sources(file) : [file];
    });
  }

  it('no card-page file writes configuration rows itself', () => {
    const files = [
      ...sources('apps/admin/src/server/simple-areas'),
      'apps/admin/src/app/[locale]/console/manage/actions.ts',
      'apps/admin/src/components/simple/area.tsx',
    ];
    for (const file of files) {
      const source = read(file);
      expect(source, file).not.toMatch(/configurationVersion\.(create|update|upsert|delete)/);
      expect(source, file).not.toMatch(/\$executeRaw|\$queryRaw/);
    }
    // The one writer is the existing lifecycle helper.
    expect(read('apps/admin/src/server/simple-areas/runtime.ts')).toContain('proposeAndActivate');
  });
});

/**
 * NO STORED KEY ON AN OWNER PAGE (owner review of the card pages): a plan by
 * the name customers see, a limit by its plain name, a document by what it is
 * about, a stored choice by what it means and a number by its unit — in both
 * languages. The end-to-end suite reads the pages; this reads the words.
 */
describe('Simple pages name things in plain words, never by their stored keys', () => {
  const QUOTAS = [
    'seats',
    'brands',
    'workspaces',
    'socialAccounts',
    'scheduledPostsPerMonth',
    'storageGb',
    'analyticsRetentionDays',
  ];
  const RAW_CHOICES = /\b(?:exclusive|inclusive|fifo_by_expiry|capped|msa|gulf|egyptian)\b/;
  const UNIT_ABBREVIATION = /\d (?:s|d|min|px)\b/;

  it('every configuration document has a plain name, never its id, in both languages', () => {
    for (const locale of ['en', 'ar']) {
      for (const domain of CONFIG_DOMAIN_KEYS) {
        const name = domainName(locale, domain);
        // An id that is an ordinary word ("publishing") may read as itself in English.
        if (locale === 'ar' || /[.-]/.test(domain))
          expect(name, `${locale} ${domain}`).not.toBe(domain);
        if (domain.includes('.') || domain.includes('-')) expect(name).not.toContain(domain);
        if (locale === 'ar') expect(name, domain).not.toMatch(/[a-z]{3,}/);
        if (domain.includes('.') || domain.includes('-') || locale === 'ar')
          expect(pendingName(locale, domain), `${locale} ${domain}`).not.toContain(domain);
      }
    }
    expect(pendingName('en', 'usage-limits')).toBe('technical settings (usage limits)');
    expect(pendingName('ar', 'usage-limits')).toBe('إعدادات تقنية (حدود الاستخدام)');
  });

  it('the trial row names the plan and its unset limits plainly', () => {
    const detail = {
      plan: 'fixture-starter',
      planEn: 'Fixture Starter',
      planAr: 'المبتدئ',
      days: '14',
      credits: '200',
      quotas: QUOTAS.join(', '),
    };
    const en = plainDetail('en', detail);
    expect(en['plan']).toBe('Fixture Starter');
    expect(en['quotas']).toBe(QUOTAS.map((quota) => quotaName('en', quota)).join(', '));
    for (const quota of QUOTAS.filter((q) => /[A-Z]/.test(q))) {
      expect(en['quotas']).not.toContain(quota);
    }
    const ar = plainDetail('ar', detail);
    expect(ar['plan']).toBe('المبتدئ');
    expect(ar['quotas']).not.toMatch(/[a-z]/);
  });

  it('"Changed by your developer" shows no plan key, raw choice or unit abbreviation', () => {
    const docs = productionDocs();
    const planKeys = (docs.plans?.['plans'] as { key: string }[]).map((plan) => plan.key);
    expect(planKeys.length).toBeGreaterThan(0);
    for (const locale of ['en', 'ar']) {
      const ctx = context(locale);
      for (const area of AREAS) {
        for (const row of area.developer ?? []) {
          const value = row.value(docs, ctx);
          const label = `${locale} ${area.key} ${row.label}`;
          for (const key of planKeys) expect(value, label).not.toMatch(new RegExp(`\\b${key}\\b`));
          expect(value, label).not.toMatch(RAW_CHOICES);
          expect(value, label).not.toMatch(UNIT_ABBREVIATION);
          for (const domain of CONFIG_DOMAIN_KEYS.filter((d) => /[.-]/.test(d))) {
            expect(value, label).not.toContain(domain);
          }
        }
      }
    }
    const plans = findArea('plans')!;
    const tax = plans.developer!.find((row) => row.label === 'plans.d.tax')!;
    expect(tax.value(docs, context('en'))).toMatch(/^Starter: /);
  });

  it('Change history reads a change through the card, not as a stored path', () => {
    const docs = productionDocs();
    const before = docs.plans!;
    const after = structuredClone(before) as { plans: { key: string; monthlyCredits: number }[] };
    after.plans[0]!.monthlyCredits = 999;
    const change = plainChange({
      domain: 'plans',
      before,
      after: after as unknown as Record<string, unknown>,
      docs,
      ctx: context('en'),
    });
    expect(change.area?.key).toBe('plans');
    expect(change.lines.map((line) => `${line.label}: ${line.before} → ${line.after}`)).toContain(
      'Starter: Monthly credits: ' +
        `${(before['plans'] as { monthlyCredits: number }[])[0]!.monthlyCredits} credits → 999 credits`,
    );
    for (const line of change.lines) expect(line.label).not.toContain('plans[');
  });
});
