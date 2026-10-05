'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { MessageLocale } from './messages';

/**
 * THE WORDS OF THIS SCREEN, for client components (D-470).
 *
 * The workspace shell provides the message locale its request resolved — `ar-EG`
 * for an Arabic reader in an Egyptian workspace — and a client component that
 * translates for itself reads it here. A component outside the shell (sign-in,
 * an error boundary) finds no provider and reads the route locale: formal
 * Arabic, as D-470 asks of every screen before a workspace.
 */
const MessageLocaleContext = createContext<MessageLocale | null>(null);

export function MessageLocaleProvider({
  value,
  children,
}: {
  value: MessageLocale;
  children: ReactNode;
}) {
  return <MessageLocaleContext.Provider value={value}>{children}</MessageLocaleContext.Provider>;
}

/** The message locale for `translator`; `locale` is the route locale this component already has. */
export function useMessageLocale(locale: string): MessageLocale {
  const provided = useContext(MessageLocaleContext);
  if (locale !== 'ar') return 'en';
  return provided?.startsWith('ar') ? provided : 'ar';
}
