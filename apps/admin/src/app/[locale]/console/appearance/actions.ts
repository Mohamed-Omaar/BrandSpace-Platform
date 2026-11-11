'use server';

import { cookies } from 'next/headers';
import { colourSchemeSchema, type ColourScheme } from '@brandspace/shared/theme';
import { CONSOLE_COLOUR_SCHEME_COOKIE } from '../../../../server/colour-scheme';

/**
 * PR E — the operator's Appearance choice. The menu item has already drawn it
 * on the page; this keeps it for the next page and the next visit. Setting a
 * cookie in a server action re-renders the current route and drops every page
 * the router kept, so nothing shows the old scheme afterwards. A preference,
 * not an authority: it carries nothing but the scheme.
 */
export async function chooseConsoleColourSchemeAction(
  input: unknown,
): Promise<ColourScheme | null> {
  const choice = colourSchemeSchema.safeParse(input);
  if (!choice.success) return null;
  const store = await cookies();
  store.set(CONSOLE_COLOUR_SCHEME_COOKIE, choice.data, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    secure: true,
    httpOnly: true,
  });
  return choice.data;
}
