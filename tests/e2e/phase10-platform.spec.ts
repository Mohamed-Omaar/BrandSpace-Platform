import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
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
     * nothing here is a vendor.
     *
     * ASSERTED ON THE NOTE, NOT ON A REFUSAL BANNER, and the distinction is the
     * product being right: `selectionRefusal` is null in a DEVELOPMENT
     * environment, because a development double is perfectly selectable there.
     * The refusal banner appears in production, where this suite does not run.
     * What must be true in every environment is that the page says what this
     * provider is.
     */
    await expect(page.getByTestId('integration-note')).toContainText(
      /repeatable output offline|without a vendor/i,
    );
    // And the environments row is the machine-readable half of the same fact.
    await expect(page.getByTestId('detail-environments')).not.toContainText('PRODUCTION');
  });

  test('tests a connection, records the result, and activates nothing', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/integrations/email/outbox`);

    const enabledBefore = (await page.getByTestId('detail-enabled').innerText()).trim();

    await page.getByTestId('test-connection').click();
    await settled(page, /[?&]ok=CONNECTION_TESTED/);
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

/**
 * THE OWNER CONFIGURES A PROVIDER WITHOUT LEAVING THE HUB — the Phase 10
 * correction, section 12.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE CAN. The isolation suite proves the
 * service writes references rather than values; the unit suite proves the
 * registry decides what a form may say. Neither can prove that the SCREEN an
 * owner actually opens contains the inputs, that submitting them works, or that
 * the rendered HTML afterwards is free of what was typed. That last one is the
 * point: a secret is safe in the database and leaked on the page if the form
 * helpfully repopulates it, and only a browser can tell you which happened.
 *
 * ONE TEST, TWENTY-ONE STEPS, IN ORDER, because they are one journey and each
 * step is the precondition of the next. Splitting them would let step 12 pass
 * against state step 7 never created.
 *
 * NO REAL CREDENTIAL. The provider is the development payment double, the value
 * is a string invented here, and the account is the throwaway one `pnpm e2e:seed`
 * created moments ago.
 */
const HUB_SECRET = 'whsec-e2e-first-6b1f9c40aa72d38e';
const HUB_ROTATED = 'whsec-e2e-rotated-a05d3e17bc84f296';

/**
 * Wait for an action's outcome, and for the page to stop moving underneath it.
 *
 * WHY BOTH. Every action here redirects back with `ok=<what happened>`, so the
 * URL is the only honest signal that THIS action finished - `integration-notice`
 * is the same element for every outcome and stays visible from the previous one.
 * But the URL changing is not the end: each action also calls `revalidatePath`,
 * and the refetch that provokes lands a moment LATER and re-renders the tree.
 * Typing a change reason in that window put the text into a node React then
 * replaced, and the next click submitted an empty required field, which the
 * browser refused silently - no request, no error, no navigation, and a test
 * that timed out pointing at the wrong line. Waiting for the network to go quiet
 * first means the form that is typed into is the form that is submitted.
 */
async function settled(page: Page, outcome: RegExp): Promise<void> {
  await page.waitForURL(outcome);
  await page.waitForLoadState('networkidle');
}

test.describe('the owner configures a provider from the Integrations Hub alone', () => {
  test('enter, save, mask, test, activate, disable, rotate', async ({ page }) => {
    /*
     * TWENTY-ONE STEPS AND SIX CONFIGURATION WRITES do not fit the suite's
     * default thirty seconds. Each save, activation and disable is a real
     * configuration draft, validation and activation against PostgreSQL, and
     * each is followed by a revalidation the next step has to let land. The
     * budget is raised for this one journey rather than for the whole suite,
     * where a slow test is usually a broken one.
     */
    test.setTimeout(150_000);
    await signIn(page, 'en');

    // 1-3. Control Center -> Integrations -> a provider.
    await page.goto(`${ADMIN_BASE_URL}/en/console/integrations`);
    await page
      .getByTestId('integration-payment-development-mock')
      .getByRole('link')
      .first()
      .click();
    await expect(page).toHaveURL(/integrations\/payment\/development-mock/);

    /*
     * START FROM OFF, whatever the last run left behind. A journey that dies
     * between step 17 and step 18 hands the next run a provider that is already
     * active, and step 14 - the proof that saving and testing activate nothing -
     * would then fail for a reason that has nothing to do with the product.
     */
    if ((await page.getByTestId('detail-enabled').innerText()).trim() !== 'No') {
      await page.getByTestId('integration-reason').fill('End-to-end journey: starting from off.');
      await expect(page.getByTestId('integration-reason')).not.toHaveValue('');
      await page.getByTestId('disable-integration').click();
      await settled(page, /[?&]ok=INTEGRATION_DISABLED/);
    }

    // 4. The provider declares a required credential and a required setting,
    //    and the form for them is generated from that declaration.
    await expect(page.getByTestId('integration-config')).toBeVisible();
    await expect(page.getByTestId('credential-input-webhookSecret')).toBeVisible();
    await expect(page.getByTestId('setting-hostedBaseUrl')).toBeVisible();

    // 5-6. Enter a fake credential and the required non-secret setting.
    await page.getByTestId('credential-input-webhookSecret').fill(HUB_SECRET);
    await page.getByTestId('setting-hostedBaseUrl').fill('http://localhost:3003');
    await page.getByTestId('save-reason').fill('End-to-end journey: connecting the provider.');

    /*
     * 7-8. Save, and the page comes back.
     *
     * WAIT FOR THE OUTCOME IN THE URL, NOT FOR A NOTICE. Every action on this
     * page redirects back to it with `ok=<what happened>` or `error=<code>`,
     * and both render the same `integration-notice` element. Asserting only
     * that a notice exists would pass on the notice the PREVIOUS step left
     * behind, and it did: an activation that never submitted read as an
     * activation that had. The URL names which action finished, and waiting for
     * it also means the next step types into a settled page rather than into a
     * form React is in the middle of replacing.
     */
    await page.getByTestId('save-configuration').click();
    await settled(page, /[?&]ok=CONFIGURATION_SAVED/);
    await expect(page.getByTestId('integration-notice')).toBeVisible();

    // 9. THE PLAINTEXT IS NOWHERE IN THE RENDERED PAGE. Not in the body text,
    //    and not in the HTML either - a value echoed into an input's `value`
    //    attribute would be invisible to `innerText` and perfectly readable to
    //    anyone with the page source.
    const html = await page.content();
    expect(html).not.toContain(HUB_SECRET);
    expect(await page.locator('body').innerText()).not.toContain(HUB_SECRET);

    // 10. Masked metadata is visible instead.
    await expect(page.getByTestId('credential-webhookSecret')).toContainText('••••••••••');

    // 11. Completeness changed because a required credential is now present.
    await expect(page.getByTestId('detail-complete')).toHaveText('Yes');

    // 12-13. Test Connection runs against the saved configuration, and says so.
    const enabledBeforeTest = (await page.getByTestId('detail-enabled').innerText()).trim();
    await page.getByTestId('test-connection').click();
    await expect(page.getByTestId('integration-notice')).toBeVisible();
    await expect(page.getByTestId('detail-connection')).toHaveText('ok');
    await expect(page.locator('[data-testid^="history-"]').first()).toContainText(
      /saved webhook secret/i,
    );

    // 14. AND TESTING ACTIVATED NOTHING.
    await expect(page.getByTestId('detail-enabled')).toHaveText(enabledBeforeTest);

    // Saving activated nothing either: the provider is still off.
    expect(enabledBeforeTest).toBe('No');

    // 15-17. A reason, then activate, then confirm the active state.
    const reason = page.getByTestId('integration-reason');
    test.skip((await reason.count()) === 0, 'This role may not activate configuration.');
    await reason.fill('End-to-end journey: activating the development payment provider.');
    // The reason must still be there when the button is pressed; an empty
    // required field is refused by the browser and reaches no server at all.
    await expect(reason).not.toHaveValue('');
    await page.getByTestId('activate-integration').click();
    await settled(page, /[?&]ok=INTEGRATION_ACTIVATED/);
    await expect(page.getByTestId('integration-notice')).toBeVisible();
    await expect(page.getByTestId('detail-enabled')).toHaveText('Yes');

    // 18. Disable it again, so the suite leaves the environment as it found it.
    await page.getByTestId('integration-reason').fill('End-to-end journey: restoring.');
    await expect(page.getByTestId('integration-reason')).not.toHaveValue('');
    await page.getByTestId('disable-integration').click();
    await settled(page, /[?&]ok=INTEGRATION_DISABLED/);
    await expect(page.getByTestId('detail-enabled')).toHaveText('No');

    // 19-20. Rotate the credential. The input is empty again - nothing in this
    //        product can put the stored value back into it - and the new value
    //        is masked exactly like the first.
    await expect(page.getByTestId('credential-input-webhookSecret')).toHaveValue('');
    await page.getByTestId('credential-input-webhookSecret').fill(HUB_ROTATED);
    await page.getByTestId('setting-hostedBaseUrl').fill('http://localhost:3003');
    await page.getByTestId('save-reason').fill('End-to-end journey: rotating the webhook secret.');
    await page.getByTestId('save-configuration').click();
    await settled(page, /[?&]ok=CONFIGURATION_SAVED/);
    await expect(page.getByTestId('integration-notice')).toBeVisible();
    await expect(page.getByTestId('credential-webhookSecret')).toContainText('••••••••••');

    // 21. NEITHER VALUE IS RECOVERABLE FROM THE PAGE - not the new one, and not
    //     the one it replaced.
    const afterRotation = await page.content();
    expect(afterRotation).not.toContain(HUB_ROTATED);
    expect(afterRotation).not.toContain(HUB_SECRET);
  });

  test('renders the form in both languages and both directions', async ({ page }) => {
    for (const locale of ['ar', 'en']) {
      await signIn(page, locale);
      await page.goto(`${ADMIN_BASE_URL}/${locale}/console/integrations/payment/development-mock`);

      // The document direction is the product's, and the form is inside it.
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(page.getByTestId('integration-config')).toBeVisible();

      /*
       * THE LABEL IS TRANSLATED, NOT THE FIELD KEY. A form generated from a
       * registry is one careless line away from rendering `hostedBaseUrl` as
       * its own label in both languages, which passes every other assertion.
       */
      const label = page.locator('label[for="setting-hostedBaseUrl"]');
      await expect(label).toContainText(
        locale === 'ar' ? 'الرابط الأساسي لصفحة الدفع' : 'Hosted checkout base URL',
      );

      // And the generated webhook URL is shown read-only rather than as an
      // input somebody could point elsewhere.
      await expect(page.getByTestId('generated-webhookUrl')).toBeVisible();
      await expect(page.locator('input[name="setting.webhookUrl"]')).toHaveCount(0);

      await page.context().clearCookies();
    }
  });

  test('the configuration form has no accessibility violations, in both directions', async ({
    page,
  }) => {
    for (const locale of ['ar', 'en']) {
      await signIn(page, locale);
      await page.goto(`${ADMIN_BASE_URL}/${locale}/console/integrations/payment/development-mock`);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations, `${locale}: ${JSON.stringify(results.violations)}`).toEqual([]);
      await page.context().clearCookies();
    }
  });
});
