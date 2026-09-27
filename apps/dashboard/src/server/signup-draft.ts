/**
 * G8 (prototype v94 Phase 2B-1, D-335) — WHAT A REFUSED SIGN-UP KEEPS.
 *
 * When the server sends the sign-up form back (a short password, an unticked
 * document, a malformed address), the person's name, email and time zone come
 * back with it — never the password, which is never stored, echoed or carried
 * anywhere. They travel in a two-minute httpOnly, same-site cookie rather than
 * the URL, where an email address would sit in the history and any log line
 * that records a path. A successful sign-up deletes it.
 */
export const SIGNUP_DRAFT_COOKIE = 'bs_signup_draft';

export interface SignupDraft {
  readonly name: string;
  readonly email: string;
  readonly timezone: string;
}

/** Bounded and shape-checked both ways: this is the person's own input, echoed back. */
export function encodeSignupDraft(draft: SignupDraft): string {
  return JSON.stringify({
    name: draft.name.slice(0, 120),
    email: draft.email.slice(0, 320),
    timezone: draft.timezone.slice(0, 64),
  });
}

export function decodeSignupDraft(raw: string | undefined): SignupDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const text = (key: string, max: number) =>
      typeof value[key] === 'string' ? (value[key] as string).slice(0, max) : '';
    return { name: text('name', 120), email: text('email', 320), timezone: text('timezone', 64) };
  } catch {
    return null;
  }
}
