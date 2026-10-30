import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ADMIN_BASE_URL, DASHBOARD_BASE_URL } from './apps';
import { signIn } from './admin-session';
import { expectNoHorizontalOverflow } from './overflow';

/**
 * CONTROL CENTER → SIMPLE → LOOK & FEEL (LF).
 *
 * This suite never ACTIVATES a look. An activated theme reaches every page of
 * every other suite running beside it within a minute, and their screenshots
 * would then be comparing a theme with the original. Activation is the
 * configuration service's own lifecycle (draft → validate → impact →
 * activate → audit), and the theme domain's refusal of an unreadable look is
 * pinned in tests/unit/theme.test.ts. What is checked here is everything a
 * person sees and does short of that: the page in both languages, the live
 * preview, the contrast refusal, the recovery link, the original look's empty
 * stylesheet and each person's own dark-mode choice.
 */
test.describe('Look & feel', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`the page, its live preview and its refusal (${locale})`, async ({ page }) => {
      await signIn(page, locale, { mode: 'simple' });
      await page.getByTestId('nav-nav.look').click();
      await expect(page).toHaveURL(`${ADMIN_BASE_URL}/${locale}/console/look`);
      const preview = page.getByTestId('lf-preview');
      await expect(preview).toBeVisible();
      await expect(page.getByTestId('lf-no-issues')).toBeVisible();
      await expectNoHorizontalOverflow(page, `look ${locale}`);

      // A preset redraws the preview, and only the preview.
      await page.getByTestId('lf-preset-calm').click();
      await expect
        .poll(() =>
          preview.evaluate((el) =>
            getComputedStyle(el).getPropertyValue('--bs-brand-purple').trim(),
          ),
        )
        .toBe('#4f5bd5');
      const outside = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--bs-brand-purple').trim(),
      );
      expect(outside).not.toBe('#4f5bd5');

      // Dark, in the preview box alone.
      await page.getByTestId('lf-preview-dark').click();
      await expect(preview).toHaveAttribute('data-color-scheme', 'dark');

      // A colour that cannot be read is refused, with a reason, before it is sent.
      await page.getByTestId('lf-colours-primary').fill('#ffee00');
      await expect(page.getByTestId('lf-issues')).toBeVisible();
      await expect(page.getByTestId('lf-activate-submit')).toBeDisabled();

      const axe = await new AxeBuilder({ page }).analyze();
      expect(
        axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
      ).toEqual([]);
    });
  }

  test('the recovery link is there for the platform owner', async ({ page }) => {
    await signIn(page, 'en', { mode: 'simple' });
    await page.goto(`${ADMIN_BASE_URL}/en/console/look/recover`);
    await expect(page.getByTestId('lf-recover-submit')).toBeVisible();
  });

  test('the original look writes nothing; the Control Center keeps it by default', async ({
    request,
  }) => {
    const customer = await request.get(`${DASHBOARD_BASE_URL}/theme.css`);
    expect(customer.ok()).toBe(true);
    expect(customer.headers()['content-type']).toContain('text/css');
    // No light override; nothing but whitespace when the person has not chosen dark.
    expect((await customer.text()).trim()).toBe('');
    const console = await request.get(`${ADMIN_BASE_URL}/theme.css`);
    expect((await console.text()).trim()).toBe('');
  });

  test("each person's dark choice is theirs: a cookie, and the dark palette", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const response = await page.request.get(
      `${DASHBOARD_BASE_URL}/en/appearance?to=dark&back=${encodeURIComponent('/en/sign-in')}`,
      { maxRedirects: 0 },
    );
    expect(response.status()).toBe(303);
    // A relative address, so the cookie and the session stay on this host.
    expect(response.headers()['location']).toBe('/en/sign-in');
    const css = await (await page.request.get(`${DASHBOARD_BASE_URL}/theme.css`)).text();
    expect(css).toContain('color-scheme: dark;');
    // Another person, another device: still the original look.
    const other = await browser.newContext();
    const theirs = await (await other.request.get(`${DASHBOARD_BASE_URL}/theme.css`)).text();
    expect(theirs.trim()).toBe('');
    await context.close();
    await other.close();
  });
});
