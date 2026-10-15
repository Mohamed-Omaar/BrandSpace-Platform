import { findIntegration } from '@brandspace/integrations';
import type { AreaSpec, CollectionSpec, Docs, FieldSpec, ItemView } from '../types';
import { arrayOf, rec, str, upsertBy } from '../json';

/**
 * EMAIL — the name and address every customer email is sent from, per email
 * provider that has a sender (`integrations.email` → `settings.fromName`,
 * `settings.fromEmail`, the same two values the guided set-up edits). Saving
 * them changes neither the provider's status nor which provider is active —
 * the guided set-up's own rule. The key, the Test and switching a provider on
 * stay in the guided set-up.
 */

const providers = (docs: Docs) => arrayOf(docs['integrations.email']?.['providers']).map(rec);

const hasSender = (key: string) =>
  findIntegration('email', key)?.settingFields?.some((field) => field.key === 'fromEmail') === true;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fields: readonly FieldSpec[] = [
  { id: 'fromName', kind: 'text', label: 'em.f.name', help: 'em.h.name', impact: 'em.i.sender', maxLength: 100 },
  { id: 'fromEmail', kind: 'text', label: 'em.f.address', help: 'em.h.address', impact: 'em.i.sender', required: true, maxLength: 200, dir: 'ltr', pattern: EMAIL, patternMessage: 'em.v.address' },
];

const senders: CollectionSpec = {
  id: 'senders',
  title: 'em.s.title',
  domains: ['integrations.email'],
  fields: () => fields,
  keyOf: (_values, _mode, itemKey) => itemKey ?? '',
  items: (docs, ctx): readonly ItemView[] => {
    const active = str(docs['integrations.email']?.['activeProviderKey']);
    return providers(docs)
      .filter((provider) => hasSender(str(provider['key'])))
      .map((provider) => {
        const key = str(provider['key']);
        const settings = rec(provider['settings']);
        const status = str(provider['status']);
        return {
          key,
          title: str(provider['name']) || key,
          status:
            key === active && status === 'active'
              ? { label: ctx.t('em.st.sending'), tone: 'success' }
              : status === 'active'
                ? { label: ctx.t('em.st.ready'), tone: 'info' }
                : { label: ctx.t('em.st.notSetUp'), tone: 'neutral' },
          facts: [
            { label: ctx.t('em.f.name'), value: str(settings['fromName']) || ctx.t('w.notSet') },
            { label: ctx.t('em.f.address'), value: str(settings['fromEmail']) || ctx.t('w.notSet') },
          ],
          values: { fromName: str(settings['fromName']), fromEmail: str(settings['fromEmail']) },
        } satisfies ItemView;
      });
  },
  apply: (docs, _ctx, { itemKey, values }) => {
    const list = providers(docs);
    const provider = list.find((p) => str(p['key']) === itemKey);
    if (!provider) return {};
    const settings: Record<string, unknown> = { ...rec(provider['settings']), fromEmail: values['fromEmail'] };
    if (values['fromName'] === '') delete settings['fromName'];
    else settings['fromName'] = values['fromName'];
    return {
      'integrations.email': {
        ...docs['integrations.email'],
        providers: upsertBy(list, 'key', { ...provider, settings }, itemKey),
      },
    };
  },
  impact: (_before, _after, ctx) => [ctx.t('em.i.sender')],
  slices: (itemKey) => [
    {
      domain: 'integrations.email',
      read: (doc) => {
        const provider = arrayOf(doc['providers']).map(rec).find((p) => str(p['key']) === itemKey);
        if (!provider) return undefined;
        const settings = rec(provider['settings']);
        return { fromName: settings['fromName'] ?? null, fromEmail: settings['fromEmail'] ?? null };
      },
      write: (doc, value) => {
        const list = arrayOf(doc['providers']).map(rec);
        const provider = list.find((p) => str(p['key']) === itemKey);
        if (!provider || value === undefined) return doc;
        const v = rec(value);
        const settings = { ...rec(provider['settings']) };
        for (const key of ['fromName', 'fromEmail'] as const) {
          if (v[key] === null || v[key] === undefined) delete settings[key];
          else settings[key] = v[key];
        }
        return { ...doc, providers: upsertBy(list, 'key', { ...provider, settings }, itemKey) };
      },
    },
  ],
};

export const emailArea: AreaSpec = {
  key: 'email',
  title: 'em.title',
  intro: 'em.intro',
  href: (locale) => `/${locale}/console/manage/email`,
  collections: [senders],
  guided: [{ label: 'em.g.resend', href: '/console/integrations/email/resend' }],
  developer: [
    { label: 'em.d.key', value: (_docs, ctx) => ctx.t('up.d.keysValue') },
    { label: 'em.d.replyTo', value: (docs) => providers(docs).map((p) => str(rec(p['settings'])['replyTo'])).filter(Boolean).join(' · ') || '—' },
    { label: 'em.d.active', value: (docs) => str(docs['integrations.email']?.['activeProviderKey']) || '—' },
  ],
};
