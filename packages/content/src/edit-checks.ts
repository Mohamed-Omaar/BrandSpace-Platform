/**
 * PR A2 (item 10) — AN AI EDIT DOES WHAT ITS BUTTON SAYS, OR COSTS NOTHING.
 *
 * "Shorter", "Longer", "Friendlier" and "More formal" were one-line wishes to
 * the model: a "shorter" caption could come back the same length, and was
 * charged. Each is now a MEASURABLE instruction, and the answer is checked
 * against it inside the gateway's `accept` — before the charge — so an edit
 * that did not do its job is released, never paid for:
 *
 *   - Shorter: at least 30% fewer characters, every fact kept;
 *   - Longer: at least 30% more characters, inside the platform's limit;
 *   - every rewriting edit: an answer that is nearly the same text (after
 *     case, spacing and punctuation are set aside) is not charged — that is
 *     also how a tone change that changed nothing visible is caught.
 *
 * Pure functions; the numbers live here because they are the definition of
 * the buttons the owner approved (brief "AI programme", item 10), not
 * commercial configuration.
 */

/** Shorter keeps at most this share of the characters. */
export const SHORTER_MAX_RATIO = 0.7;
/** Longer reaches at least this share of the characters. */
export const LONGER_MIN_RATIO = 1.3;
/** At or above this similarity, two captions are "nearly identical". */
export const NEAR_IDENTICAL_SIMILARITY = 0.97;

/** Why an edit was not charged, as a stable code a screen chooses words by. */
export type EditRejection =
  'EDIT_NOT_SHORTER' | 'EDIT_NOT_LONGER' | 'EDIT_NO_CHANGE' | 'EDIT_CANNOT_GROW' | 'EDIT_STALE';

/** Characters as a reader counts them (code points, not UTF-16 units). */
export function charCount(text: string): number {
  return [...text].length;
}

export interface EditTarget {
  readonly minChars: number | null;
  readonly maxChars: number | null;
}

/** The length an edit must reach, from the words it starts from. */
export function editTarget(tool: string, body: string, platformMaxChars: number): EditTarget {
  const length = charCount(body);
  if (tool === 'shorten')
    return { minChars: null, maxChars: Math.floor(length * SHORTER_MAX_RATIO) };
  if (tool === 'expand')
    return { minChars: Math.ceil(length * LONGER_MIN_RATIO), maxChars: platformMaxChars };
  return { minChars: null, maxChars: null };
}

/**
 * Refused BEFORE the model is called (so it costs nothing): a caption that
 * cannot grow by 30% inside the platform's limit, or an empty one to shorten.
 */
export function refuseBeforeCall(
  tool: string,
  body: string,
  platformMaxChars: number,
): EditRejection | null {
  const target = editTarget(tool, body, platformMaxChars);
  if (tool === 'expand' && target.minChars !== null && target.minChars > platformMaxChars) {
    return 'EDIT_CANNOT_GROW';
  }
  if (tool === 'shorten' && charCount(body) < 2) return 'EDIT_NOT_SHORTER';
  return null;
}

/** The measurable line each edit adds to its instruction. */
export function measurableDirective(tool: string, body: string, platformMaxChars: number): string {
  const length = charCount(body);
  const target = editTarget(tool, body, platformMaxChars);
  switch (tool) {
    case 'shorten':
      return (
        `The caption is ${length} characters. Return at most ${target.maxChars} characters ` +
        '(at least 30% shorter). Keep its meaning, its language and every fact it states; cut words, not facts.'
      );
    case 'expand':
      return (
        `The caption is ${length} characters. Return at least ${target.minChars} characters ` +
        `(at least 30% longer) and at most ${platformMaxChars}. Add only what the reference material supports.`
      );
    case 'tone':
      return (
        'The change of tone must be clearly visible to a reader: change the word choice, the greeting ' +
        'or opening and the sentence forms to match the requested tone. Keep every fact and the language.'
      );
    default:
      return '';
  }
}

/** Lower-cased, punctuation and spacing set aside: what a reader would call "the same words". */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 1 for identical, 0 for nothing in common (Levenshtein over normalised code points). */
export function similarity(a: string, b: string): number {
  const x = [...normalise(a)];
  const y = [...normalise(b)];
  if (x.length === 0 && y.length === 0) return 1;
  const longest = Math.max(x.length, y.length);
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= y.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - (previous[y.length] ?? longest) / longest;
}

/** Tools that rewrite the words, and so must change them. */
const REWRITING = new Set(['rewrite', 'shorten', 'expand', 'tone']);

/**
 * The verdict on an answer, checked before the charge: null when it did its
 * job, the reason otherwise. Translate and the hashtag tool are judged by
 * their own rules elsewhere (a translation always changes the words; the
 * hashtag tool never does).
 */
export function checkEdit(
  tool: string,
  before: string,
  after: string,
  platformMaxChars: number,
): EditRejection | null {
  if (!REWRITING.has(tool)) return null;
  const target = editTarget(tool, before, platformMaxChars);
  const length = charCount(after);
  if (tool === 'shorten' && target.maxChars !== null && length > target.maxChars) {
    return 'EDIT_NOT_SHORTER';
  }
  if (tool === 'expand' && target.minChars !== null && length < target.minChars) {
    return 'EDIT_NOT_LONGER';
  }
  if (similarity(before, after) >= NEAR_IDENTICAL_SIMILARITY) return 'EDIT_NO_CHANGE';
  return null;
}

/** The hashtag tool: an answer that adds no tag the post lacks is not charged. */
export function checkHashtags(
  existing: readonly string[],
  proposed: readonly string[],
): EditRejection | null {
  const have = new Set(existing.map((tag) => tag.replace(/^#/, '').toLowerCase()));
  return proposed.some((tag) => !have.has(tag.replace(/^#/, '').toLowerCase()))
    ? null
    : 'EDIT_NO_CHANGE';
}

/** What an operator reads; never the words themselves. */
export const EDIT_REJECTION_REASON: Readonly<Record<EditRejection, string>> = {
  EDIT_NOT_SHORTER: 'The shortened caption did not lose at least 30% of its characters.',
  EDIT_NOT_LONGER: 'The longer caption did not gain at least 30% of its characters.',
  EDIT_NO_CHANGE: 'The edited caption is nearly identical to the original.',
  EDIT_CANNOT_GROW: 'The caption cannot grow by 30% inside the platform limit.',
  EDIT_STALE: 'The caption on screen is not the saved caption.',
};
