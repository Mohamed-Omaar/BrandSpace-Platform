'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { MessageLocale } from './messages';

/**
 * THE WORDS OF THIS SCREEN, for client components.
 *
 * The workspace shell provides the message locale its request resolved, and a
 * client component that translates for itself reads it here. A component
 * outside the shell (sign-in, an error boundary) finds no provider and reads
 * the route locale. Since round 4, Step 6, the two are always the same: one
 * formal Arabic for every country.
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
