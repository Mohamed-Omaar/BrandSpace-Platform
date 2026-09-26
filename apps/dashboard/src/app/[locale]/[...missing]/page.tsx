import { notFound } from 'next/navigation';

/**
 * A PATH THAT MATCHES NO PAGE, inside a locale.
 *
 * Without this, Next.js answered such a path with its own unstyled 404, outside
 * the locale — so `/en/not-a-real-area` looked nothing like the not-found screen
 * a missing record gets, and was in neither language. A catch-all has the
 * lowest priority of any route, so every real page still wins. Here the path
 * reaches the same `notFound()` as everything else, and `[locale]/not-found.tsx`
 * answers: one shape for every miss (D-299), never "No access" (D-322).
 */
export default function UnknownPath(): never {
  notFound();
}
