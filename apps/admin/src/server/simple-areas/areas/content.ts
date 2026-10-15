import type { AreaContext, AreaSpec, CollectionSpec, Docs, FieldSpec, ItemView } from '../types';
import { arrayOf, bool, num, rec, str, upsertBy } from '../json';
import { CHANNEL_NAMES } from './channels';

/**
 * CONTENT — the lists the customer's writing tools offer:
 *
 *  - INDUSTRIES (`onboarding.industries`): what set-up and Settings offer for
 *    "Industry", each naming the Brand Brain question set it uses. Removing
 *    one does not touch a brand that chose it: the brand keeps the word it
 *    saved, shown as its own text (`industry-field.tsx`).
 *  - SUGGESTED POSTING TIMES per country (`content.calendar.suggestedTimes`):
 *    shown as "Suggested time" where no measured time exists (D-329).
 *  - EACH CHANNEL'S WRITING HELP (`content.platforms[]`): the recommended
 *    hashtag range (D-496) and the safe zones drawn on a 9:16 preview (S38).
 *    Hidden channels have none to edit; showing a channel is the Channels area.
 */

const industries = (docs: Docs) => arrayOf(docs.onboarding?.['industries']).map(rec);
const calendar = (docs: Docs) => rec(docs.content?.['calendar']);
const suggested = (docs: Docs) => arrayOf(calendar(docs)['suggestedTimes']).map(rec);
const platforms = (docs: Docs) => arrayOf(docs.content?.['platforms']).map(rec);

/** The Brand Brain question sets an industry may name. */
function questionSets(docs: Docs): readonly string[] {
  return Object.keys(rec(rec(docs['brand-brain']?.['questions'])['offersSets'])).sort();
}

const KEY = /^[a-z][a-z0-9_-]{0,39}$/;

const industryFields = (docs: Docs, _ctx: AreaContext, _mode: string, itemKey: string | null): readonly FieldSpec[] => {
  const current = itemKey ? str(industries(docs).find((i) => str(i['key']) === itemKey)?.['offersQuestionSet']) : '';
  const sets = [...new Set([...questionSets(docs), ...(current ? [current] : [])])];
  return [
    { id: 'key', kind: 'text', label: 'ct.f.key', help: 'ct.h.key', required: true, maxLength: 40, dir: 'ltr', lockedOnEdit: true, pattern: KEY, patternMessage: 'v.key' },
    { id: 'nameEn', kind: 'text', label: 'ct.f.nameEn', help: 'ct.h.name', impact: 'ct.i.name', required: true, maxLength: 80, dir: 'ltr' },
    { id: 'nameAr', kind: 'text', label: 'ct.f.nameAr', help: 'ct.h.name', impact: 'ct.i.name', required: true, maxLength: 80, dir: 'rtl' },
    {
      id: 'questionSet',
      kind: 'choice',
      label: 'ct.f.questions',
      help: 'ct.h.questions',
      impact: 'ct.i.questions',
      options: sets.map((set) => ({ value: set, label: { literal: set } })),
    },
  ];
};

const industryCollection: CollectionSpec = {
  id: 'industries',
  title: 'ct.ind.title',
  intro: 'ct.ind.intro',
  domains: ['onboarding', 'brand-brain'],
  canCreate: true,
  canDuplicate: true,
  archiveLabel: 'a.remove',
  fields: industryFields,
  keyOf: (values, mode, itemKey) => (mode === 'edit' ? (itemKey ?? '') : str(values['key'])),
  items: (docs, ctx): readonly ItemView[] =>
    industries(docs).map((industry) => {
      const name = rec(industry['name']);
      return {
        key: str(industry['key']),
        title: str(ctx.locale === 'ar' ? name['ar'] : name['en']) || str(industry['key']),
        subtitle: str(ctx.locale === 'ar' ? name['en'] : name['ar']),
        facts: [{ label: ctx.t('ct.f.questions'), value: str(industry['offersQuestionSet']) || '—' }],
        values: {
          key: str(industry['key']),
          nameEn: str(name['en']),
          nameAr: str(name['ar']),
          questionSet: str(industry['offersQuestionSet']),
        },
      } satisfies ItemView;
    }),
  apply: (docs, _ctx, { mode, itemKey, values }) => {
    const key = mode === 'edit' ? (itemKey ?? '') : str(values['key']);
    const existing = mode === 'edit' ? industries(docs).find((i) => str(i['key']) === itemKey) : undefined;
    const entry = {
      ...existing,
      key,
      name: { en: values['nameEn'], ar: values['nameAr'] },
      offersQuestionSet: values['questionSet'],
    };
    return {
      onboarding: { ...docs.onboarding, industries: upsertBy(industries(docs), 'key', entry, mode === 'edit' ? itemKey : null) },
    };
  },
  archive: (docs, _ctx, itemKey) => ({
    onboarding: { ...docs.onboarding, industries: industries(docs).filter((i) => str(i['key']) !== itemKey) },
  }),
  check: (_before, after, ctx, { itemKey }) => {
    const entry = industries(after).find((i) => str(i['key']) === itemKey);
    if (!entry) return [];
    return questionSets(after).includes(str(entry['offersQuestionSet'])) ? [] : [ctx.t('ct.r.noSet')];
  },
  impact: (before, after, ctx, itemKey) => {
    const was = industries(before).some((i) => str(i['key']) === itemKey);
    const now = industries(after).some((i) => str(i['key']) === itemKey);
    if (!was && now) return [ctx.t('ct.p.added')];
    if (was && !now) return [ctx.t('ct.p.removed')];
    return [ctx.t('ct.i.name')];
  },
  slices: (itemKey) => [
    {
      domain: 'onboarding',
      read: (doc) => arrayOf(doc['industries']).map(rec).find((i) => str(i['key']) === itemKey),
      write: (doc, value) => {
        const list = arrayOf(doc['industries']).map(rec);
        return {
          ...doc,
          industries: value === undefined ? list.filter((i) => str(i['key']) !== itemKey) : upsertBy(list, 'key', rec(value), itemKey),
        };
      },
    },
  ],
};

function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale === 'ar' ? 'ar' : 'en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

const timeFields: readonly FieldSpec[] = [
  { id: 'country', kind: 'text', label: 'ct.f.country', help: 'ct.h.country', required: true, maxLength: 2, dir: 'ltr', lockedOnEdit: true, pattern: /^[A-Za-z]{2}$/, patternMessage: 'ct.v.country' },
  { id: 'times', kind: 'times', label: 'ct.f.times', help: 'ct.h.times', impact: 'ct.i.times', max: 6 },
];

const timesCollection: CollectionSpec = {
  id: 'times',
  title: 'ct.t.title',
  intro: 'ct.t.intro',
  domains: ['content'],
  canCreate: true,
  canDuplicate: false,
  archiveLabel: 'a.remove',
  fields: () => timeFields,
  keyOf: (values, mode, itemKey) => (mode === 'edit' ? (itemKey ?? '') : str(values['country']).toUpperCase()),
  items: (docs, ctx): readonly ItemView[] =>
    suggested(docs).map((row) => {
      const country = str(row['country']).toUpperCase();
      const times = arrayOf(row['times']).map(str);
      return {
        key: country,
        title: countryName(country, ctx.locale),
        subtitle: country,
        facts: [{ label: ctx.t('ct.f.times'), value: times.join(ctx.locale === 'ar' ? '، ' : ', ') }],
        values: { country, times },
      } satisfies ItemView;
    }),
  apply: (docs, _ctx, { mode, itemKey, values }) => {
    const country = mode === 'edit' ? (itemKey ?? '') : str(values['country']).toUpperCase();
    const list = suggested(docs);
    const index = list.findIndex((row) => str(row['country']).toUpperCase() === (mode === 'edit' ? itemKey : country));
    const entry = { country, times: values['times'] };
    const next = index < 0 ? [...list, entry] : list.map((row, at) => (at === index ? entry : row));
    return { content: { ...docs.content, calendar: { ...calendar(docs), suggestedTimes: next } } };
  },
  archive: (docs, _ctx, itemKey) => ({
    content: {
      ...docs.content,
      calendar: { ...calendar(docs), suggestedTimes: suggested(docs).filter((row) => str(row['country']).toUpperCase() !== itemKey) },
    },
  }),
  impact: (before, after, ctx, itemKey) => {
    const was = suggested(before).some((row) => str(row['country']).toUpperCase() === itemKey);
    const now = suggested(after).some((row) => str(row['country']).toUpperCase() === itemKey);
    if (was && !now) return [ctx.t('ct.p.timesRemoved')];
    return [ctx.t('ct.i.times')];
  },
  slices: (itemKey) => [
    {
      domain: 'content',
      read: (doc) => arrayOf(rec(doc['calendar'])['suggestedTimes']).map(rec).find((row) => str(row['country']).toUpperCase() === itemKey),
      write: (doc, value) => {
        const cal = rec(doc['calendar']);
        const list = arrayOf(cal['suggestedTimes']).map(rec);
        const index = list.findIndex((row) => str(row['country']).toUpperCase() === itemKey);
        const next =
          value === undefined
            ? list.filter((_, at) => at !== index)
            : index < 0
              ? [...list, rec(value)]
              : list.map((row, at) => (at === index ? rec(value) : row));
        return { ...doc, calendar: { ...cal, suggestedTimes: next } };
      },
    },
  ],
};

const writingFields = (docs: Docs, _ctx: AreaContext, _mode: string, itemKey: string | null): readonly FieldSpec[] => {
  const entry = platforms(docs).find((p) => str(p['key']) === itemKey);
  const ceiling = Math.min(100, num(entry?.['maxHashtags']) ?? 100);
  return [
    { id: 'hashtagsOn', kind: 'switch', label: 'ct.f.hashtagsOn', help: 'ct.h.hashtagsOn', impact: 'ct.i.hashtags' },
    { id: 'hashtagsMin', kind: 'number', label: 'ct.f.hashtagsMin', help: 'ct.h.hashtagsRange', impact: 'ct.i.hashtags', unit: 'u.hashtags', min: 0, max: ceiling },
    { id: 'hashtagsMax', kind: 'number', label: 'ct.f.hashtagsMax', help: 'ct.h.hashtagsRange', impact: 'ct.i.hashtags', unit: 'u.hashtags', min: 0, max: ceiling },
    { id: 'safeOn', kind: 'switch', label: 'ct.f.safeOn', help: 'ct.h.safeOn', impact: 'ct.i.safe' },
    { id: 'safeTop', kind: 'number', label: 'ct.f.safeTop', help: 'ct.h.safeBand', impact: 'ct.i.safe', unit: 'u.percent', min: 0, max: 50 },
    { id: 'safeBottom', kind: 'number', label: 'ct.f.safeBottom', help: 'ct.h.safeBand', impact: 'ct.i.safe', unit: 'u.percent', min: 0, max: 50 },
    { id: 'safeEnd', kind: 'number', label: 'ct.f.safeEnd', help: 'ct.h.safeBand', impact: 'ct.i.safe', unit: 'u.percent', min: 0, max: 50 },
  ];
};

const writingCollection: CollectionSpec = {
  id: 'writing',
  title: 'ct.w.title',
  intro: 'ct.w.intro',
  domains: ['content'],
  fields: writingFields,
  keyOf: (_values, _mode, itemKey) => itemKey ?? '',
  items: (docs, ctx): readonly ItemView[] =>
    platforms(docs).map((entry) => {
      const key = str(entry['key']);
      const range = entry['recommendedHashtags'] === undefined ? null : rec(entry['recommendedHashtags']);
      const zones = entry['safeZones'] === undefined ? null : rec(entry['safeZones']);
      return {
        key,
        title: CHANNEL_NAMES[key] ?? key,
        facts: [
          { label: ctx.t('ct.c.hashtags'), value: range ? `${num(range['min']) ?? 0}–${num(range['max']) ?? 0}` : ctx.t('w.notSet') },
          { label: ctx.t('ct.c.ceiling'), value: String(num(entry['maxHashtags']) ?? '—') },
          {
            label: ctx.t('ct.c.safe'),
            value: zones
              ? ctx.t('ct.c.safeValue', { top: num(zones['top']) ?? 0, bottom: num(zones['bottom']) ?? 0, end: num(zones['end']) ?? 0 })
              : ctx.t('w.notSet'),
          },
        ],
        values: {
          hashtagsOn: range !== null,
          hashtagsMin: num(range?.['min']) ?? 0,
          hashtagsMax: num(range?.['max']) ?? Math.min(num(entry['maxHashtags']) ?? 0, 5),
          safeOn: zones !== null,
          safeTop: num(zones?.['top']) ?? 0,
          safeBottom: num(zones?.['bottom']) ?? 0,
          safeEnd: num(zones?.['end']) ?? 0,
        },
      } satisfies ItemView;
    }),
  apply: (docs, _ctx, { itemKey, values }) => {
    const list = platforms(docs);
    const existing = list.find((p) => str(p['key']) === itemKey);
    if (!existing) return {};
    const { recommendedHashtags: _range, safeZones: _zones, ...rest } = existing;
    const entry = {
      ...rest,
      ...(values['hashtagsOn'] === true ? { recommendedHashtags: { min: values['hashtagsMin'], max: values['hashtagsMax'] } } : {}),
      ...(values['safeOn'] === true ? { safeZones: { top: values['safeTop'], bottom: values['safeBottom'], end: values['safeEnd'] } } : {}),
    };
    return { content: { ...docs.content, platforms: upsertBy(list, 'key', entry, itemKey) } };
  },
  check: (_before, after, ctx, { itemKey }) => {
    const entry = platforms(after).find((p) => str(p['key']) === itemKey);
    const range = entry?.['recommendedHashtags'] === undefined ? null : rec(entry['recommendedHashtags']);
    if (!range) return [];
    const errors: string[] = [];
    if ((num(range['min']) ?? 0) > (num(range['max']) ?? 0)) errors.push(ctx.t('v.rangeOrder'));
    if ((num(range['max']) ?? 0) > (num(entry?.['maxHashtags']) ?? 0)) errors.push(ctx.t('v.hashtagCeiling'));
    return errors;
  },
  impact: (before, after, ctx, itemKey) => {
    const was = platforms(before).find((p) => str(p['key']) === itemKey);
    const now = platforms(after).find((p) => str(p['key']) === itemKey);
    const out: string[] = [];
    if (JSON.stringify(was?.['recommendedHashtags']) !== JSON.stringify(now?.['recommendedHashtags'])) out.push(ctx.t('ct.i.hashtags'));
    if (JSON.stringify(was?.['safeZones']) !== JSON.stringify(now?.['safeZones'])) out.push(ctx.t('ct.i.safe'));
    return out.length > 0 ? out : [ctx.t('w.noCustomerChange')];
  },
  slices: (itemKey) => [
    {
      domain: 'content',
      read: (doc) => {
        const entry = arrayOf(doc['platforms']).map(rec).find((p) => str(p['key']) === itemKey);
        return entry ? { recommendedHashtags: entry['recommendedHashtags'] ?? null, safeZones: entry['safeZones'] ?? null } : undefined;
      },
      write: (doc, value) => {
        const list = arrayOf(doc['platforms']).map(rec);
        const existing = list.find((p) => str(p['key']) === itemKey);
        if (!existing || value === undefined) return doc;
        const v = rec(value);
        const { recommendedHashtags: _range, safeZones: _zones, ...rest } = existing;
        const entry = {
          ...rest,
          ...(v['recommendedHashtags'] ? { recommendedHashtags: v['recommendedHashtags'] } : {}),
          ...(v['safeZones'] ? { safeZones: v['safeZones'] } : {}),
        };
        return { ...doc, platforms: upsertBy(list, 'key', entry, itemKey) };
      },
    },
  ],
};

export const contentArea: AreaSpec = {
  key: 'content',
  title: 'ct.title',
  intro: 'ct.intro',
  href: (locale) => `/${locale}/console/manage/content`,
  collections: [industryCollection, timesCollection, writingCollection],
  developer: [
    { label: 'ct.d.dialects', value: (docs) => arrayOf(rec(docs.content?.['dialects'])['supported']).map((d) => str(rec(d)['key'])).join(' · ') || '—' },
    { label: 'ct.d.horizon', value: (docs) => `${num(calendar(docs)['maxDaysAhead']) ?? '—'} d` },
    { label: 'ct.d.slots', value: (docs) => String(num(calendar(docs)['maxSlotsPerDay']) ?? '—') },
    { label: 'ct.d.approval', value: (docs, ctx) => ctx.t(bool(calendar(docs)['requireApprovalBeforeScheduling']) ? 'w.yes' : 'w.no') },
    { label: 'ct.d.holidays', value: (docs) => String(arrayOf(calendar(docs)['holidays']).length) },
    { label: 'ct.d.observances', value: (docs) => String(arrayOf(calendar(docs)['observances']).length) },
    { label: 'ct.d.questionSets', value: (docs) => questionSets(docs).join(' · ') || '—' },
  ],
};
