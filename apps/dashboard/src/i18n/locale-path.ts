/**
 * THE SAME PAGE, IN THE OTHER LANGUAGE.
 *
 * THE DEFECT THIS REPLACES. The shell built the language switcher's href from
 * `activePath` — the NAV ITEM's path, which is a different thing from the route
 * the reader is on. On `/en/content/compose?item=…` that is `/content`, so
 * switching to Arabic dropped the composer and the draft being edited. On the
 * routes that pass no `activePath` at all it fell back to `/overview`, so
 * changing language moved the reader to a page they had not asked for. The
 * query string went too, and with it every filter, the asset cursor and the
 * selected row.
 *
 * A PURE FUNCTION, SEPARATE FROM THE COMPONENT, so the rule can be tested
 * without rendering a shell — and so the one place that decides it is a place a
 * test can point at.
 */

const LOCALES = new Set(['ar', 'en']);

/**
 * Swap the locale segment of a path, keeping everything after it.
 *
 * FALLS BACK RATHER THAN GUESSES. A path that does not begin with a known
 * locale is not a route this switcher belongs on, and inventing a target for it
 * would send the reader somewhere arbitrary; the caller's own fallback is a
 * better answer than a clever one.
 *
 * THE QUERY IS CARRIED VERBATIM. It holds the filters, the pagination cursor
 * and the selected row — the reader's position within the page, which is
 * exactly what "the same page" has to mean for this to be worth anything. The
 * fragment is not, because it never reaches the server.
 */
export function switchLocalePath(
  requestPath: string | null | undefined,
  target: string,
  fallback: string,
): string {
  if (!requestPath || !requestPath.startsWith('/')) return fallback;
  const [pathname = '', query = ''] = requestPath.split('?', 2);
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.length === 0 || !LOCALES.has(segments[0] ?? '')) return fallback;
  const rest = segments.slice(1).join('/');
  return `/${target}${rest ? `/${rest}` : ''}${query ? `?${query}` : ''}`;
}
