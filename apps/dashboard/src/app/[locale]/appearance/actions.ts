'use server';

import { cookies } from 'next/headers';
import { colourSchemeSchema, type ColourScheme } from '@brandspace/shared/theme';
import { COLOUR_SCHEME_COOKIE, storeColourScheme } from '../../../server/colour-scheme';

const YEAR = 60 * 60 * 24 * 365;

/**
 * PR E — THE APPEARANCE CHOICE, WITHOUT A PAGE CHANGE.
 *
 * The account menu's Appearance item used to be a link to `/appearance`, which
 * set the cookie and redirected back. The router followed that redirect as a
 * SOFT navigation, and a soft navigation never re-renders the root layout — so
 * `<html data-color-scheme>` kept the old value, and pages the router had kept
 * from earlier (a hovered link is held 30 s, `staleTimes.static`) kept the old
 * menu label and logo: "it needs a refresh, and some areas stay in the old
 * theme".
 *
 * The item now changes the page's attribute itself, at once, and calls this
 * action. A server action that sets a cookie makes Next.js re-render the
 * current route and drop every page it kept, so nothing held from before the
 * switch can be shown afterwards. The value is parsed here, as any input is;
 * the link stays as the fallback without JavaScript.
 */
export async function chooseColourSchemeAction(input: unknown): Promise<ColourScheme | null> {
  const choice = colourSchemeSchema.safeParse(input);
  if (!choice.success) return null;
  // P1: on the person's account when signed in, so every device follows it.
  await storeColourScheme(choice.data).catch(() => false);
  const store = await cookies();
  store.set(COLOUR_SCHEME_COOKIE, choice.data, {
    path: '/',
    maxAge: YEAR,
    sameSite: 'lax',
    // Secure unconditionally, as the session and brand cookies are; localhost
    // counts as a secure origin, so nothing local needs the exception.
    secure: true,
    httpOnly: true,
  });
  return choice.data;
}
