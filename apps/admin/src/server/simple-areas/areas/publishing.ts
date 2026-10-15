import type { AreaSpec, CollectionSpec, Docs, FieldSpec, ItemView } from '../types';
import { arrayOf, bool, num, rec, str } from '../json';
import { CHANNEL_NAMES, connectorBuilt } from './channels';

/**
 * PUBLISHING — one card per provider: whether customers may connect and
 * publish, its daily cap, and the guided set-up (URLs to copy, keys, Test,
 * Activate) that already lives on the Integrations screen. Retries are one
 * card for the whole platform, as the setting is.
 *
 * A provider with no connector built (LinkedIn, X today) cannot be switched
 * on: there is nothing to connect to.
 */

const providers = (docs: Docs) => rec(docs.publishing?.['providers']);

function appStatus(docs: Docs, key: string): string {
  const apps = arrayOf(docs['integrations.social-apps']?.['applications']).map(rec);
  const app = apps.find((candidate) => str(candidate['providerKey']) === key);
  const shared = app ? str(app['sharesCredentialWith']) : '';
  const effective = shared
    ? apps.find((candidate) => str(candidate['providerKey']) === shared)
    : app;
  return str(effective?.['status']);
}

const providerFields: readonly FieldSpec[] = [
  {
    id: 'enabled',
    kind: 'switch',
    label: 'pub.f.enabled',
    help: 'pub.h.enabled',
    impact: 'pub.i.enabled',
  },
  {
    id: 'dailyPublishCap',
    kind: 'number',
    label: 'pub.f.cap',
    help: 'pub.h.cap',
    impact: 'pub.i.cap',
    unit: 'u.postsPerDay',
    min: 1,
    max: 1_000,
    unlimited: true,
  },
];

const providerCollection: CollectionSpec = {
  id: 'providers',
  title: 'pub.title',
  domains: ['publishing'],
  reads: ['integrations.social-apps'],
  fields: () => providerFields,
  keyOf: (_values, _mode, itemKey) => itemKey ?? '',
  items: (docs, ctx): readonly ItemView[] =>
    Object.entries(providers(docs)).map(([key, raw]) => {
      const provider = rec(raw);
      const enabled = bool(provider['enabled']);
      const status = appStatus(docs, key);
      return {
        key,
        title: CHANNEL_NAMES[key] ?? key,
        status: !connectorBuilt(key)
          ? { label: ctx.t('ch.c.notBuilt'), tone: 'neutral' }
          : enabled
            ? { label: ctx.t('pub.s.on'), tone: 'success' }
            : { label: ctx.t('pub.s.off'), tone: 'neutral' },
        facts: [
          {
            label: ctx.t('pub.c.setUp'),
            value: !connectorBuilt(key)
              ? ctx.t('ch.c.notBuilt')
              : status === 'active'
                ? ctx.t('pub.c.setUpDone')
                : ctx.t('pub.c.setUpNot'),
          },
          {
            label: ctx.t('pub.f.cap'),
            value:
              num(provider['dailyPublishCap']) === null
                ? ctx.t('w.noLimit')
                : `${num(provider['dailyPublishCap'])} ${ctx.t('u.postsPerDay')}`,
          },
          { label: ctx.t('pub.c.version'), value: str(provider['apiVersion']) || '—' },
        ],
        values: { enabled, dailyPublishCap: num(provider['dailyPublishCap']) },
      } satisfies ItemView;
    }),
  apply: (docs, _ctx, { itemKey, values }) => {
    const key = itemKey ?? '';
    const provider = rec(providers(docs)[key]);
    return {
      publishing: {
        ...docs.publishing,
        providers: {
          ...providers(docs),
          [key]: {
            ...provider,
            enabled: values['enabled'],
            dailyPublishCap: values['dailyPublishCap'],
          },
        },
      },
    };
  },
  check: (before, after, ctx, { itemKey }) => {
    const turningOn =
      !bool(rec(providers(before)[itemKey])['enabled']) &&
      bool(rec(providers(after)[itemKey])['enabled']);
    return turningOn && !connectorBuilt(itemKey) ? [ctx.t('pub.r.notBuilt')] : [];
  },
  impact: (before, after, ctx, itemKey) => {
    const was = bool(rec(providers(before)[itemKey])['enabled']);
    const now = bool(rec(providers(after)[itemKey])['enabled']);
    const out: string[] = [];
    if (!was && now) {
      out.push(ctx.t('pub.p.on'));
      if (appStatus(after, itemKey) !== 'active') out.push(ctx.t('pub.p.setUpFirst'));
    }
    if (was && !now) out.push(ctx.t('pub.p.off'));
    if (
      num(rec(providers(before)[itemKey])['dailyPublishCap']) !==
      num(rec(providers(after)[itemKey])['dailyPublishCap'])
    )
      out.push(ctx.t('pub.i.cap'));
    return out.length > 0 ? out : [ctx.t('w.noCustomerChange')];
  },
  slices: (itemKey) => [
    {
      domain: 'publishing',
      read: (doc) => {
        const provider = rec(rec(doc['providers'])[itemKey]);
        return provider['enabled'] === undefined
          ? undefined
          : { enabled: provider['enabled'], dailyPublishCap: provider['dailyPublishCap'] };
      },
      write: (doc, value) => {
        const all = rec(doc['providers']);
        return value === undefined || all[itemKey] === undefined
          ? doc
          : { ...doc, providers: { ...all, [itemKey]: { ...rec(all[itemKey]), ...rec(value) } } };
      },
    },
  ],
};

const retryFields: readonly FieldSpec[] = [
  {
    id: 'maxAttempts',
    kind: 'number',
    label: 'pub.f.attempts',
    help: 'pub.h.attempts',
    impact: 'pub.i.attempts',
    unit: 'u.attempts',
    min: 1,
    max: 10,
  },
];

const retryCollection: CollectionSpec = {
  id: 'retry',
  title: 'pub.r.title',
  intro: 'pub.r.intro',
  domains: ['publishing'],
  fields: () => retryFields,
  keyOf: () => 'retry',
  items: (docs, ctx): readonly ItemView[] => {
    const retry = rec(docs.publishing?.['retry']);
    return [
      {
        key: 'retry',
        title: ctx.t('pub.r.cardTitle'),
        facts: [
          { label: ctx.t('pub.f.attempts'), value: String(num(retry['maxAttempts']) ?? '—') },
        ],
        values: { maxAttempts: num(retry['maxAttempts']) ?? 5 },
      },
    ];
  },
  apply: (docs, _ctx, { values }) => ({
    publishing: {
      ...docs.publishing,
      retry: { ...rec(docs.publishing?.['retry']), maxAttempts: values['maxAttempts'] },
    },
  }),
  impact: (_before, _after, ctx) => [ctx.t('pub.i.attempts')],
  slices: () => [
    {
      domain: 'publishing',
      read: (doc) => rec(doc['retry'])['maxAttempts'],
      write: (doc, value) => ({ ...doc, retry: { ...rec(doc['retry']), maxAttempts: value } }),
    },
  ],
};

export const publishingArea: AreaSpec = {
  key: 'publishing',
  title: 'pub.title',
  intro: 'pub.intro',
  href: (locale) => `/${locale}/console/manage/publishing`,
  collections: [providerCollection, retryCollection],
  guided: (['facebook', 'instagram', 'tiktok'] as const).map((key) => ({
    label: `pub.g.${key}` as const,
    href: `/console/integrations/social/${key}`,
  })),
  developer: [
    {
      label: 'pub.d.backoff',
      value: (docs) => {
        const r = rec(docs.publishing?.['retry']);
        return `${num(r['initialBackoffSeconds']) ?? '—'} s × ${num(r['backoffMultiplier']) ?? '—'} ≤ ${num(r['maxBackoffSeconds']) ?? '—'} s`;
      },
    },
    {
      label: 'pub.d.rateLimits',
      value: (docs) =>
        Object.entries(providers(docs))
          .map(([k, p]) => {
            const l = rec(rec(p)['rateLimit']);
            return `${CHANNEL_NAMES[k] ?? k}: ${num(l['requestsPerWindow']) ?? '—'}/${num(l['windowSeconds']) ?? '—'} s`;
          })
          .join(' · ') || '—',
    },
    {
      label: 'pub.d.scopes',
      value: (docs) =>
        Object.entries(providers(docs))
          .map(([k, p]) => `${CHANNEL_NAMES[k] ?? k}: ${arrayOf(rec(p)['scopes']).length}`)
          .join(' · ') || '—',
    },
    {
      label: 'pub.d.tokenWarning',
      value: (docs) =>
        Object.entries(providers(docs))
          .map(([k, p]) => `${CHANNEL_NAMES[k] ?? k}: ${num(rec(p)['expiringSoonHours']) ?? '—'}`)
          .join(' · ') || '—',
    },
    {
      label: 'pub.d.dispatch',
      value: (docs) =>
        `${num(rec(docs.publishing?.['dispatch'])['latenessToleranceMinutes']) ?? '—'} min`,
    },
    {
      label: 'pub.d.inbound',
      value: (docs) => `${num(rec(docs.publishing?.['inbound'])['retentionDays']) ?? '—'} d`,
    },
  ],
};
