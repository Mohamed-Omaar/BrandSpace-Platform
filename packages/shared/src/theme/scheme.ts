import { colourSchemeSchema, type ColourScheme } from './schema';

/**
 * THE ONE RULE FOR LIGHT, DARK AND DEVICE (P1).
 *
 * The person's own choice wins: the one stored on their account, then the
 * cookie that carries it to the first paint (and before sign-in). With no
 * choice, the Look & feel default. `system` is not resolved here: it is
 * written to the page as `system`, and the stylesheet's
 * `prefers-color-scheme` rule follows the device live.
 *
 * Every caller — the page's `<html>`, the account menu, the logo — asks this
 * function, so no two parts of a page can disagree.
 */
export function resolveColourScheme(input: {
  readonly stored?: unknown;
  readonly cookie?: unknown;
  readonly fallback: ColourScheme;
}): ColourScheme {
  for (const candidate of [input.stored, input.cookie]) {
    const parsed = colourSchemeSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return input.fallback;
}

/** The next choice the account menu offers: light → dark → device → light. */
export function nextColourScheme(current: ColourScheme): ColourScheme {
  return current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
}
