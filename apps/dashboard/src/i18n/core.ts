import type { EnglishKey } from './dict/en';

/**
 * B2 (owner, 2026-11-14) — ONE LANGUAGE PER PAGE: THE LOGIC, WITHOUT THE WORDS.
 *
 * Everything here works on ONE language's `Words` and imports no dictionary,
 * so a client component that uses it ships only the language its page is in
 * (`./words-en.tsx` / `./words-ar.tsx`). The server's `./messages.ts` holds
 * both languages and calls the same functions, so the two sides cannot drift.
 */

export type MessageLocale = 'en' | 'ar';

/** One language's words: the dictionary and the fixed status sentences. */
export interface Words {
  readonly locale: MessageLocale;
  readonly dictionary: Readonly<Record<EnglishKey, string>>;
  readonly status: Readonly<Record<string, string>>;
}

export function translateWith(words: Words) {
  return (key: EnglishKey): string => words.dictionary[key];
}

/**
 * A message for a key that MIGHT NOT EXIST, or `null` (see `optionalMessage`
 * in `./messages.ts` for why this exists).
 */
export function optionalWith(words: Words, key: string): string | null {
  const dictionary: Record<string, string | undefined> = words.dictionary;
  const value = Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Render a status code. An unrecognised code renders nothing at all. */
function fixedStatusText(words: Words, code: string): string | null {
  return Object.hasOwn(words.status, code) ? (words.status[code] ?? null) : null;
}

/**
 * THE PERMISSIONS ONLY THE WORKSPACE OWNER HOLDS — a mirror of
 * `OWNER_ONLY_PERMISSION_KEYS` in `@brandspace/shared`, which derives them
 * from the role catalogue. Mirrored rather than imported because this
 * module is loaded in client components and by the browser suite, where
 * the shared package (Node built-ins included) cannot be; a unit test fails
 * the moment the two differ.
 */
export const OWNER_ONLY_PERMISSIONS: readonly string[] = [
  'workspace.delete',
  'workspace.transfer_ownership',
  'billing.manage',
  // G4 / Q23 (D-333): requiring two-step verification for everyone.
  'workspace.security.manage',
];

/**
 * A REFUSED ACTION THAT NAMES THE PERMISSION (E6).
 *
 * `FORBIDDEN:<permission>` or `FORBIDDEN_OWNER:<permission>`, as the action's
 * failure path writes it (`actionErrorCode`). The permission is only ever a
 * lookup key: it becomes words through `perms.desc.*`, so a key the dictionary
 * does not hold — a typo, a crafted URL — falls back to the plain FORBIDDEN
 * sentence rather than being echoed. No name reaches the URL; the banner says
 * "the owner", and the screens that know the names say them (PermissionNotice).
 */
function deniedActionText(words: Words, code: string): string | null {
  const match = /^FORBIDDEN(?:_OWNER)?:([a-z_]+(?:\.[a-z_]+)+)$/.exec(code);
  if (!match?.[1]) return null;
  const key = match[1];
  const permission = optionalWith(words, `perms.desc.${key}`);
  if (!permission) return fixedStatusText(words, 'FORBIDDEN');
  const fill = (template: string) =>
    (optionalWith(words, template) ?? '').replace('{permission}', permission);
  /*
   * "OWNER-ONLY" IS DECIDED FROM THE PERMISSION, NEVER FROM THE URL. The code
   * arrives in the `error` query parameter, so its `_OWNER` suffix is whatever
   * a link says; a crafted one must not make an ordinary permission read as
   * owner-only (or the reverse). The role catalogue is the one source.
   */
  return OWNER_ONLY_PERMISSIONS.includes(key)
    ? fill('perms.denied.ownerOnly')
    : `${fill('perms.denied.you')} ${fill('perms.denied.hintOwner')}`;
}

/**
 * Fixed text for the CODES a server action puts in the URL.
 *
 * Same construction as the Control Center (R-05): the client receives a code
 * from a closed set and the page chooses the words, so no exception text can
 * reach the address bar, the browser history or an access log.
 */
export function statusWith(
  words: Words,
  code: string | null | undefined,
  correlationId?: string,
): string | null {
  if (!code) return null;
  const text = deniedActionText(words, code) ?? fixedStatusText(words, code);
  if (text === null) return null;
  // The correlation id is an opaque uuid we generated: the ONE variable part,
  // and the only thing joining this screen to the redacted server log.
  const safeId = correlationId && /^[0-9a-f-]{36}$/i.test(correlationId) ? correlationId : null;
  if (!safeId) return text;
  return words.locale === 'ar' ? `${text} (المرجع: ${safeId})` : `${text} (reference: ${safeId})`;
}
