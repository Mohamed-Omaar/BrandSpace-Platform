'use client';

import { createContext, use, useContext, type ReactNode } from 'react';
import { BOTH, type BothKey } from './dict/both';
import { optionalWith, statusWith, translateWith, type MessageLocale, type Words } from './core';

/**
 * B2 (owner, 2026-11-14) — ONE LANGUAGE PER PAGE, IN THE BROWSER.
 *
 * A client component used to import `./messages.ts`, and with it BOTH
 * dictionaries: 563 KB of script on every page, whatever its language. Now
 * each language is its own script (`import()` of `./dict/en.ts` or
 * `./dict/ar.ts`), cached by the browser like any other, and a page loads
 * only its own: the load starts the moment this module runs — before React
 * hydrates — so the words are there when the page becomes interactive. The
 * server keeps `./messages.ts`, and both sides use the same logic
 * (`./core.ts`).
 */
type Tracked = Promise<Words> & { status?: 'fulfilled'; value?: Words };

const LOADERS: Readonly<Record<MessageLocale, () => Promise<Words>>> = {
  en: () =>
    import('./dict/en').then((m) => ({ locale: 'en', dictionary: m.en, status: m.enStatus })),
  ar: () =>
    import('./dict/ar').then((m) => ({ locale: 'ar', dictionary: m.ar, status: m.arStatus })),
};
const loading = new Map<MessageLocale, Tracked>();

/** One language's words, loaded once; React's `use` reads it without suspending again. */
function loadWords(locale: MessageLocale): Tracked {
  let promise = loading.get(locale);
  if (!promise) {
    const tracked: Tracked = LOADERS[locale]().then((words) => {
      tracked.status = 'fulfilled';
      tracked.value = words;
      return words;
    });
    promise = tracked;
    loading.set(locale, promise);
  }
  return promise;
}

if (typeof document === 'undefined') {
  // On the server both languages are at hand (it renders either).
  void loadWords('en');
  void loadWords('ar');
} else {
  // In the browser: only this page's language, starting now.
  void loadWords(document.documentElement.lang.startsWith('ar') ? 'ar' : 'en');
}

const WordsContext = createContext<Words | null>(null);

/** The `[locale]` layout's provider: this page's language, and only it. */
export function WordsProvider({ locale, children }: { locale: string; children: ReactNode }) {
  const words = use(loadWords(locale === 'ar' ? 'ar' : 'en') as Promise<Words>);
  return <WordsContext.Provider value={words}>{children}</WordsContext.Provider>;
}

/** This page's words. Every page is inside the `[locale]` layout, which provides them. */
export function useWords(): Words {
  const words = useContext(WordsContext);
  if (!words) throw new Error('useWords() is used outside the [locale] layout.');
  return words;
}

/** `t(key)` in this page's language. */
export function useT() {
  return translateWith(useWords());
}

/** A message for a key that might not exist, or `null` (`optionalMessage`). */
export function useOptionalMessage() {
  const words = useWords();
  return (key: string) => optionalWith(words, key);
}

/** `statusMessage` in this page's language. */
export function useStatusMessage() {
  const words = useWords();
  return (code: string | null | undefined, correlationId?: string) =>
    statusWith(words, code, correlationId);
}

/** One of the few words a page shows in a given language, whatever its own (`./dict/both.ts`). */
export function inLanguage(language: MessageLocale, key: BothKey): string {
  return BOTH[language][key];
}
