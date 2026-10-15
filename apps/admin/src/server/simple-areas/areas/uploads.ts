import type { AreaSpec, CollectionSpec, Docs, FieldSpec, ItemView } from '../types';
import { arrayOf, bool, num, rec, str } from '../json';

/**
 * UPLOADS — per kind of file: which types are accepted and how large; and
 * whether uploads are scanned for malware, with the disclaimer said plainly.
 *
 * Sizes are edited in MB and stored in bytes (1 MB = 1,048,576 bytes), capped
 * at what the database column can hold (2,047 MB). The scanner's keys are the
 * worker's environment, never configuration.
 */

const MB = 1024 * 1024;
const MAX_MB = Math.floor(2_147_483_647 / MB);

export const UPLOAD_KINDS = ['image', 'video', 'audio', 'document', 'font'] as const;

/** Types the platform knows how to recognise, per kind (the schema defaults plus GIF). */
const KNOWN_TYPES: Readonly<Record<(typeof UPLOAD_KINDS)[number], readonly string[]>> = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/wav'],
  document: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'text/markdown',
  ],
  font: ['font/woff2', 'font/woff', 'font/ttf', 'font/otf'],
};

const TYPE_NAMES: Readonly<Record<string, string>> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
  'video/mp4': 'MP4',
  'video/webm': 'WebM',
  'video/quicktime': 'MOV',
  'audio/mpeg': 'MP3',
  'audio/wav': 'WAV',
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word (DOCX)',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint (PPTX)',
  'text/plain': 'Text (TXT)',
  'text/csv': 'CSV',
  'text/markdown': 'Markdown',
  'font/woff2': 'WOFF2',
  'font/woff': 'WOFF',
  'font/ttf': 'TTF',
  'font/otf': 'OTF',
};

const upload = (docs: Docs) => rec(docs.assets?.['upload']);

function kindFields(docs: Docs, kind: string): readonly FieldSpec[] {
  const current = arrayOf(rec(upload(docs)['allowedMimeTypes'])[kind]).map(str);
  const types = [
    ...new Set([...(KNOWN_TYPES[kind as keyof typeof KNOWN_TYPES] ?? []), ...current]),
  ];
  return [
    {
      id: 'types',
      kind: 'multi',
      label: 'up.f.types',
      help: 'up.h.types',
      impact: 'up.i.types',
      required: true,
      options: types.map((type) => ({ value: type, label: { literal: TYPE_NAMES[type] ?? type } })),
    },
    {
      id: 'maxMb',
      kind: 'number',
      label: 'up.f.maxMb',
      help: 'up.h.maxMb',
      impact: 'up.i.maxMb',
      unit: 'u.mb',
      min: 1,
      max: MAX_MB,
    },
  ];
}

const kinds: CollectionSpec = {
  id: 'kinds',
  title: 'up.k.title',
  domains: ['assets'],
  fields: (docs, _ctx, _mode, itemKey) => kindFields(docs, itemKey ?? 'image'),
  keyOf: (_values, _mode, itemKey) => itemKey ?? '',
  items: (docs, ctx): readonly ItemView[] =>
    UPLOAD_KINDS.map((kind) => {
      const types = arrayOf(rec(upload(docs)['allowedMimeTypes'])[kind]).map(str);
      const bytes = num(rec(upload(docs)['maxFileBytes'])[kind]) ?? 0;
      return {
        key: kind,
        title: ctx.t(`up.kind.${kind}`),
        facts: [
          {
            label: ctx.t('up.f.types'),
            value:
              types
                .map((type) => TYPE_NAMES[type] ?? type)
                .join(ctx.locale === 'ar' ? '، ' : ', ') || ctx.t('w.none'),
          },
          { label: ctx.t('up.f.maxMb'), value: `${Math.round(bytes / MB)} ${ctx.t('u.mb')}` },
        ],
        values: { types, maxMb: Math.max(1, Math.round(bytes / MB)) },
      } satisfies ItemView;
    }),
  apply: (docs, _ctx, { itemKey, values }) => {
    const kind = itemKey ?? '';
    const current = upload(docs);
    return {
      assets: {
        ...docs.assets,
        upload: {
          ...current,
          allowedMimeTypes: { ...rec(current['allowedMimeTypes']), [kind]: values['types'] },
          maxFileBytes: {
            ...rec(current['maxFileBytes']),
            [kind]: (values['maxMb'] as number) * MB,
          },
        },
      },
    };
  },
  impact: (before, after, ctx, itemKey) => {
    const read = (docs: Docs) => rec(docs.assets?.['upload']);
    const out: string[] = [];
    if (
      JSON.stringify(rec(read(before)['allowedMimeTypes'])[itemKey]) !==
      JSON.stringify(rec(read(after)['allowedMimeTypes'])[itemKey])
    )
      out.push(ctx.t('up.i.types'));
    if (
      num(rec(read(before)['maxFileBytes'])[itemKey]) !==
      num(rec(read(after)['maxFileBytes'])[itemKey])
    )
      out.push(ctx.t('up.i.maxMb'));
    return out.length > 0 ? out : [ctx.t('w.noCustomerChange')];
  },
  slices: (itemKey) => [
    {
      domain: 'assets',
      read: (doc) => ({
        types: rec(rec(doc['upload'])['allowedMimeTypes'])[itemKey],
        bytes: rec(rec(doc['upload'])['maxFileBytes'])[itemKey],
      }),
      write: (doc, value) => {
        const v = rec(value);
        const current = rec(doc['upload']);
        return {
          ...doc,
          upload: {
            ...current,
            allowedMimeTypes: { ...rec(current['allowedMimeTypes']), [itemKey]: v['types'] },
            maxFileBytes: { ...rec(current['maxFileBytes']), [itemKey]: v['bytes'] },
          },
        };
      },
    },
  ],
};

const scanningFields = (docs: Docs): readonly FieldSpec[] => {
  const current = str(rec(docs.assets?.['scanning'])['provider']);
  return [
    {
      id: 'provider',
      kind: 'choice',
      label: 'up.f.scanner',
      help: 'up.h.scanner',
      impact: 'up.i.scanner',
      options: [
        { value: 'none', label: 'up.o.none' },
        { value: 'scanii', label: 'up.o.scanii' },
        ...(current === 'mock' ? [{ value: 'mock', label: 'up.o.mock' as const }] : []),
      ],
    },
    {
      id: 'required',
      kind: 'switch',
      label: 'up.f.required',
      help: 'up.h.required',
      impact: 'up.i.required',
    },
    {
      id: 'endpoint',
      kind: 'text',
      label: 'up.f.endpoint',
      help: 'up.h.endpoint',
      maxLength: 300,
      dir: 'ltr',
      pattern: /^https:\/\/\S+$/,
      patternMessage: 'up.v.endpoint',
    },
  ];
};

const scanning: CollectionSpec = {
  id: 'scanning',
  title: 'up.s.title',
  intro: 'up.s.intro',
  domains: ['assets'],
  fields: (docs) => scanningFields(docs),
  keyOf: () => 'scanning',
  items: (docs, ctx): readonly ItemView[] => {
    const scan = rec(docs.assets?.['scanning']);
    const provider = str(scan['provider']) || 'mock';
    return [
      {
        key: 'scanning',
        title: ctx.t('up.s.cardTitle'),
        status:
          provider === 'none'
            ? { label: ctx.t('up.s.off'), tone: 'warning' }
            : provider === 'mock'
              ? { label: ctx.t('up.o.mock'), tone: 'info' }
              : { label: ctx.t('up.s.on'), tone: 'success' },
        facts: [
          {
            label: ctx.t('up.f.scanner'),
            value: ctx.t(
              `up.o.${provider === 'scanii' ? 'scanii' : provider === 'none' ? 'none' : 'mock'}`,
            ),
          },
          {
            label: ctx.t('up.f.required'),
            value: ctx.t(bool(scan['required']) ? 'w.yes' : 'w.no'),
          },
          {
            label: ctx.t('up.f.endpoint'),
            value: str(rec(scan['scanii'])['endpoint']) || ctx.t('w.notSet'),
          },
        ],
        values: {
          provider,
          required: bool(scan['required']),
          endpoint: str(rec(scan['scanii'])['endpoint']),
        },
      },
    ];
  },
  apply: (docs, _ctx, { values }) => {
    const scan = rec(docs.assets?.['scanning']);
    return {
      assets: {
        ...docs.assets,
        scanning: {
          ...scan,
          provider: values['provider'],
          required: values['required'],
          scanii: {
            ...rec(scan['scanii']),
            endpoint: values['endpoint'] === '' ? null : values['endpoint'],
          },
        },
      },
    };
  },
  check: (_before, after, ctx) => {
    const scan = rec(after.assets?.['scanning']);
    const errors: string[] = [];
    if (str(scan['provider']) === 'none' && bool(scan['required']))
      errors.push(ctx.t('up.r.noneRequired'));
    if (str(scan['provider']) === 'scanii' && !str(rec(scan['scanii'])['endpoint']))
      errors.push(ctx.t('up.r.endpoint'));
    return errors;
  },
  impact: (_before, after, ctx) => [
    str(rec(after.assets?.['scanning'])['provider']) === 'none'
      ? ctx.t('up.p.off')
      : ctx.t('up.p.on'),
    ctx.t('up.p.disclaimer'),
  ],
  slices: () => [
    {
      domain: 'assets',
      read: (doc) => doc['scanning'],
      write: (doc, value) => ({ ...doc, scanning: value }),
    },
  ],
};

export const uploadsArea: AreaSpec = {
  key: 'uploads',
  title: 'up.title',
  intro: 'up.intro',
  href: (locale) => `/${locale}/console/manage/uploads`,
  collections: [kinds, scanning],
  developer: [
    {
      label: 'up.d.perBrand',
      value: (docs) => String(num(upload(docs)['maxAssetsPerBrand']) ?? '—'),
    },
    { label: 'up.d.tags', value: (docs) => `${num(upload(docs)['maxTagsPerAsset']) ?? '—'}` },
    {
      label: 'up.d.versions',
      value: (docs) => String(num(rec(docs.assets?.['versions'])['maxVersionsPerAsset']) ?? '—'),
    },
    {
      label: 'up.d.previews',
      value: (docs) => `${num(rec(docs.assets?.['derivatives'])['thumbnailMaxEdgePx']) ?? '—'} px`,
    },
    {
      label: 'up.d.retention',
      value: (docs) => `${num(rec(docs.assets?.['retention'])['purgeDeletedAfterDays']) ?? '—'} d`,
    },
    { label: 'up.d.keys', value: (_docs, ctx) => ctx.t('up.d.keysValue') },
  ],
};
