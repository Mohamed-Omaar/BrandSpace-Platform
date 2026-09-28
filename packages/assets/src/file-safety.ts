import {
  checkSignature as checkAgainst,
  detectFormat,
  type DetectedFormat,
} from '@brandspace/shared';
import { unsafeFileName } from './errors';

/**
 * What the Asset Library requires an upload to actually BE, and what it will
 * let a file be CALLED.
 *
 * The detector lives in `@brandspace/shared`; the expectation map below is this
 * feature's own policy, because it changes when the library's allow-list
 * changes and that has nothing to do with Brand Brain's extractors.
 */

/**
 * The format each accepted media type must actually be.
 *
 * SOME TYPES ADMIT MORE THAN ONE FORMAT, and that is real rather than lax:
 * `font/ttf` covers both the 0x00010000 version tag and the older "true" tag,
 * and an MP3 is either ID3-tagged or a bare frame sync. Each alternative is a
 * documented signature for that exact format, not a widened net.
 */
const EXPECTED_FORMAT: Readonly<Record<string, DetectedFormat | readonly DetectedFormat[]>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'ooxml',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'ooxml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'ooxml',
  'text/plain': 'text',
  'text/csv': 'text',
  'text/markdown': 'text',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
};

/** Does the content match what the caller said it was? */
export function checkAssetSignature(declaredMimeType: string, bytes: Uint8Array) {
  return checkAgainst(EXPECTED_FORMAT, declaredMimeType, bytes);
}

/**
 * Whether a declared media type has an entry in the map above.
 *
 * An operator CAN add a type to `assets.upload.allowedMimeTypes` that nothing
 * here knows how to verify. Admitting it would mean storing a file whose
 * contents were never checked against its claim, which is exactly the guarantee
 * docs/SECURITY.md §11.2 makes. So the upload is refused at the door with a
 * customer-safe message, and the operator learns the type needs a signature
 * before it can be enabled — rather than the customer learning nothing and the
 * platform storing an unverified blob.
 */
export function signatureIsKnown(declaredMimeType: string): boolean {
  return declaredMimeType in EXPECTED_FORMAT;
}

/*
 * ---------------------------------------------------------------------------
 * File names.
 *
 * A FILE NAME IS HOSTILE INPUT AND IT IS ALSO THE THING THE CUSTOMER SEES.
 * Those two facts pull in opposite directions, and the resolution below is
 * deliberate: the name is NORMALISED for display and storage, and it NEVER
 * reaches a filesystem path, a URL, a shell or a header unescaped. The storage
 * key is built from identifiers (see storage-keys.ts) and never from the name,
 * so a name that survives normalisation still cannot address anything.
 *
 * WHAT IS REFUSED OUTRIGHT rather than normalised away: a name that is empty
 * after normalisation, and a name that traverses. Silently rewriting
 * `../../etc/passwd` to `etcpasswd` stores the file under a name the customer
 * never chose and hides an attempt that someone should see refused.
 * ---------------------------------------------------------------------------
 */

/** Characters that must never survive into a stored name. */
// eslint-disable-next-line no-control-regex -- the point is to remove control characters.
const CONTROL_AND_SEPARATORS = /[\u0000-\u001F\u007F/\\]/g;

/**
 * Unicode formatting characters that change how a name READS without changing
 * what it IS.
 *
 * The bidirectional overrides are the reason this exists. `U+202E` reverses
 * rendering, so a name ending in one plus `gnp.exe` displays as `exe.png` — the
 * oldest filename spoof there is, and one that matters more in a product whose
 * interface is already bidirectional, because a reader cannot tell a spoof from
 * legitimate Arabic by looking. Zero-width characters are stripped for the
 * neighbouring reason: two names that render identically are two names a person
 * cannot distinguish.
 */
const INVISIBLE_FORMATTING = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** A name that is nothing but dots and spaces once separators are gone. */
const ONLY_DOTS_AND_SPACES = /^[\s.]+$/;

export interface NormalisedFileName {
  readonly name: string;
  /** The lowercase extension WITHOUT the dot, or null. Never trusted for type. */
  readonly extension: string | null;
}

/**
 * Normalise a customer-supplied file name, or refuse it.
 *
 * `maxLength` comes from activated configuration rather than a constant here,
 * because the right ceiling depends on what the storage vendor and the database
 * column tolerate — an operator fact (CLAUDE.md §2.2).
 */
export function normaliseFileName(raw: string, maxLength: number): NormalisedFileName {
  /*
   * TRAVERSAL IS REFUSED, NOT REPAIRED, and it is checked on the RAW input
   * before any character is stripped.
   *
   * Order matters here and it is the whole trick: stripping the separators
   * first turns `../../etc/passwd` into `....etcpasswd`, which then looks
   * harmless and gets stored under a name the customer never chose — hiding an
   * attempt somebody should see refused. So the raw string is tested for a
   * traversal segment while its separators are still present.
   */
  if (/(^|[/\\])\.\.([/\\]|$)/.test(raw)) throw unsafeFileName();

  /*
   * NFC NEXT, AND BEFORE EVERY REMAINING CHECK.
   *
   * Unicode lets the same name be written several ways — an accented letter as
   * one code point or as a base plus a combining mark. Two rows that look
   * identical and compare unequal is a data problem; worse, a check performed
   * on one form and a store performed on another is a bypass. Normalising here
   * means every later step sees one canonical form.
   */
  const normalised = raw
    .normalize('NFC')
    .replace(INVISIBLE_FORMATTING, '')
    .replace(CONTROL_AND_SEPARATORS, '')
    .trim();

  if (normalised.length === 0) throw unsafeFileName();
  // `.` and `..` are not names a person types, and on every filesystem they
  // mean something else. So is any run of dots and spaces.
  if (ONLY_DOTS_AND_SPACES.test(normalised)) throw unsafeFileName();

  // A leading dot hides the file on Unix and is never what a customer meant by
  // a name. It is stripped rather than refused: the rest of the name is fine.
  const visible = normalised.replace(/^\.+/, '').trim();
  if (visible.length === 0) throw unsafeFileName();

  const truncated = truncatePreservingExtension(visible, maxLength);
  const dot = truncated.lastIndexOf('.');
  const extension =
    dot > 0 && dot < truncated.length - 1 ? truncated.slice(dot + 1).toLowerCase() : null;

  return { name: truncated, extension };
}

/**
 * Shorten a name to fit, keeping the extension.
 *
 * Truncating from the right would eat the extension, and a customer whose
 * `annual-report-....pdf` comes back as `annual-report-...` has been handed a
 * file their operating system no longer knows how to open. The STEM is cut and
 * the suffix is kept.
 */
function truncatePreservingExtension(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  const dot = name.lastIndexOf('.');
  // No extension, or one so long that keeping it would leave no stem at all.
  if (dot <= 0 || name.length - dot > 16) return name.slice(0, maxLength);
  const suffix = name.slice(dot);
  const stem = name.slice(0, Math.max(1, maxLength - suffix.length));
  return `${stem}${suffix}`;
}

/**
 * Whether the extension agrees with the declared media type.
 *
 * ADVISORY, NOT AUTHORITATIVE, and it is worth being explicit about which.
 * The SIGNATURE decides what a file is; this only notices that a customer has
 * named a PNG `.pdf`, which is usually a mistake and occasionally an attempt to
 * make a file look like something else in a listing. It returns a boolean and
 * the caller decides — nothing here refuses an upload on an extension alone,
 * because an extension is the least trustworthy thing about a file.
 */
const EXTENSIONS_FOR_TYPE: Readonly<Record<string, readonly string[]>> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'video/mp4': ['mp4', 'm4v'],
  'video/webm': ['webm'],
  'audio/mpeg': ['mp3'],
  'audio/wav': ['wav'],
  'application/pdf': ['pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
  'text/markdown': ['md', 'markdown'],
  'font/woff2': ['woff2'],
  'font/woff': ['woff'],
  'font/ttf': ['ttf'],
  'font/otf': ['otf'],
};

export function extensionMatchesType(mimeType: string, extension: string | null): boolean {
  const expected = EXTENSIONS_FOR_TYPE[mimeType];
  if (!expected) return true;
  if (extension === null) return false;
  return expected.includes(extension);
}

/*
 * ---------------------------------------------------------------------------
 * Fonts (Phase 2C-2): the TYPE comes from the bytes, and the name must agree.
 * ---------------------------------------------------------------------------
 *
 * Browsers are unreliable about a font's media type: many send nothing, or a
 * legacy alias such as `application/x-font-ttf`, or `application/octet-stream`.
 * Trusting that header would refuse real fonts; trusting the extension alone
 * would admit a renamed file. So for a font the FILE'S OWN SIGNATURE decides
 * the type, the extension must name that same format, and a client header can
 * never overrule the bytes: a header that names a DIFFERENT specific type is a
 * mismatch, not a hint.
 *
 * A font COLLECTION (`ttcf`) is refused outright, whatever it is called.
 */

/** The one media type each font format is stored under. */
const FONT_TYPE_FOR_FORMAT: Readonly<Partial<Record<DetectedFormat, string>>> = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

/**
 * What a browser may send for a font without it meaning anything: nothing, the
 * generic binary type, or a legacy alias of the SAME format. Each alias maps to
 * the format it names, so an alias of one format on another format's bytes is
 * still a mismatch.
 */
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const FONT_TYPE_ALIASES: Readonly<Record<string, DetectedFormat>> = {
  'application/x-font-ttf': 'ttf',
  'application/x-font-truetype': 'ttf',
  'application/font-sfnt': 'ttf',
  'font/sfnt': 'ttf',
  'application/x-font-otf': 'otf',
  'application/x-font-opentype': 'otf',
  'application/font-woff': 'woff',
  'application/x-font-woff': 'woff',
  'application/font-woff2': 'woff2',
};

/** A font extension, lower-cased, or null. */
function extensionOf(fileName: string): string | null {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(fileName.trim());
  return match ? match[1]!.toLowerCase() : null;
}

const FONT_EXTENSIONS = new Set(['ttf', 'otf', 'woff', 'woff2', 'ttc', 'otc']);

export type FontTypeResolution =
  | { readonly font: false }
  | { readonly font: true; readonly ok: true; readonly mimeType: string }
  | {
      readonly font: true;
      readonly ok: false;
      readonly reason: 'font_collection' | 'extension_mismatch' | 'content_type_mismatch';
    };

/**
 * Decide an upload's font type from its bytes. `{ font: false }` for anything
 * that is neither a font by its bytes nor by its name — those keep the normal
 * path, untouched.
 */
export function resolveFontType(input: {
  readonly fileName: string;
  readonly declaredMimeType: string;
  readonly bytes: Uint8Array;
}): FontTypeResolution {
  const detected = detectFormat(input.bytes);
  const extension = extensionOf(input.fileName);
  const declared = input.declaredMimeType.trim().toLowerCase();
  const declaredFont = declared.startsWith('font/') || declared in FONT_TYPE_ALIASES;
  const looksLikeFont =
    detected in FONT_TYPE_FOR_FORMAT ||
    detected === 'ttc' ||
    declaredFont ||
    (extension !== null && FONT_EXTENSIONS.has(extension));
  if (!looksLikeFont) return { font: false };

  if (detected === 'ttc' || extension === 'ttc' || extension === 'otc') {
    return { font: true, ok: false, reason: 'font_collection' };
  }
  const mimeType = FONT_TYPE_FOR_FORMAT[detected];
  if (!mimeType) return { font: true, ok: false, reason: 'content_type_mismatch' };
  if (!extensionMatchesType(mimeType, extension)) {
    return { font: true, ok: false, reason: 'extension_mismatch' };
  }
  const agrees =
    GENERIC_TYPES.has(declared) ||
    declared === mimeType ||
    FONT_TYPE_ALIASES[declared] === detected;
  if (!agrees) return { font: true, ok: false, reason: 'content_type_mismatch' };
  return { font: true, ok: true, mimeType };
}

/**
 * The check `complete` runs on every upload: the signature against the declared
 * type, and — for a font — the file name's extension against it too.
 */
export function checkUploadedFile(input: {
  readonly declaredMimeType: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
}): { readonly ok: boolean } {
  if (!checkAssetSignature(input.declaredMimeType, input.bytes).ok) return { ok: false };
  if (input.declaredMimeType.startsWith('font/')) {
    return { ok: extensionMatchesType(input.declaredMimeType, extensionOf(input.fileName)) };
  }
  return { ok: true };
}
