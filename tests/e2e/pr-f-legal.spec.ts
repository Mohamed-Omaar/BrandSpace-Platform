import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';

/**
 * PR F, Q11 — THE PUBLIC LEGAL PAGES. `/terms`, `/privacy` and `/data-deletion`
 * open for anyone, signed in or not, in both languages; each says it is a
 * draft awaiting legal review, names its version, draws every placeholder
 * highlighted, and links to the other two. Sign-up links the document's name
 * to its page instead of printing a raw version label.
 */

const DOCUMENTS = ['terms', 'privacy', 'data-deletion'] as const;

for (const locale of ['en', 'ar'] as const) {
  test(`the legal pages are public and complete (${locale})`, async ({ browser }) => {
    // A fresh context: no session cookie at all.
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const key of DOCUMENTS) {
      const response = await page.goto(`${DASHBOARD_BASE_URL}/${locale}/${key}`);
      expect(response?.status(), key).toBe(200);
      await expect(page).toHaveURL(new RegExp(`/${locale}/${key}$`));
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(page.getByTestId('legal-document')).toHaveAttribute('data-document', key);
      await expect(page.getByTestId('legal-draft-notice')).toBeVisible();
      await expect(page.getByTestId('legal-version')).toContainText('2026-10 beta draft');
      await expect(page.getByTestId(`legal-tab-${key}`)).toHaveAttribute('aria-current', 'page');
      for (const other of DOCUMENTS) {
        await expect(page.getByTestId(`legal-tab-${other}`)).toHaveAttribute(
          'href',
          `/${locale}/${other}`,
        );
      }
      expect(await page.getByTestId('legal-placeholder').count(), key).toBeGreaterThan(0);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(results.violations, key).toEqual([]);
    }
    // The clause every upload control links to.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/terms#uploads`);
    await expect(page.locator('#uploads')).toBeVisible();
    await context.close();
  });

  test(`sign-up links the terms to their page and prints no raw version (${locale})`, async ({
    page,
  }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-up`);
    const accept = page.getByTestId('accept-terms-of-service');
    await expect(accept.getByRole('link')).toHaveAttribute('href', `/${locale}/terms`);
    await expect(accept).not.toContainText('fixture-2026-09-01');
  });
}
