/**
 * BATCH 7 (A3) — AN UPLOAD IS NEVER SILENT. What a file control will admit,
 * written beside it, used to limit the picker, and checked the moment a file is
 * chosen, so a refusal arrives at once and in place instead of after a round
 * trip, or not at all.
 *
 * The rules are the ones the server enforces, read from ACTIVATED
 * CONFIGURATION by the page that renders the control (`assets.upload`,
 * `brand-brain.upload`). The check here is a courtesy: the server still refuses
 * anything else, and a file's own signature has to agree with its name.
 */

export interface UploadRules {
  /** The MIME types the server admits. */
  readonly mimeTypes: readonly string[];
  /** The largest file the server admits, in bytes. */
  readonly maxBytes: number;
  /** A type's own ceiling where it differs (a video may be larger than an image). */
  readonly maxBytesByType?: Readonly<Record<string, number>>;
}

/** The ceiling for one admitted type. */
export function maxBytesFor(rules: UploadRules, mimeType: string): number {
  return rules.maxBytesByType?.[mimeType] ?? rules.maxBytes;
}

/** The admitted types grouped by their ceiling, in the order they were given. */
export function ruleGroupsOf(rules: UploadRules): { types: string[]; maxBytes: number }[] {
  const groups: { types: string[]; maxBytes: number }[] = [];
  for (const type of rules.mimeTypes) {
    const max = maxBytesFor(rules, type);
    const group = groups.find((candidate) => candidate.maxBytes === max);
    if (group) group.types.push(type);
    else groups.push({ types: [type], maxBytes: max });
  }
  return groups;
}

/** File-name extensions per MIME type, for the picker and for files a browser types as ''. */
const EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'image/svg+xml': ['svg'],
  'video/mp4': ['mp4'],
  'video/webm': ['webm'],
  'video/quicktime': ['mov'],
  'audio/mpeg': ['mp3'],
  'audio/wav': ['wav'],
  'application/pdf': ['pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/msword': ['doc'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
  'text/markdown': ['md', 'markdown'],
  'font/woff2': ['woff2'],
  'font/woff': ['woff'],
  'font/ttf': ['ttf'],
  'font/otf': ['otf'],
};

function extensionOf(name: string): string {
  return /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase() ?? '';
}

/** The picker's `accept`: the types, and their extensions for systems that match by name. */
export function acceptOf(rules: UploadRules): string {
  const extensions = rules.mimeTypes.flatMap((type) => EXTENSIONS[type] ?? []);
  return [...rules.mimeTypes, ...extensions.map((extension) => `.${extension}`)].join(',');
}

/** The formats as a reader names them: one upper-case extension per type, in order. */
export function formatNamesOf(rules: UploadRules): string[] {
  const names = rules.mimeTypes.map((type) =>
    (EXTENSIONS[type]?.[0] ?? type.split('/').at(-1) ?? type).toUpperCase(),
  );
  return [...new Set(names)];
}

/** "PNG, JPG, or WEBP" in the reader's language. */
export function formatListOf(rules: UploadRules, locale: string): string {
  const names = formatNamesOf(rules);
  try {
    return new Intl.ListFormat(locale, { type: 'disjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
}

/** A size as a reader says it: `20 MB`, `512 KB` (binary units, as the limits are set). */
export function bytesText(bytes: number, locale: string): string {
  const kib = 1024;
  const mib = kib * 1024;
  const [value, unit] = bytes >= mib ? [bytes / mib, 'megabyte'] : [bytes / kib, 'kilobyte'];
  const digits = value >= 10 || Number.isInteger(value) ? 0 : 1;
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: digits,
  }).format(value);
}

export type UploadRefusal = 'type' | 'size' | 'empty';

/** Why the server would refuse this file, judged before it is sent; null when it would not. */
export function refusalOf(
  file: Pick<File, 'name' | 'type' | 'size'>,
  rules: UploadRules,
): UploadRefusal | null {
  if (file.size === 0) return 'empty';
  const type = file.type.trim().toLowerCase();
  const extension = extensionOf(file.name);
  const typeKnown = type !== '' && rules.mimeTypes.includes(type);
  const extensionKnown =
    extension !== '' &&
    rules.mimeTypes.some((allowed) => (EXTENSIONS[allowed] ?? []).includes(extension));
  // The server takes the browser's type when it names an allowed one, and the
  // extension otherwise (Markdown and CSV are often typed vaguely), so either
  // is enough here too.
  if (!typeKnown && !extensionKnown) return 'type';
  const matched = typeKnown
    ? type
    : (rules.mimeTypes.find((allowed) => (EXTENSIONS[allowed] ?? []).includes(extension)) ?? type);
  if (file.size > maxBytesFor(rules, matched)) return 'size';
  return null;
}

/** The rules line, one sentence per size ceiling: `{formats} · up to {size}`. */
export function rulesText(
  rules: UploadRules,
  locale: string,
  texts: { readonly rules: string },
): string {
  return ruleGroupsOf(rules)
    .map((group) =>
      texts.rules
        .replace('{formats}', formatListOf({ ...rules, mimeTypes: group.types }, locale))
        .replace('{size}', bytesText(group.maxBytes, locale)),
    )
    .join('; ');
}
