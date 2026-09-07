import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { ADMIN_BASE_URL } from './apps';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';

/**
 * Signing in to the Control Center, shared by every admin spec.
 *
 * Extracted when the Phase 3 screens got their own spec file. Two copies of a
 * sign-in helper is two places for the MFA step to drift, and the MFA step is
 * the control D-27 depends on — a spec that quietly stopped performing it
 * would still pass while testing a session the product does not allow.
 *
 * The account is a THROWAWAY created by `pnpm e2e:seed` moments before the
 * run: a generated password, a generated TOTP seed. Nothing here is a real
 * credential and nothing is committed.
 */

export function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error(
      `No end-to-end admin credentials at ${E2E_CREDENTIALS_FILE}.\n` +
        '  Run `pnpm e2e:seed` first (it needs .env.test and a migrated test database).',
    );
  }
}

export function totpCode(secret: string): string {
  return new TOTP({
    issuer: 'BrandSpace Platform',
    label: 'e2e',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate();
}

/** Password step only. The resulting session is deliberately NOT usable. */
export async function submitPassword(page: Page, locale: string): Promise<void> {
  const { email, password } = credentials();
  await page.goto(`${ADMIN_BASE_URL}/${locale}/login`);
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill(password);
  await page.getByTestId('submit').click();
}

/** Full sign-in: password, then MFA. */
export async function signIn(page: Page, locale = 'en'): Promise<void> {
  await submitPassword(page, locale);
  await expect(page).toHaveURL(`${ADMIN_BASE_URL}/${locale}/mfa`);
  await page.getByTestId('mfa-code').fill(totpCode(credentials().totpSecret));
  await page.getByTestId('submit').click();
  await expect(page).toHaveURL(`${ADMIN_BASE_URL}/${locale}/console`);
}
