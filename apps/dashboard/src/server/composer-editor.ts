/**
 * THE DRAFT EDITOR — the pure half (Phase 6 final, D-277 §20-§22 and §27, D-284).
 *
 * PURE, AND NOT `server-only`: the composer imports it in the browser to judge
 * a caption as it is typed, and the unit suite imports it directly.
 */

/**
 * Characters as a person counts them — grapheme clusters, the same unit the
 * content service validates in (`packages/content/src/validation.ts`), so the
 * live counter and the saved validation state cannot disagree.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function countCharacters(text: string): number {
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

/** The hashtag field's words, as `saveVariantAction` parses them. */
export function parseHashtags(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((tag) => tag.replace(/^#/, '').trim())
    .filter((tag) => tag.length > 0);
}

/** Which preview composition a content format is drawn in (§22). */
export type PreviewFormat = 'feed' | 'story' | 'reel' | 'video';
export function previewFormatFor(contentType: string): PreviewFormat {
  switch (contentType) {
    case 'REEL':
      return 'reel';
    case 'STORY':
      return 'story';
    case 'VIDEO':
      return 'video';
    default:
      return 'feed';
  }
}

/*
 * ---------------------------------------------------------------------------
 * FRIENDLY VALIDATION (§21)
 * ---------------------------------------------------------------------------
 *
 * "maxBodyChars exceeded" is the service's vocabulary. The person reads "Your
 * Instagram caption is 128 characters over the limit" beside a button that
 * fixes it. Each issue is a translation KEY with its numbers, and the FIX it
 * offers is one of a closed set the editor knows how to perform.
 */
export type IssueFix = 'shorten' | 'media';

export interface EditorIssue {
  readonly key: string;
  readonly values: Readonly<Record<string, string | number>>;
  readonly severity: 'error' | 'warning';
  readonly fix?: IssueFix;
}

export interface EditorPlatformLimits {
  readonly label: string;
  readonly maxBodyChars: number;
  readonly maxHashtags: number;
  readonly maxMediaItems: number;
}

export interface EditorVariantState {
  readonly body: string;
  readonly hashtags: readonly string[];
  /** The KINDS of the attached media, in order ('IMAGE', 'VIDEO', …). */
  readonly mediaKinds: readonly string[];
  /** D-286 — how many attached files have a lapsed licence. */
  readonly expiredMedia?: number;
}

/** The formats that are a video before they are anything else. */
const VIDEO_FORMATS = new Set(['REEL', 'VIDEO']);

export function variantIssues(
  platform: EditorPlatformLimits,
  contentType: string,
  variant: EditorVariantState,
): EditorIssue[] {
  const issues: EditorIssue[] = [];
  const characters = countCharacters(variant.body);

  if (variant.body.trim() === '') {
    issues.push({ key: 'editor.issue.empty', values: {}, severity: 'warning' });
  } else if (platform.maxBodyChars > 0 && characters > platform.maxBodyChars) {
    issues.push({
      key: 'editor.issue.tooLong',
      values: { platform: platform.label, over: characters - platform.maxBodyChars },
      severity: 'error',
      fix: 'shorten',
    });
  }

  if ((variant.expiredMedia ?? 0) > 0) {
    issues.push({
      key: 'editor.issue.rightsExpired',
      values: { count: variant.expiredMedia ?? 0 },
      severity: 'error',
      fix: 'media',
    });
  }

  if (variant.hashtags.length > platform.maxHashtags) {
    issues.push({
      key: 'editor.issue.tooManyHashtags',
      values: {
        platform: platform.label,
        limit: platform.maxHashtags,
        count: variant.hashtags.length,
      },
      severity: 'error',
    });
  }

  if (variant.mediaKinds.length > platform.maxMediaItems && platform.maxMediaItems > 0) {
    issues.push({
      key: 'editor.issue.tooMuchMedia',
      values: { platform: platform.label, limit: platform.maxMediaItems },
      severity: 'error',
      fix: 'media',
    });
  }

  if (VIDEO_FORMATS.has(contentType) && !variant.mediaKinds.includes('VIDEO')) {
    issues.push({
      key: contentType === 'REEL' ? 'editor.issue.reelNeedsVideo' : 'editor.issue.videoNeedsVideo',
      values: {},
      severity: 'warning',
      fix: 'media',
    });
  }
  if (contentType === 'CAROUSEL' && variant.mediaKinds.length < 2) {
    issues.push({
      key: 'editor.issue.carouselNeedsSlides',
      values: { count: variant.mediaKinds.length },
      severity: 'warning',
      fix: 'media',
    });
  }
  if (contentType === 'STORY' && variant.mediaKinds.length === 0) {
    issues.push({
      key: 'editor.issue.storyNeedsMedia',
      values: {},
      severity: 'warning',
      fix: 'media',
    });
  }
  return issues;
}

/** Fill `{name}` placeholders in a message. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

/*
 * ---------------------------------------------------------------------------
 * INLINE AI ACTIONS (§20)
 * ---------------------------------------------------------------------------
 *
 * Small text changes happen where the text is, without opening the Copilot.
 * Each is one of the content service's tools; "friendlier" and "more
 * professional" are the tone tool with a named tone. A tool the platform does
 * not configure is not offered.
 */
export interface InlineAction {
  readonly key: string;
  readonly tool: string;
  readonly argument?: string;
}

export const INLINE_ACTIONS: readonly InlineAction[] = [
  { key: 'shorten', tool: 'shorten' },
  { key: 'rewrite', tool: 'rewrite' },
  { key: 'friendlier', tool: 'tone', argument: 'friendly and warm' },
  { key: 'professional', tool: 'tone', argument: 'professional' },
  { key: 'expand', tool: 'expand' },
  { key: 'hashtags', tool: 'hashtags' },
  { key: 'translate', tool: 'translate' },
];

export function inlineActionsFor(tools: readonly string[]): readonly InlineAction[] {
  return INLINE_ACTIONS.filter((action) => tools.includes(action.tool));
}

/*
 * ---------------------------------------------------------------------------
 * THE LIFECYCLE, AS A PATH (§27)
 * ---------------------------------------------------------------------------
 */
export const LIFECYCLE_PATH = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED'] as const;

/** Where on the path a status sits. CHANGES_REQUESTED is back at the start. */
export function lifecycleIndex(status: string): number {
  if (status === 'CHANGES_REQUESTED') return 0;
  if (status === 'PUBLISHING' || status === 'PARTIALLY_PUBLISHED') return 3;
  const index = (LIFECYCLE_PATH as readonly string[]).indexOf(status);
  return index < 0 ? 0 : index;
}

/**
 * Credits are accounted in MILLI-units and quoted to the customer in credits.
 *
 * Kept as a string end to end: the estimate crosses the wire as one because a
 * `bigint` has no JSON form, and turning it into a `number` here would put a
 * financial figure through a float for the sake of dividing by a thousand.
 */
export function formatCredits(milli: string): string {
  const negative = milli.startsWith('-');
  const digits = (negative ? milli.slice(1) : milli).padStart(4, '0');
  const whole = digits.slice(0, -3).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(-3).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * A short, stable fingerprint of a text — for an idempotency key that must
 * change when the words change and stay put when they do not. Not security:
 * the key only decides whether a retry is the same request (FNV-1a, 32-bit).
 */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/*
 * MEDIA FACTS AND ORDER (§23-§24, D-285)
 */

/** A video's length as m:ss, or null when it was not measured. */
export function durationLabel(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The aspect a person names (9:16, 4:5, 1:1, 16:9), or the pixel size. */
export function aspectLabel(width?: number | null, height?: number | null): string | null {
  if (!width || !height) return null;
  const ratio = width / height;
  if (Math.abs(ratio - 9 / 16) < 0.03) return '9:16';
  if (Math.abs(ratio - 4 / 5) < 0.03) return '4:5';
  if (Math.abs(ratio - 1) < 0.03) return '1:1';
  if (Math.abs(ratio - 16 / 9) < 0.05) return '16:9';
  return `${width}×${height}`;
}

/** Move one item from `from` to `to`, returning a new list. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}
