import { expect, test, type Page } from '@playwright/test';
import { ADMIN_BASE_URL } from './apps';
import { signIn } from './admin-session';

/**
 * #81 NOTE — AN INTEGRATION PAGE NEVER SHOWS A STORED STATE TOKEN.
 *
 * The Facebook entry in Arabic read "never_tested" for its connection. Every
 * state value the page shows — the connection, each check's outcome and the
 * environments — is now a word, in both languages; the stored token stays on
 * a `data-*` attribute for tests and nothing else.
 */

const RAW_TOKENS = [
  'never_tested',
  'not_configured',
  'NOT_CONFIGURED',
  'REFUSED',
  'FAILED',
  'DEVELOPMENT',
  'STAGING',
  'PRODUCTION',
];

const CONNECTION = {
  ar: {
    ok: 'يعمل',
    failed: 'فشل',
    never_tested: 'لم يُختبر',
    not_configured: 'غير مُهيّأ',
    refused: 'مرفوض',
  },
  en: {
    ok: 'Working',
    failed: 'Failed',
    never_tested: 'Never tested',
    not_configured: 'Not configured',
    refused: 'Refused',
  },
} as const;

async function expectNoRawToken(page: Page, testId: string): Promise<void> {
  const text = await page.getByTestId(testId).innerText();
  for (const token of RAW_TOKENS) expect(text, `${testId} shows ${token}`).not.toContain(token);
}

for (const locale of ['ar', 'en'] as const) {
  test(`the Facebook entry names its connection state in ${locale}`, async ({ page }) => {
    await signIn(page, locale);
    await page.goto(`${ADMIN_BASE_URL}/${locale}/console/integrations/social/facebook`);

    const connection = page.getByTestId('detail-connection');
    const state = (await connection.getAttribute('data-state')) as keyof (typeof CONNECTION)['en'];
    expect(Object.keys(CONNECTION.en)).toContain(state);
    await expect(connection).toHaveText(CONNECTION[locale][state]);

    await expectNoRawToken(page, 'detail-connection');
    await expectNoRawToken(page, 'detail-environments');
  });

  test(`a check's outcome is a word in ${locale}`, async ({ page }) => {
    await signIn(page, locale);
    await page.goto(`${ADMIN_BASE_URL}/${locale}/console/integrations/storage/filesystem`);
    await page.getByTestId('test-connection').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'CONNECTION_TESTED');

    const outcome = page.locator('[data-testid^="history-outcome-"]').first();
    await expect(outcome).toHaveAttribute('data-outcome', 'OK');
    await expect(outcome).toHaveText(locale === 'ar' ? 'نجح' : 'Passed');
    await expect(page.getByTestId('detail-connection')).toHaveText(CONNECTION[locale].ok);
  });
}
