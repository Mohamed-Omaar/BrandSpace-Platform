/**
 * WHICH LANGUAGE A NEW POST IS WRITTEN IN (D-277).
 *
 * Interface language and content language are DIFFERENT things: a brand that
 * speaks Arabic to its audience may be run by a team whose BrandSpace is in
 * English. So the UI locale never decides this. In order:
 *
 *   1. the author's explicit choice, when the form carried one;
 *   2. the brand's own content preference (`Brand.defaultLocale`);
 *   3. English — the platform default since D-277, which replaced the D-03
 *      reading that made Arabic the silent fallback.
 *
 * PURE, AND NOT `server-only`, so the unit suite pins the order directly.
 */
export type ContentLanguage = 'AR' | 'EN';

export function resolveContentLanguage(
  explicit: unknown,
  brandDefault: ContentLanguage | null | undefined,
): ContentLanguage {
  if (explicit === 'AR' || explicit === 'EN') return explicit;
  return brandDefault ?? 'EN';
}
