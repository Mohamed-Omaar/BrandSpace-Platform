import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { resolveColourScheme, type ColourScheme } from '@brandspace/shared/theme';
import { currentEnvironment, getConfigService } from './platform-context';

const log = createLogger({ context: { component: 'admin.colour-scheme' } });

/**
 * PR E — EACH OPERATOR'S LIGHT / DARK / DEVICE CHOICE IN THE CONTROL CENTER.
 *
 * A cookie on this device (the dashboard's own choice lives on the customer's
 * account, a different realm). Host-only and secure, like the mode cookie.
 */
export const CONSOLE_COLOUR_SCHEME_COOKIE = '__Host-bs_cc_color_scheme';

/**
 * THE SCHEME THIS REQUEST RENDERS, decided once, on the server, so the first
 * paint is already right: the operator's choice, then the Look & feel default
 * — but only while the Control Center wears the theme. In safe mode ("Keep the
 * Control Center on the original look", the default) there is no theme here,
 * so with no choice it is light, as it always was.
 */
export const currentConsoleColourScheme = cache(async (): Promise<ColourScheme> => {
  const store = await cookies();
  let fallback: ColourScheme = 'light';
  try {
    const theme = await getConfigService().get('theme', currentEnvironment());
    if (!theme.controlCenterOriginal) fallback = theme.look.dark.mode;
  } catch (error: unknown) {
    log.warn('The theme could not be read; light is the default', internalErrorFields(error));
  }
  return resolveColourScheme({
    cookie: store.get(CONSOLE_COLOUR_SCHEME_COOKIE)?.value,
    fallback,
  });
});
