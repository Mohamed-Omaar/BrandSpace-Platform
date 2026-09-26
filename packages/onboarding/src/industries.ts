import type { IndustryDefinition } from './policy';

/**
 * G6 (prototype v94 Phase 2B-1, D-329) — READING A BRAND'S INDUSTRY AGAINST
 * THE CONFIGURED LIST.
 *
 * `Brand.industry` stays the one place a brand's industry lives. It holds a
 * catalogue KEY when the person picked from the list, or their own words
 * ("Something else"). Only a key reaches the calendar's observances and the
 * Brand Brain Offers question set; free text reaches neither, and nothing is
 * guessed from it.
 */
export function industryKeyFor(
  value: string | null | undefined,
  industries: readonly IndustryDefinition[],
): string | null {
  const stored = value?.trim();
  if (!stored) return null;
  return industries.some((industry) => industry.key === stored) ? stored : null;
}

/** The Offers question set a brand's industry maps to, or null. Read by Brand Brain v2. */
export function offersQuestionSetFor(
  value: string | null | undefined,
  industries: readonly IndustryDefinition[],
): string | null {
  const key = industryKeyFor(value, industries);
  return key
    ? (industries.find((industry) => industry.key === key)?.offersQuestionSet ?? null)
    : null;
}

/** How a stored industry reads to a person: its catalogue name, or their own words. */
export function industryLabel(
  value: string | null | undefined,
  industries: readonly IndustryDefinition[],
  locale: string,
): string | null {
  const stored = value?.trim();
  if (!stored) return null;
  const industry = industries.find((entry) => entry.key === stored);
  if (!industry) return stored;
  return locale === 'ar' ? industry.name.ar : industry.name.en;
}
