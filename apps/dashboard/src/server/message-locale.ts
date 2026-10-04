import { cache } from 'react';
import type { MessageLocale } from '../i18n/messages';

/**
 * THE WORDS OF THIS REQUEST (D-470), for the shared server components.
 *
 * A page reads its words from `session.messageLocale`. The components every
 * page shares — the shell, the "no access" page, the settings and billing tabs,
 * the notes panel, the denial notices — are handed only the ROUTE locale, which
 * they also need for links and formatting. They ask here instead of growing a
 * second locale prop at a hundred call sites.
 *
 * `requireWorkspace` records the message locale it resolved; React's `cache`
 * makes the record last exactly one server render. A page always resolves its
 * session before the components it renders run, so they see it. Anything with
 * no workspace — sign-in, the workspace chooser, onboarding before a workspace
 * exists, a server action — finds nothing recorded and reads formal Arabic,
 * which is what D-470 asks of those screens.
 *
 * NOT `server-only`, deliberately: it holds no secret — only which of three
 * dictionaries to read — and the denial text that reads it is unit-tested
 * outside Next.js. A client component has its own way in (`useMessageLocale`);
 * imported on the client this would simply read formal Arabic.
 */
const recorded = cache((): { value: MessageLocale | null } => ({ value: null }));

export function recordMessageLocale(value: MessageLocale): void {
  recorded().value = value;
}

export function requestMessageLocale(locale: string): MessageLocale {
  const value = recorded().value;
  if (locale !== 'ar') return 'en';
  return value?.startsWith('ar') ? value : 'ar';
}
