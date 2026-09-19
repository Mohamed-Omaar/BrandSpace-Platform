import 'server-only';
import { AppError, isProduction } from '@brandspace/shared';

/**
 * Absolute links for messages that are read OUTSIDE the product.
 *
 * THE BUG THIS FIXES, AND WHY NOTHING CAUGHT IT FOR SO LONG. Every link the
 * dashboard put in an email was a PATH — `/en/verify?token=…`. While the only
 * email provider was the outbox that was invisible: the message went to a
 * table, a developer read it in a browser already sitting on the dashboard's
 * origin, and the relative path resolved. The moment a real provider sends the
 * same message, the reader is in an inbox on somebody else's origin and the
 * link resolves to nothing, or to their mail host. A customer who cannot click
 * the verification link cannot finish signing up, and nothing anywhere would
 * have said why.
 *
 * It surfaced the first time the end-to-end suite asserted on what was actually
 * SENT rather than on what was recorded, which is the argument for that test.
 *
 * WHY THE FALLBACK IS NOT A DEFAULT ORIGIN. Guessing `localhost:3001`, or
 * reading a host header, would produce a link that works on the machine that
 * generated it and points at an attacker-controlled host the day a header is
 * trusted. Production refuses instead, naming the variable — the same rule and
 * the same message the API's own verification link uses.
 */

/**
 * `PUBLIC_DASHBOARD_BASE_URL` + `path`, or the bare path in development.
 *
 * @param path an absolute path beginning with `/`, already encoded.
 */
export function customerLink(path: string): string {
  const base = process.env['PUBLIC_DASHBOARD_BASE_URL']?.trim().replace(/\/+$/, '');
  if (base) return `${base}${path}`;

  if (isProduction()) {
    throw new AppError(
      'INTERNAL',
      'PUBLIC_DASHBOARD_BASE_URL is required to build a link for an email.',
    );
  }

  /*
   * DEVELOPMENT WITHOUT AN ORIGIN KEEPS THE PATH. A local checkout writes to
   * the outbox and reads it in a table on this same origin, where a path is
   * exactly right — and demanding the variable would make `pnpm dev` fail on a
   * signup for a reason that has nothing to do with development.
   */
  return path;
}
