/**
 * Validation for the Platform Owner's seed password.
 *
 * The seed used to fall back to a literal, committed password when
 * `SEED_PLATFORM_PASSWORD` was unset. A known credential in source control is a
 * known credential everywhere it is ever run — including against a staging
 * database someone pointed a local `.env` at by mistake. There is no fallback
 * any more: either the operator supplies a real value or no login-capable owner
 * is created.
 *
 * Extracted into its own module so it can be unit-tested without a database.
 */

/** Long enough that it cannot be a habit or a word. */
export const MIN_SEED_PASSWORD_LENGTH = 16;

/**
 * Values that look like they came from an example file rather than from a
 * person. Matched case-insensitively as substrings, because
 * `REPLACE_WITH_A_STRONG_PASSWORD_1` is no better than `REPLACE_WITH`.
 */
const PLACEHOLDER_MARKERS = [
  'replace_with',
  'replace-with',
  'changeme',
  'change-me',
  'placeholder',
  'example',
  'password123',
  'yourpassword',
  'brandspace-dev-owner',
  'todo',
  'xxxx',
];

export class SeedPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedPasswordError';
  }
}

/**
 * Validate the supplied seed password, or explain why it is unusable.
 *
 * NEVER includes the value in the message. A seed runs in terminals, CI logs
 * and screenshots; an error that echoes the rejected password would put it in
 * all three.
 */
export function assertUsableSeedPassword(value: string): void {
  const trimmed = value.trim();

  if (trimmed === '') {
    throw new SeedPasswordError(
      'SEED_PLATFORM_PASSWORD is empty. Set it to a strong, local-only value.',
    );
  }
  if (trimmed.length < MIN_SEED_PASSWORD_LENGTH) {
    throw new SeedPasswordError(
      `SEED_PLATFORM_PASSWORD must be at least ${MIN_SEED_PASSWORD_LENGTH} characters. ` +
        'The value itself is deliberately not printed.',
    );
  }

  const lowered = trimmed.toLowerCase();
  const marker = PLACEHOLDER_MARKERS.find((m) => lowered.includes(m));
  if (marker) {
    throw new SeedPasswordError(
      'SEED_PLATFORM_PASSWORD still looks like a placeholder from an example file. ' +
        'Choose a real, local-only value. The value itself is deliberately not printed.',
    );
  }
}

/**
 * Resolve the seed password from the environment.
 *
 * Returns `null` when the variable is absent — the caller then creates the
 * Platform Owner WITHOUT a password, so the account exists but cannot be signed
 * into. That is the fail-closed outcome: no default credential is ever created.
 * A value that is present but weak is a hard error, because it means somebody
 * tried and got it wrong, and silently ignoring that would be worse.
 */
export function resolveSeedPassword(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env['SEED_PLATFORM_PASSWORD'];
  if (raw === undefined) return null;
  assertUsableSeedPassword(raw);
  return raw.trim();
}

/**
 * The same rule for the seeded CUSTOMER owners (Phase 2B).
 *
 * Identical policy, deliberately: a development customer password committed to
 * source control is a known credential for every database the seed touches,
 * exactly like the platform one that R-04 removed. Absent -> the owners are
 * created passwordless and must be invited.
 */
export function resolveCustomerSeedPassword(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env['SEED_CUSTOMER_PASSWORD'];
  if (raw === undefined) return null;
  assertUsableSeedPassword(raw);
  return raw.trim();
}
