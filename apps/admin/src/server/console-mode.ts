/**
 * SIMPLE AND ADVANCED — TWO PRESENTATIONS OF ONE CONTROL CENTER (D-307).
 *
 * The owner operates BrandSpace in Simple mode; technical operations work in
 * Advanced mode. Both read and write the SAME platform state through the SAME
 * services. The mode is a UI preference and nothing else:
 *
 *   - It is NOT an authorization input. No `requirePageActor` or
 *     `requirePlatformActor` call reads it, no service receives it, and a
 *     tampered value can at worst show somebody the other presentation of a
 *     screen they were already allowed to open.
 *   - It does not hide functionality, only implementation detail. Every
 *     Advanced screen stays reachable from Simple mode by URL and by the
 *     switch, and the Simple screens call the existing server actions.
 *
 * It lives in a cookie rather than a database column because it is a
 * per-browser display preference with no audit meaning, exactly like the
 * sidebar's collapsed state — and a cookie is what lets a server-rendered page
 * choose its presentation on the first paint.
 *
 * Kept out of the `'use server'` module because a server-actions file may only
 * export async functions.
 */

export type ConsoleMode = 'simple' | 'advanced';

/** Simple is the default (owner contract §1): the owner is the first reader. */
export const DEFAULT_CONSOLE_MODE: ConsoleMode = 'simple';

/**
 * `__Host-` pins the cookie to this host, over HTTPS, at path `/` — the same
 * prefix the Support Mode cookie uses. Nothing else about it is sensitive.
 */
export const CONSOLE_MODE_COOKIE = '__Host-bs_console_mode';

/** A year: a preference, not a session. */
export const CONSOLE_MODE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Anything that is not exactly `advanced` is Simple. Unknown never widens. */
export function parseConsoleMode(value: string | null | undefined): ConsoleMode {
  return value === 'advanced' ? 'advanced' : 'simple';
}

/**
 * Where to send the browser after the switch.
 *
 * The destination is a path the FORM supplied, so it is attacker-shaped input
 * and is accepted only when it is a path inside this locale's console. Anything
 * else — another origin, a protocol-relative `//host`, a backslash trick, a
 * different app route — falls back to the console home. A query string is
 * dropped rather than parsed: the flash parameters (`ok`, `error`) belong to
 * the action that produced them, not to a mode switch.
 */
export function safeConsoleReturnPath(
  locale: string,
  candidate: string | null | undefined,
): string {
  const home = `/${locale}/console`;
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 512) {
    return home;
  }
  const path = candidate.split(/[?#]/, 1)[0] ?? '';
  if (path !== home && !path.startsWith(`${home}/`)) return home;
  // `/en/console/..//evil` and friends: only plain path segments survive.
  if (!/^\/[a-z]{2}\/console(\/[A-Za-z0-9._~%-]+)*\/?$/.test(path)) return home;
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) return home;
  return path;
}
