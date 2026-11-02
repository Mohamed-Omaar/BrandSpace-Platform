import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { getPrisma } from '@brandspace/database';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { resolveColourScheme, type ColourScheme } from '@brandspace/shared/theme';
import { getCustomer } from './customer-context';
import { activeLook } from './theme';

const log = createLogger({ context: { component: 'dashboard.colour-scheme' } });

/**
 * Each person's light / dark / device choice. It is stored on their account
 * (`user."colorScheme"`, P1) and mirrored in this cookie, which carries it to
 * the screens before sign-in and to a device that has not signed in yet. Both
 * are written by the Appearance control (`/[locale]/appearance`).
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
  const [store, look, stored] = await Promise.all([cookies(), activeLook(), storedColourScheme()]);
  return resolveColourScheme({
    stored,
    cookie: store.get(COLOUR_SCHEME_COOKIE)?.value,
    fallback: look.dark.mode,
  });
});

/**
 * The signed-in person's stored choice, or null (signed out, no choice, or the
 * read failed — the cookie and the default then decide, never an error page).
 * The person's own row, read outside any workspace context like the session.
 */
async function storedColourScheme(): Promise<string | null> {
  const customer = await getCustomer().catch(() => null);
  if (!customer) return null;
  try {
    const row = await getPrisma().user.findUnique({
      where: { id: customer.userId },
      select: { colorScheme: true },
    });
    return row?.colorScheme ?? null;
  } catch (error: unknown) {
    log.warn('The stored colour scheme could not be read', internalErrorFields(error));
    return null;
  }
}

/** Stores the signed-in person's choice on their own account; false when signed out. */
export async function storeColourScheme(scheme: ColourScheme): Promise<boolean> {
  const customer = await getCustomer().catch(() => null);
  if (!customer) return false;
  await getPrisma().user.update({
    where: { id: customer.userId },
    data: { colorScheme: scheme },
  });
  return true;
}
