import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { resolveColourScheme, type ColourScheme } from '@brandspace/shared/theme';
import { activeLook } from './theme';

/**
 * Each person's light / dark / device choice. The cookie carries it to the
 * first paint and to the screens before sign-in; it is written by the
 * Appearance control (`/[locale]/appearance`).
 */
export const COLOUR_SCHEME_COOKIE = 'bs_color_scheme';

/**
 * THE SCHEME THIS REQUEST RENDERS (P1), decided once, on the server.
 *
 * `resolveColourScheme` is the one rule: the person's choice, then the Look &
 * feel default. The root layout writes the answer on `<html
 * data-color-scheme>`, which is what `/theme.css` keys the dark palette on,
 * and the account menu and the logo read the same answer — so the first
 * paint is already right and nothing changes after hydration.
 */
export const currentColourScheme = cache(async (): Promise<ColourScheme> => {
  const [store, look] = await Promise.all([cookies(), activeLook()]);
  return resolveColourScheme({
    cookie: store.get(COLOUR_SCHEME_COOKIE)?.value,
    fallback: look.dark.mode,
  });
});
