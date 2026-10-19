/**
 * WHERE SIGN-IN SENDS A PERSON BACK TO (`?next=`), or null.
 *
 * Only a relative in-app path is honoured, so `next` can never become an open
 * redirect to another origin (docs/SECURITY.md §9): it must start with one
 * slash, not two, not a backslash, carry no control character, and stay short.
 *
 * D-566 — shared by sign-in AND the two-step challenge. The challenge used to
 * drop `next`, so a person with two-step sign-in who arrived from an AI app's
 * "Connect" button landed on Home instead of the consent screen.
 *
 * PURE, AND NOT `server-only`: the unit suite imports it directly.
 */
export function signInReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > 4000) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return raw;
}
