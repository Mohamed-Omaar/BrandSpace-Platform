import { cookies } from 'next/headers';
import { CONSOLE_MODE_COOKIE, parseConsoleMode, type ConsoleMode } from './console-mode';

/**
 * The reader's chosen presentation, for a server component.
 *
 * Read per request. Never cached, never passed to a service, never consulted
 * by an authorization check (D-307).
 */
export async function getConsoleMode(): Promise<ConsoleMode> {
  const store = await cookies();
  return parseConsoleMode(store.get(CONSOLE_MODE_COOKIE)?.value);
}
