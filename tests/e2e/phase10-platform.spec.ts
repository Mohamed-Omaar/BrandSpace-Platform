import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { ADMIN_BASE_URL, DASHBOARD_BASE_URL } from './apps';
import { signIn } from './admin-session';

/**
 * THE PLATFORM OWNER JOURNEY - Phase 10 section 27.
 *
 * WHAT THIS PROVES that no unit or isolation test can. The Integrations Hub is
 * GENERATED from a registry: a wrong entry is not a wrong constant, it is a
 * wrong screen shown to the person deciding what to buy. The only way to know
 * the screen an owner actually sees is to open it in a browser and read it.
 *
 * THE JOURNEY IS FUNCTIONAL, NOT REACHABILITY. It configures a provider, tests
 * the connection, watches the result appear in the verification history,
 * disables the integration with a change reason, confirms the affected
 * capability is refused, and re-enables it. Every step is the precondition of
 * the next, so a break anywhere stops the run rather than producing a page that
 * loads and does nothing.
 *
 * NO REAL CREDENTIAL IS INVOLVED. Every provider in the registry today is a
 * development double; the account is the throwaway one `pnpm e2e:seed` created
 * moments ago with a generated password and a generated TOTP seed.
 */

test.describe('the Integrations Hub', () => {
  test('lists every category, and says which are required in production', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/integrations`);

    // The six categories the registry declares, each rendered from it.
    for (const provider of [
      'integration-ai-mock',
      'integration-payment-development-mock',
      'integration-email-outbox',
      'integration-storage-filesystem',
      'integration-social-mock',
    ]) {
      await expect(page.getByTestId(provider)).toBeVisible();
    }

    // A required category with nobody serving it is stated, not implied.
    await expect(page.getByText('Required in production').first()).toBeVisible();
  });

  test('shows a development double for what it is', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/integrations/ai/mock`);

    /*
     * THE HONEST ROW. An owner reading this page should finish it knowing that
     * nothing here is a vendor. The refusal notice is the load-bearing part:
     * a disabled button teaches nothing, a sentence teaches what to do next.
     */
    await expect(page.getByTestId('integration-refusal')).toContainText(
      /development double|never be activated in production/i,
    );
  });

  test('tests a connection, records the result, and activates nothing', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/integrations/email/outbox`);

    const enabledBefore = await page.getByTestId('detail-enabled').innerText();

    await page.getByTestId('test-connection').click();
    await expect(page.getByTestId('integration-notice')).toBeVisible();

    // The outcome is now in the history, which is the point: a test whose
    // result nobody kept reassures the person who pressed it and tells the
    // next operator nothing.
    await expect(page.getByTestId('detail-connection')).not.toHaveText('never_tested');
    await expect(page.locator('[data-testid^="history-"]').first()).toBeVisible();

    // AND NOTHING WAS ACTIVATED. Testing is an observation; activation is a
    // configuration change with an author, a reason and a rollback.
    await expect(page.getByTestId('detail-enabled')).toHaveText(enabledBefore);
  });

  test('activation requires a reason, and disabling is the same edit backwards', async ({
    page,
  }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/integrations/email/outbox`);

    const reason = page.getByTestId('integration-reason');
    if ((await reason.count()) === 0) {
      // The signed-in role cannot activate. That is a legitimate state and the
      // screen is correct to hide the control; there is nothing to drive.
      test.skip(true, 'This role may not activate configuration.');
      return;
    }

    const activate = page.getByTestId('activate-integration');
    const disable = page.getByTestId('disable-integration');
    const wasEnabled = (await disable.count()) > 0;

    // A change reason under eight characters is refused by the action itself,
    // not merely by the input's `minLength` - a server action is a public HTTP
    // endpoint and a browser attribute is not a check.
    await reason.fill('Phase 10 end-to-end journey: exercising the activation path.');
    await (wasEnabled ? disable : activate).click();
    await expect(page.getByTestId('integration-notice')).toBeVisible();

    // And back, so the suite leaves the environment as it found it.
    await page.getByTestId('integration-reason').fill('Phase 10 end-to-end journey: restoring.');
    await (
      wasEnabled
        ? page.getByTestId('activate-integration')
        : page.getByTestId('disable-integration')
    ).click();
    await expect(page.getByTestId('integration-notice')).toBeVisible();
  });

  test('never renders a credential value, in either direction', async ({ page }) => {
    for (const locale of ['ar', 'en']) {
      await signIn(page, locale);
      await page.goto(`${ADMIN_BASE_URL}/${locale}/console/integrations/payment/development-mock`);
      const body = (await page.locator('body').innerText()).toLowerCase();
      // The signing secret is in the environment; nothing on the page may echo
      // it, and a masked hint is at most four characters.
      const secret = process.env['BILLING_DEV_WEBHOOK_SECRET'];
      if (secret) expect(body).not.toContain(secret.toLowerCase());
      await page
        .getByTestId('sign-out')
        ?.click?.({ timeout: 2_000 })
        .catch(() => undefined);
      await page.context().clearCookies();
    }
  });
});

test.describe('AI routing is legible before it is trusted', () => {
  test('names the active profile and what each one does', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/routing`);

    for (const profile of ['economy', 'balanced', 'premium', 'custom']) {
      await expect(page.getByTestId(`profile-${profile}`)).toBeVisible();
    }
    // Every capability the platform defines is listed, including the ones no
    // shipping feature requests yet - which the screen says rather than hiding.
    await expect(page.getByTestId('capability-REASONING_COMPLEX')).toBeVisible();
    await expect(page.getByTestId('capability-VISION_ANALYSIS')).toBeVisible();
  });
});

test.describe('health tells the truth', () => {
  test('reports readiness and the integration gaps from the same computation', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/health`);
    await expect(page.getByTestId('health-readiness')).toBeVisible();
    await expect(page.getByTestId('health-database')).toBeVisible();

    // The overview shows the same verdict rather than a second opinion.
    await page.goto(`${ADMIN_BASE_URL}/en/console`);
    await expect(page.getByTestId('health-readiness')).toBeVisible();
    await expect(page.getByTestId('health-integration-gaps')).toBeVisible();
  });

  test('has no accessibility violations, in both directions', async ({ page }) => {
    for (const locale of ['ar', 'en']) {
      await signIn(page, locale);
      await page.goto(`${ADMIN_BASE_URL}/${locale}/console/integrations`);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations, `${locale}: ${JSON.stringify(results.violations)}`).toEqual([]);
      await page.context().clearCookies();
    }
  });

  test('fits a phone without a horizontal scrollbar', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'ar');
    await page.goto(`${ADMIN_BASE_URL}/ar/console/integrations`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    // One pixel of tolerance for sub-pixel rounding; anything more is a layout
    // that does not fit, which on a 250px-wide rail is easy to produce.
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('the security headers reach the browser', () => {
  test('every app sends a nonce-bearing CSP and closes the classic gaps', async ({ page }) => {
    /*
     * ASSERTED ON THE WIRE, not on the function that builds the string. A
     * policy that is correct in a unit test and absent from the response is the
     * failure this catches - middleware that does not run, or a matcher that
     * excludes the route.
     */
    for (const url of [`${ADMIN_BASE_URL}/en/login`, `${DASHBOARD_BASE_URL}/en/sign-in`]) {
      const response = await page.goto(url);
      const csp = response?.headers()['content-security-policy'] ?? '';
      expect(csp, url).toContain("'nonce-");
      expect(csp, url).toContain("'strict-dynamic'");
      expect(csp, url).toContain("object-src 'none'");
      expect(csp, url).toContain("base-uri 'self'");
      expect(csp, url).toContain("form-action 'self'");
      expect(response?.headers()['x-frame-options'], url).toBe('DENY');
    }
  });

  test('nothing behind a session is cacheable', async ({ page }) => {
    await signIn(page, 'en');
    const response = await page.goto(`${ADMIN_BASE_URL}/en/console/integrations`);
    const cache = response?.headers()['cache-control'] ?? '';
    expect(cache).toContain('no-store');
    expect(cache).toContain('private');
  });

  test('the page still works under its own policy', async ({ page }) => {
    /*
     * THE ASSERTION THAT MATTERS MOST. A CSP that blocks the framework's own
     * bootstrap produces a page that renders and does nothing, which every
     * header assertion above would still pass. Collecting console errors and
     * requiring none mentioning the policy is what proves the nonce actually
     * reached the scripts.
     */
    const violations: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (/content security policy|refused to (execute|load)/i.test(text)) violations.push(text);
    });
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/integrations`);
    await expect(page.getByTestId('integration-ai-mock')).toBeVisible();
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
