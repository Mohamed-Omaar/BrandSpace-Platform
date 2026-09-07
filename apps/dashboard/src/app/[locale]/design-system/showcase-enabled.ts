import 'server-only';

/**
 * Is the design showcase reachable?
 *
 * TWO CONDITIONS, AND BOTH MUST HOLD:
 *
 *   1. it is opt-in configuration — `BRANDSPACE_DESIGN_SHOWCASE=1`; and
 *   2. the DEPLOYMENT environment is neither production nor staging.
 *
 * So forgetting to unset a variable during a deploy cannot expose it, and
 * neither can setting it deliberately against a real environment.
 *
 * WHY `APP_ENV` AND NOT `NODE_ENV`. `next start` serves a production BUILD and
 * therefore always sets `NODE_ENV=production`, including on a developer's
 * machine and in the end-to-end suite. Keying on it would mean "never
 * reachable", which is not a gate but a deletion — the first version of this
 * file did exactly that and the suite caught it. `APP_ENV` is the deployment
 * environment this repository already uses everywhere else
 * (`currentEnvironment()`), and it is the question that actually matters here.
 *
 * WHAT THIS ROUTE IS. A static gallery of components rendered from fixtures in
 * this directory. It reads no database, resolves no session, and takes no
 * parameter that reaches a query. It therefore weakens no route protection:
 * there is nothing behind it to protect, and it grants no path to anything that
 * is. It is deliberately NOT linked from any navigation.
 *
 * The refusal is `notFound()` rather than a message, so a probe cannot tell a
 * disabled showcase from a route that was never built.
 */
const PROTECTED_ENVIRONMENTS = new Set(['production', 'staging']);

export function showcaseEnabled(): boolean {
  const appEnv = process.env['APP_ENV'] ?? 'development';
  if (PROTECTED_ENVIRONMENTS.has(appEnv)) return false;
  return process.env['BRANDSPACE_DESIGN_SHOWCASE'] === '1';
}
