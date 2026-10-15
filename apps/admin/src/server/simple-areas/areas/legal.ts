import type { AreaSpec, CollectionSpec, Docs, FieldSpec, ItemView } from '../types';
import { arrayOf, bool, rec, str, upsertBy } from '../json';

/**
 * LEGAL PAGES — one card per document a person accepts at sign-up: the
 * version they accept and the owner's mark that a lawyer has reviewed it
 * (PR F, Q11). The TEXT of the pages is the developer's
 * (`apps/dashboard/src/legal/documents.ts`), so is the version printed on them
 * (`LEGAL_VERSION`): publishing new text means the developer raising both, and
 * the help says so rather than letting the two drift silently.
 */

const documents = (docs: Docs) => arrayOf(docs.onboarding?.['legalDocuments']).map(rec);

const fields: readonly FieldSpec[] = [
  {
    id: 'version',
    kind: 'text',
    label: 'lg.f.version',
    help: 'lg.h.version',
    impact: 'lg.i.version',
    required: true,
    maxLength: 32,
    dir: 'ltr',
  },
  {
    id: 'reviewed',
    kind: 'switch',
    label: 'lg.f.reviewed',
    help: 'lg.h.reviewed',
    impact: 'lg.i.reviewed',
  },
];

const collection: CollectionSpec = {
  id: 'documents',
  title: 'lg.title',
  domains: ['onboarding'],
  fields: () => fields,
  keyOf: (_values, _mode, itemKey) => itemKey ?? '',
  items: (docs, ctx): readonly ItemView[] =>
    documents(docs).map((doc) => {
      const title = rec(doc['title']);
      const reviewed = bool(doc['reviewed']);
      return {
        key: str(doc['key']),
        title: str(ctx.locale === 'ar' ? title['ar'] : title['en']) || str(doc['key']),
        status: reviewed
          ? { label: ctx.t('lg.s.reviewed'), tone: 'success' }
          : { label: ctx.t('lg.s.pending'), tone: 'warning' },
        facts: [
          { label: ctx.t('lg.f.version'), value: str(doc['version']) || '—' },
          {
            label: ctx.t('lg.c.required'),
            value: ctx.t(doc['required'] === false ? 'w.no' : 'w.yes'),
          },
        ],
        values: { version: str(doc['version']), reviewed },
      } satisfies ItemView;
    }),
  apply: (docs, _ctx, { itemKey, values }) => {
    const existing = documents(docs).find((doc) => str(doc['key']) === itemKey);
    if (!existing) return {};
    return {
      onboarding: {
        ...docs.onboarding,
        legalDocuments: upsertBy(
          documents(docs),
          'key',
          { ...existing, version: values['version'], reviewed: values['reviewed'] },
          itemKey,
        ),
      },
    };
  },
  impact: (before, after, ctx, itemKey) => {
    const was = documents(before).find((doc) => str(doc['key']) === itemKey);
    const now = documents(after).find((doc) => str(doc['key']) === itemKey);
    const out: string[] = [];
    if (str(was?.['version']) !== str(now?.['version'])) out.push(ctx.t('lg.p.version'));
    if (bool(was?.['reviewed']) !== bool(now?.['reviewed']))
      out.push(ctx.t(bool(now?.['reviewed']) ? 'lg.p.reviewed' : 'lg.p.unreviewed'));
    return out.length > 0 ? out : [ctx.t('w.noCustomerChange')];
  },
  slices: (itemKey) => [
    {
      domain: 'onboarding',
      read: (doc) => {
        const entry = arrayOf(doc['legalDocuments'])
          .map(rec)
          .find((d) => str(d['key']) === itemKey);
        return entry ? { version: entry['version'], reviewed: entry['reviewed'] } : undefined;
      },
      write: (doc, value) => {
        const list = arrayOf(doc['legalDocuments']).map(rec);
        const entry = list.find((d) => str(d['key']) === itemKey);
        if (!entry || value === undefined) return doc;
        return {
          ...doc,
          legalDocuments: upsertBy(list, 'key', { ...entry, ...rec(value) }, itemKey),
        };
      },
    },
  ],
};

export const legalArea: AreaSpec = {
  key: 'legal',
  title: 'lg.title',
  intro: 'lg.intro',
  href: (locale) => `/${locale}/console/manage/legal`,
  collections: [collection],
  developer: [
    { label: 'lg.d.text', value: (_docs, ctx) => ctx.t('lg.d.textValue') },
    {
      label: 'lg.d.required',
      value: (docs) =>
        documents(docs)
          .filter((doc) => doc['required'] !== false)
          .length.toString(),
    },
    {
      label: 'lg.d.links',
      value: (docs) =>
        documents(docs)
          .map((doc) => str(rec(doc['url'])['en']) || '—')
          .join(' · ') || '—',
    },
  ],
};
