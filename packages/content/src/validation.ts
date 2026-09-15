import type { ContentValidationState } from '@brandspace/database';
import type { ContentPlatform } from './policy';

/**
 * Does this caption fit the platform it is written for?
 *
 * MEASURED, NOT GUESSED, AND MEASURED IN THE UNIT THE PLATFORM COUNTS IN.
 * `String.prototype.length` counts UTF-16 code units, which is the wrong answer
 * for exactly the text this product exists to write: an emoji outside the BMP
 * is two code units and one character, and Arabic text carrying combining marks
 * is counted differently again. `Intl.Segmenter` over grapheme clusters is what
 * a person means by "characters", so it is what a limit shown to a person is
 * checked against.
 *
 * The result is advisory, not a refusal. A caption over the limit is saved as
 * INVALID and the customer is told; refusing to save their words because a
 * platform they may not even publish to would reject them is the product being
 * pedantic with someone else's work.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function countCharacters(text: string): number {
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

export interface VariantValidation {
  readonly state: ContentValidationState;
  /**
   * Machine-readable reasons. TRANSLATION KEYS and numbers, never prose: the
   * customer reads this in Arabic or English and the SERVICE must not decide which
   * (CLAUDE.md §4).
   */
  readonly errors: readonly {
    readonly key: string;
    readonly limit?: number;
    readonly actual?: number;
  }[];
  readonly characterCount: number;
}

export function validateVariant(
  platform: ContentPlatform,
  variant: {
    body: string | null;
    hashtags?: readonly string[];
    firstComment?: string | null;
  },
): VariantValidation {
  const body = variant.body ?? '';
  const characterCount = countCharacters(body);
  const errors: { key: string; limit?: number; actual?: number }[] = [];

  if (characterCount > platform.maxBodyChars) {
    errors.push({
      key: 'content.validation.bodyTooLong',
      limit: platform.maxBodyChars,
      actual: characterCount,
    });
  }

  const hashtags = variant.hashtags ?? [];
  if (hashtags.length > platform.maxHashtags) {
    errors.push({
      key: 'content.validation.tooManyHashtags',
      limit: platform.maxHashtags,
      actual: hashtags.length,
    });
  }

  if (variant.firstComment && !platform.allowsFirstComment) {
    errors.push({ key: 'content.validation.firstCommentUnsupported' });
  }

  // An EMPTY body is a warning, not an error: a draft in progress is a normal
  // thing to save, and calling it invalid would put a red state on every new
  // post the moment it is created.
  if (body.trim().length === 0) {
    return {
      state: 'WARNINGS',
      errors: [{ key: 'content.validation.bodyEmpty' }],
      characterCount,
    };
  }

  if (errors.length > 0) return { state: 'INVALID', errors, characterCount };
  return { state: 'VALID', errors: [], characterCount };
}
