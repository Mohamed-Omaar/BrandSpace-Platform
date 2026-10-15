import { findIntegration } from '@brandspace/integrations';
import type { AreaContext, AreaSpec, CollectionSpec, Docs, FieldSpec, ItemView } from '../types';
import { arrayOf, bool, num, rec, str, upsertBy, sameJson } from '../json';
import { dialectName } from '../plain';

/**
 * CHANNELS — one card per channel: shown to customers or not, the kinds of
 * post it carries, and its writing limits.
 *
 * "SHOWN" IS MEMBERSHIP OF `content.platforms` — the list the Studio's "Post
 * to", the Calendar's filter and the Automations channel condition all read.
 * HIDING IS REFUSED while any post already has a version for the channel:
 * removing a platform from that list breaks the posts that use it (D-554,
 * `docs/production-config/README.md` §2.1). Showing it again restores the
 * entry it had, or builds one from the publishing limits.
 *
 * Post kinds and the publishing ceilings are the `publishing` document's; the
 * writing limits (what the Studio lets an author type) are `content`'s, and are
 * never allowed above what publishing will send.
 */

export const CHANNEL_NAMES: Readonly<Record<string, string>> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  x: 'X',
};

export const POST_KINDS = [
  'text',
  'image',
  'carousel',
  'video',
  'reel',
  'story',
  'article',
  'thread',
] as const;

const providers = (docs: Docs) => rec(docs.publishing?.['providers']);
const platforms = (docs: Docs) => arrayOf(docs.content?.['platforms']).map(rec);

export function channelKeys(docs: Docs): readonly string[] {
  return [
    ...new Set([...platforms(docs).map((p) => str(p['key'])), ...Object.keys(providers(docs))]),
  ];
}

/** A connector exists for this channel (a provider the registry knows). */
export const connectorBuilt = (key: string) => findIntegration('social', key) !== undefined;

function fields(
  docs: Docs,
  _ctx: AreaContext,
  _mode: string,
  itemKey: string | null = null,
): readonly FieldSpec[] {
  const provider = itemKey ? rec(providers(docs)[itemKey]) : {};
  const maxBody = num(provider['maxBodyCharacters']) ?? 100_000;
  const maxTags = num(provider['maxHashtags']) ?? 100;
  const maxMedia = Math.min(20, num(provider['maxMediaItems']) ?? 20);
  return [
    { id: 'shown', kind: 'switch', label: 'ch.f.shown', help: 'ch.h.shown', impact: 'ch.i.shown' },
    {
      id: 'postKinds',
      kind: 'multi',
      label: 'ch.f.postKinds',
      help: 'ch.h.postKinds',
      impact: 'ch.i.postKinds',
      required: true,
      options: POST_KINDS.map((kind) => ({ value: kind, label: `ch.k.${kind}` as const })),
    },
    {
      id: 'maxBodyChars',
      kind: 'number',
      label: 'ch.f.maxBody',
      help: 'ch.h.maxBody',
      impact: 'ch.i.limits',
      unit: 'u.characters',
      min: 1,
      max: maxBody,
    },
    {
      id: 'maxHashtags',
      kind: 'number',
      label: 'ch.f.maxHashtags',
      help: 'ch.h.maxHashtags',
      impact: 'ch.i.limits',
      unit: 'u.hashtags',
      min: 0,
      max: maxTags,
    },
    {
      id: 'maxMediaItems',
      kind: 'number',
      label: 'ch.f.maxMedia',
      help: 'ch.h.maxMedia',
      impact: 'ch.i.limits',
      unit: 'u.items',
      min: 0,
      max: maxMedia,
    },
    {
      id: 'allowsFirstComment',
      kind: 'switch',
      label: 'ch.f.firstComment',
      help: 'ch.h.firstComment',
      impact: 'ch.i.limits',
    },
  ];
}

function items(docs: Docs, ctx: AreaContext): readonly ItemView[] {
  return channelKeys(docs).map((key) => {
    const entry = platforms(docs).find((p) => str(p['key']) === key);
    const provider = rec(providers(docs)[key]);
    const shown = entry !== undefined;
    const posts = ctx.variantsPerPlatform[key] ?? 0;
    const kinds = arrayOf(provider['postKinds']).map(str);
    return {
      key,
      title: CHANNEL_NAMES[key] ?? key,
      status: shown
        ? { label: ctx.t('ch.s.shown'), tone: 'success' }
        : { label: ctx.t('ch.s.hidden'), tone: 'neutral' },
      facts: [
        {
          label: ctx.t('ch.c.connect'),
          value: !connectorBuilt(key)
            ? ctx.t('ch.c.notBuilt')
            : bool(provider['enabled'])
              ? ctx.t('ch.c.canConnect')
              : ctx.t('ch.c.cannotConnect'),
        },
        {
          label: ctx.t('ch.f.postKinds'),
          value:
            kinds
              .map((kind) => ctx.t(`ch.k.${kind}` as never))
              .join(ctx.locale === 'ar' ? '، ' : ', ') || ctx.t('w.none'),
        },
        {
          label: ctx.t('ch.f.maxBody'),
          value: String(num(entry?.['maxBodyChars']) ?? num(provider['maxBodyCharacters']) ?? '—'),
        },
        {
          label: ctx.t('ch.f.maxHashtags'),
          value: String(num(entry?.['maxHashtags']) ?? num(provider['maxHashtags']) ?? '—'),
        },
        {
          label: ctx.t('ch.f.maxMedia'),
          value: String(num(entry?.['maxMediaItems']) ?? num(provider['maxMediaItems']) ?? '—'),
        },
        { label: ctx.t('ch.c.posts'), value: String(posts) },
      ],
      values: {
        shown,
        postKinds: kinds.filter((kind) => (POST_KINDS as readonly string[]).includes(kind)),
        maxBodyChars: num(entry?.['maxBodyChars']) ?? num(provider['maxBodyCharacters']) ?? 2_200,
        maxHashtags: num(entry?.['maxHashtags']) ?? num(provider['maxHashtags']) ?? 30,
        maxMediaItems:
          num(entry?.['maxMediaItems']) ?? Math.min(20, num(provider['maxMediaItems']) ?? 10),
        allowsFirstComment: bool(entry?.['allowsFirstComment']),
      },
      ...(shown && posts > 0
        ? { archiveBlockedReason: ctx.t('ch.r.hasPosts', { count: posts }) }
        : {}),
    } satisfies ItemView;
  });
}

function withEntry(
  docs: Docs,
  key: string,
  shown: boolean,
  values: Record<string, unknown> | null,
): Docs {
  const list = platforms(docs);
  const existing = list.find((p) => str(p['key']) === key);
  if (!shown) {
    return existing
      ? { content: { ...docs.content, platforms: list.filter((p) => str(p['key']) !== key) } }
      : {};
  }
  const entry = {
    labelKey: `content.platform.${key}`,
    ...existing,
    key,
    ...(values ?? {}),
  };
  return { content: { ...docs.content, platforms: upsertBy(list, 'key', entry, key) } };
}

const collection: CollectionSpec = {
  id: 'channels',
  title: 'ch.title',
  domains: ['content', 'publishing'],
  parts: { content: 'ch.part.content', publishing: 'ch.part.publishing' },
  archiveLabel: 'a.hide',
  fields: (docs, ctx, mode, itemKey) => fields(docs, ctx, mode, itemKey),
  items,
  keyOf: (_values, _mode, itemKey) => itemKey ?? '',
  apply: (docs, _ctx, { itemKey, values }) => {
    const key = itemKey ?? '';
    const out: Docs = withEntry(docs, key, values['shown'] === true, {
      maxBodyChars: values['maxBodyChars'],
      maxHashtags: values['maxHashtags'],
      maxMediaItems: values['maxMediaItems'],
      allowsFirstComment: values['allowsFirstComment'],
    });
    const provider = rec(providers(docs)[key]);
    if (Object.keys(provider).length > 0) {
      out.publishing = {
        ...docs.publishing,
        providers: { ...providers(docs), [key]: { ...provider, postKinds: values['postKinds'] } },
      };
    }
    return out;
  },
  archive: (docs, _ctx, itemKey) => withEntry(docs, itemKey, false, null),
  check: (before, after, ctx, { itemKey }) => {
    const errors: string[] = [];
    const wasShown = platforms(before).some((p) => str(p['key']) === itemKey);
    const nowShown = platforms(after).some((p) => str(p['key']) === itemKey);
    const posts = ctx.variantsPerPlatform[itemKey] ?? 0;
    if (wasShown && !nowShown && posts > 0) errors.push(ctx.t('ch.r.hasPosts', { count: posts }));
    const entry = platforms(after).find((p) => str(p['key']) === itemKey);
    const recommended = rec(entry?.['recommendedHashtags']);
    if (
      entry &&
      num(recommended['max']) !== null &&
      (num(recommended['max']) ?? 0) > (num(entry['maxHashtags']) ?? 0)
    ) {
      errors.push(ctx.t('v.hashtagCeiling'));
    }
    return errors;
  },
  impact: (before, after, ctx, itemKey) => {
    const out: string[] = [];
    const wasShown = platforms(before).some((p) => str(p['key']) === itemKey);
    const nowShown = platforms(after).some((p) => str(p['key']) === itemKey);
    if (!wasShown && nowShown) out.push(ctx.t('ch.p.shown'));
    if (wasShown && !nowShown) out.push(ctx.t('ch.p.hidden'));
    if (
      !sameJson(
        rec(providers(before)[itemKey])['postKinds'],
        rec(providers(after)[itemKey])['postKinds'],
      )
    )
      out.push(ctx.t('ch.p.postKinds'));
    if (nowShown && !bool(rec(providers(after)[itemKey])['enabled']))
      out.push(ctx.t('ch.p.notConnectable'));
    return out.length > 0 ? out : [ctx.t('ch.i.limits')];
  },
  slices: (itemKey) => [
    {
      domain: 'content',
      read: (doc) =>
        arrayOf(doc['platforms'])
          .map(rec)
          .find((p) => str(p['key']) === itemKey),
      write: (doc, value) => ({
        ...doc,
        platforms:
          value === undefined
            ? arrayOf(doc['platforms'])
                .map(rec)
                .filter((p) => str(p['key']) !== itemKey)
            : upsertBy(arrayOf(doc['platforms']).map(rec), 'key', rec(value), itemKey),
      }),
    },
    {
      domain: 'publishing',
      read: (doc) => rec(rec(doc['providers'])[itemKey])['postKinds'],
      write: (doc, value) => {
        const all = rec(doc['providers']);
        return value === undefined || all[itemKey] === undefined
          ? doc
          : {
              ...doc,
              providers: { ...all, [itemKey]: { ...rec(all[itemKey]), postKinds: value } },
            };
      },
    },
  ],
};

export const channelsArea: AreaSpec = {
  key: 'channels',
  title: 'ch.title',
  intro: 'ch.intro',
  href: (locale) => `/${locale}/console/manage/channels`,
  collections: [collection],
  developer: [
    {
      label: 'ch.d.media',
      value: (docs) =>
        Object.entries(providers(docs))
          .map(
            ([key, provider]) =>
              `${CHANNEL_NAMES[key] ?? key}: ${Object.keys(rec(rec(provider)['mediaRules'])).length}`,
          )
          .join(' · ') || '—',
    },
    {
      label: 'ch.d.labels',
      value: (docs, ctx) =>
        platforms(docs)
          .map((p) => CHANNEL_NAMES[str(p['key'])] ?? ctx.t('w.developerValue'))
          .join(' · ') || '—',
    },
    {
      label: 'ch.d.dialects',
      value: (docs, ctx) =>
        arrayOf(rec(docs.content?.['dialects'])['supported'])
          .map((d) => dialectName(ctx, str(rec(d)['key'])))
          .join(' · ') || '—',
    },
  ],
};
