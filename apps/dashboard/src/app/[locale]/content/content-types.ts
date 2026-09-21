/**
 * The content types the composer offers, and the only ones it accepts back.
 *
 * ONE LIST, TWO READERS. The compose page renders the selector from it and the
 * manual-create action parses the submitted value against it — a second copy
 * would be a second place for the two to disagree, and the failure mode is
 * silent: an unrecognised type simply falls back and the customer's choice
 * disappears. It lives outside the page because a server action in the parent
 * directory may not import a route module's constants without dragging that
 * module's whole graph along with it.
 */
export const CONTENT_TYPES = [
  'POST',
  'CAROUSEL',
  'STORY',
  'REEL',
  'VIDEO',
  'ARTICLE',
  'THREAD',
] as const;

export type ComposerContentType = (typeof CONTENT_TYPES)[number];

/** The submitted value when the list carries it, and nothing when it does not. */
export function parseContentType(value: unknown): ComposerContentType | undefined {
  return (CONTENT_TYPES as readonly string[]).includes(String(value))
    ? (String(value) as ComposerContentType)
    : undefined;
}
