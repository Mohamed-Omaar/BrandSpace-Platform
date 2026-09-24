'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  CONSOLE_MODE_COOKIE,
  CONSOLE_MODE_MAX_AGE_SECONDS,
  parseConsoleMode,
  safeConsoleReturnPath,
} from '../../../../server/console-mode';
import { requirePlatformActor } from '../../../../server/platform-context';

/**
 * Switch the Control Center between Simple and Advanced (D-307).
 *
 * A SERVER ACTION rather than a route handler so the framework's origin check
 * applies: a cross-site form cannot flip an operator's presentation.
 *
 * It requires a signed-in operator — any admin-capable role, no particular
 * permission — because it is only reachable from inside the console and has
 * nothing to do for anybody else. It writes no audit event: it changes what
 * one browser draws, not platform state, exactly like the sidebar's collapse.
 */
export async function setConsoleModeAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? '') === 'ar' ? 'ar' : 'en';
  const signedIn = await requirePlatformActor().then(
    () => true,
    () => false,
  );
  if (!signedIn) redirect(`/${locale}/login`);
  const mode = parseConsoleMode(String(formData.get('mode') ?? ''));
  const store = await cookies();
  store.set(CONSOLE_MODE_COOKIE, mode, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: CONSOLE_MODE_MAX_AGE_SECONDS,
  });
  redirect(safeConsoleReturnPath(locale, String(formData.get('next') ?? '')));
}
