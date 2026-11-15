/**
 * Customer dashboard messages.
 *
 * CLAUDE.md §4: every user-facing string is a key, and both locales are
 * first-class. Typed, so a missing key is a compile error rather than a
 * placeholder that ships.
 */

import { ar, arStatus } from './dict/ar';
import { en, enStatus } from './dict/en';
import {
  OWNER_ONLY_PERMISSIONS,
  optionalWith,
  statusWith,
  translateWith,
  type MessageLocale,
  type Words,
} from './core';

export const messages = { ar, en } as const;

export type MessageKey = keyof (typeof messages)['en'];

/**
 * WHICH WORDS A READER GETS (round 4, Step 6 — replaces D-470).
 *
 * ONE ARABIC FOR EVERY COUNTRY. The route locale (`en` / `ar`) decides the URL,
 * `dir`, number and date formatting and the words: an Arabic reader reads the
 * product's formal Arabic whatever the workspace's country. The Egyptian layer
 * (`ar-EG`) and the country switch that chose it are gone; no runtime path can
 * select another dictionary.
 */
export type { MessageLocale, Words };

const WORDS: Readonly<Record<MessageLocale, Words>> = {
  ar: { locale: 'ar', dictionary: ar, status: arStatus },
  en: { locale: 'en', dictionary: en, status: enStatus },
};

/** One language's words, for the language-independent logic in `./core.ts`. */
export function wordsFor(locale: string): Words {
  return WORDS[messageLocaleFor(locale)];
}

export function messageLocaleFor(locale: string): MessageLocale {
  return locale === 'ar' ? 'ar' : 'en';
}

type Dictionary = Readonly<Record<MessageKey, string>>;

/**
 * The dictionary for a locale. Anything that is not Arabic is English, as
 * `translator` has always treated an unknown locale.
 */
export function dictionaryFor(locale: string): Dictionary {
  return locale === 'ar' ? messages.ar : messages.en;
}

export function translator(locale: string) {
  return translateWith(wordsFor(locale));
}

/**
 * A message for a key that MIGHT NOT EXIST, or `null`.
 *
 * WHY THIS EXISTS, AND WHAT IT REPLACES. Three screens render a label built
 * from a value the DATABASE supplies — an audit entry's actor type, a
 * notification's template key, a publish job's failure code — so the key is
 * only known at runtime and may have no translation. Each of them asked
 * `translator` and tested `translated === key` to detect the miss.
 *
 * THAT TEST IS ALWAYS FALSE. `translator` returns `dictionary[key]`, so a miss
 * is `undefined` rather than the key — the comparison never matches, the
 * fallback never runs, and `undefined` is returned as the sentence. React
 * renders nothing, so a failed publish reported no failure at all and an
 * unrecognised notification showed an empty headline. The bug was invisible for
 * exactly as long as every key happened to exist.
 *
 * `MessageKey` DELIBERATELY NOT REQUIRED: the whole point is a key the type
 * system cannot know. The narrowing is done here, once, instead of at three
 * call sites that each got it wrong.
 */
/**
 * An evidence row's label, as a sentence (D-292). The analytics and strategy
 * engines store a stable `labelKey` ("content.pillar_unpublished"); showing
 * that key was technical vocabulary on a customer screen (D-277 §41). A key
 * with no sentence yet reads as the neutral word "Evidence", never as itself.
 */
/**
 * A CITATION IN WORDS (Phase 6 final acceptance, D-306): "evidence 1, 2" —
 * the numbers of the evidence rows listed beside it — never the internal
 * `e1` shorthand the evidence store uses.
 */
export function evidenceRefs(locale: string, refs: readonly number[]): string {
  const joined = refs.join(locale.startsWith('ar') ? '، ' : ', ');
  return (optionalMessage(locale, 'insights.evidenceRefs') ?? '{refs}').replace('{refs}', joined);
}

/**
 * A ROLE AS THE CUSTOMER READS IT (Phase 6 final acceptance, D-302).
 *
 * The catalogue names its two top roles after the backend's tenancy unit
 * ("Workspace Owner"), and the customer never meets a workspace. The roles
 * themselves, their keys and their permissions are unchanged; only these two
 * names are said the customer's way. Every other role name passes through.
 */
const CUSTOMER_ROLE_NAMES: Readonly<Record<string, string>> = {
  'Workspace Owner': 'Owner',
  'Workspace Admin': 'Admin',
  'مالك مساحة العمل': 'المالك',
  'مدير مساحة العمل': 'المدير',
};

export function customerRoleName(name: string): string {
  return CUSTOMER_ROLE_NAMES[name] ?? name;
}

export function evidenceLabel(locale: string, labelKey: string | null | undefined): string {
  return (
    (labelKey ? optionalMessage(locale, `insights.evidenceLabel.${labelKey}`) : null) ??
    optionalMessage(locale, 'insights.evidenceLabel.unknown') ??
    ''
  );
}

export function optionalMessage(locale: string, key: string): string | null {
  return optionalWith(wordsFor(locale), key);
}

export { OWNER_ONLY_PERMISSIONS };

/**
 * C8 (Phase 2B-2b) — A `?ok=` CODE AS A TOAST. The same words `statusMessage`
 * gives the banner, handed to the shell's `ToastHost` instead; an unknown code
 * shows nothing, exactly as the banner did.
 */
export function successFlash(
  code: string | null | undefined,
  locale: string,
): { readonly tone: 'success'; readonly message: string } | undefined {
  const message = statusMessage(code, locale);
  return message === null ? undefined : { tone: 'success', message };
}

export function statusMessage(
  code: string | null | undefined,
  locale: string,
  correlationId?: string,
): string | null {
  return statusWith(wordsFor(locale), code, correlationId);
}
