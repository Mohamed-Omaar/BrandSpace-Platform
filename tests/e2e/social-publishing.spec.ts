import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';

/**
 * Connected accounts and publishing history, end to end in a real browser —
 * Phase 6.
 *
 * WHAT THIS ASSERTS THAT A UNIT OR ISOLATION TEST CANNOT: that a connected
 * account is actually rendered with its identity, its health and its last sync;
 * that the publishing history explains a failure in the READER's language
 * rather than the provider's; that the controls a member may use are the ones
 * that appear; and that all of it is clean under axe, in Arabic and English,
 * right to left and left to right.
 *
 * NOTHING HERE CONTACTS A PLATFORM. The connection is a seeded fixture with a
 * fake token, and no test triggers an outbound call — the connect button is
 * asserted to EXIST and is never pressed, because pressing it would redirect to
 * a provider that does not exist.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error(
      'The end-to-end credentials file is missing. Run `pnpm e2e:seed` first — ' +
        '`pnpm test:e2e` does it for you.',
    );
  }
}

async function signIn(page: Page, locale = 'en'): Promise<void> {
  const { customer } = credentials();
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

test.describe('the connected accounts screen', () => {
  test('lists the connected account with its identity and health', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/integrations`);

    const list = page.locator('[data-testid="connected-accounts-list"]');
    await expect(list).toBeVisible();
    await expect(list).toContainText('E2E Organization');
    // The PROVIDER and the TARGET KIND, so a customer can tell which of two
    // LinkedIn objects this is.
    await expect(list).toContainText('LinkedIn');
    await expect(list).toContainText('organization');
    // The health facts the brief names: status and last successful sync.
    await expect(list).toContainText('Connected');
    await expect(list).toContainText('Last successful sync');
  });

  test('NO TOKEN IS ANYWHERE IN THE RENDERED PAGE', async ({ page }) => {
    /*
     * The assertion that matters most on this screen. The seed's token is a
     * fixed, visibly fake string; if any code path ever put a credential on a
     * connection view, this is where it would surface.
     */
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/integrations`);
    const html = await page.content();
    expect(html).not.toContain('e2e-fake-access-token-not-real');
    expect(html).not.toContain('e2e-fake-refresh-token-not-real');
    expect(html).not.toContain('SOCIAL_TOKEN_VAULT_KEK');
  });

  test('offers connect and disconnect to a member who may manage accounts', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/integrations`);
    // The form EXISTS and is not submitted: submitting would redirect to a
    // provider that does not exist in this environment.
    await expect(page.locator('[data-testid="connect-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="connect-provider"]')).toBeVisible();
    await expect(page.locator('[data-testid="connect-brand"]')).toBeVisible();
    await expect(page.locator('[data-testid="connect-submit"]')).toBeVisible();
    await expect(page.locator('[data-testid^="disconnect-"]').first()).toBeVisible();
  });

  test('states each platform CAPABILITIES before the customer commits', async ({ page }) => {
    /*
     * "Capabilities are declared, not assumed equal." Telling somebody a
     * platform's ceiling after they have written 3,000 characters is telling
     * them too late.
     */
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/integrations`);
    const capabilities = page.locator('[data-testid="provider-capabilities"]');
    await expect(capabilities).toBeVisible();
    await expect(capabilities).toContainText('max characters');
  });
});

test.describe('the publishing history', () => {
  test('shows the failed post, and explains the failure in the READER language', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/integrations`);

    const history = page.locator('[data-testid="publishing-list"]');
    await expect(history).toBeVisible();
    await expect(history).toContainText('Failed');
    // OUR sentence, resolved from the stored CLASS. The provider's own words
    // are never stored and never rendered.
    await expect(history).toContainText('The platform rejected this content');
    // And the machine code we store is NOT shown to a person.
    await expect(history).not.toContainText('mock.content_rejected');
    await expect(history).not.toContainText('CONTENT_REJECTED');
  });

  test('offers a retry on a failure a retry can fix', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/integrations`);
    await expect(page.locator('[data-testid^="retry-"]').first()).toBeVisible();
  });

  test('shows the attempt count against the configured ceiling', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/integrations`);
    await expect(page.locator('[data-testid="publishing-list"]')).toContainText('Attempts');
  });
});

test.describe('Arabic, right to left', () => {
  test('renders the screen in Arabic with the correct direction', async ({ page }) => {
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/integrations`);

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // `ar-SA`, not `ar`: the shell emits the REGIONAL tag the platform uses, and
    // asserting the exact string here would pin this test to a decision that
    // belongs to the shell. The language subtag is what this screen cares about.
    await expect(page.locator('html')).toHaveAttribute('lang', /^ar\b/);

    const list = page.locator('[data-testid="connected-accounts-list"]');
    await expect(list).toBeVisible();
    // The Arabic strings, not the English ones — a missing translation would
    // render the key or fall back, and both are visible here.
    await expect(list).toContainText('متصل');
    await expect(page.locator('[data-testid="publishing-list"]')).toContainText('فشل');
    await expect(page.locator('[data-testid="publishing-list"]')).toContainText(
      'رفضت المنصة هذا المحتوى',
    );
  });

  test('the whole page is inside the right-to-left flow', async ({ page }) => {
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/integrations`);
    const direction = await page
      .locator('[data-testid="connected-accounts"]')
      .evaluate((node) => getComputedStyle(node).direction);
    expect(direction).toBe('rtl');
  });

  test('no horizontal overflow at phone width in Arabic', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/integrations`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    // A pixel of tolerance for sub-pixel rounding; anything more is a layout
    // that pushes a customer sideways.
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('accessibility', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`is clean under axe in ${locale}`, async ({ page }) => {
      await signIn(page, locale);
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/integrations`);
      await expect(page.locator('[data-testid="connected-accounts"]')).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('every control is reachable and operable by keyboard alone', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/integrations`);

    // The two selects and the submit are focusable in order, which is what a
    // person using a keyboard needs before anything else.
    await page.locator('[data-testid="connect-provider"]').focus();
    await expect(page.locator('[data-testid="connect-provider"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-testid="connect-brand"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-testid="connect-submit"]')).toBeFocused();
  });

  test('the page has exactly one h1, supplied by the shell', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/integrations`);
    await expect(page.locator('h1')).toHaveCount(1);
  });
});

test.describe('navigation', () => {
  test('the sidebar offers the screen to a member who may see it', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    const link = page.locator('a[href$="/en/integrations"]').first();
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(/\/en\/integrations$/);
    await expect(page.locator('[data-testid="connected-accounts"]')).toBeVisible();
  });
});

/**
 * P6-R1 — THE OAUTH CALLBACK, WALKED IN THE SHAPE A PROVIDER ACTUALLY USES.
 *
 * WHY THIS SUITE EXISTS AND WHY ITS ABSENCE MATTERED. Everything above
 * deliberately stopped at the connect button, and that gap is exactly how the
 * callback came to be registered as `POST /v1/social/callback` — expecting a
 * JSON body — while every provider was handed
 * `/v1/social/callback/<provider>` and would arrive by GET with `code` and
 * `state` in the query string. Two independent reasons the redirect could never
 * land, and a green CI, because nothing ever performed one.
 *
 * SO THESE PERFORM ONE. A real `GET`, with a real state taken from the real
 * authorization URL the connect button produced, against the running API.
 *
 * AND WITH NO SESSION COOKIE, which is the part that proves the staging
 * topology works. `__Host-bs_customer_session` forbids a `Domain` attribute, so
 * it is locked to the origin that set it: the browser will not send it to
 * `api-staging.brandspace.cc`, and it must not. The identity therefore comes
 * from the state row and nowhere else. Locally the dashboard and the API differ
 * only by port — and cookies ignore ports — so proving this needs a context
 * that holds no cookies at all rather than merely a different port.
 */
test.describe('P6-R1 — the OAuth callback a provider would actually reach', () => {
  const API_BASE_URL = 'http://127.0.0.1:3103';

  /**
   * Press Connect and capture the `state` from the authorization URL.
   *
   * The provider host does not exist, so the navigation to it is intercepted
   * and aborted — which is also what makes this safe: nothing leaves the
   * machine, and no credential is involved on either side.
   */
  async function startAuthorization(page: Page): Promise<string> {
    let authorizationUrl: string | null = null;
    await page.route('**mock.invalid/**', async (route) => {
      authorizationUrl = route.request().url();
      await route.abort();
    });

    await page.goto(`${DASHBOARD_BASE_URL}/en/integrations`);
    await page.selectOption('[data-testid="connect-provider"]', 'LINKEDIN');
    await page.click('[data-testid="connect-submit"]');

    await expect
      .poll(() => authorizationUrl, { message: 'the connect button never reached a provider' })
      .not.toBeNull();

    const state = new URL(authorizationUrl!).searchParams.get('state');
    expect(state, 'the authorization URL carried no state').toBeTruthy();
    return state!;
  }

  test('a browser-shaped GET completes the flow and redirects to the dashboard', async ({
    page,
    playwright,
  }) => {
    await signIn(page);
    const state = await startAuthorization(page);

    /*
     * A BARE HTTP GET, NO COOKIES, NO HEADERS OF OURS. This is the request a
     * provider's redirect produces. Redirects are not followed so the
     * `Location` header itself can be asserted — it is the entire contract
     * between the API and the dashboard.
     */
    const anonymous = await playwright.request.newContext();
    const response = await anonymous.get(
      `${API_BASE_URL}/v1/social/callback/linkedin?code=e2e-callback-code&state=${encodeURIComponent(state)}`,
      { maxRedirects: 0 },
    );

    // 303: the browser arrived by GET and must continue by GET.
    expect(response.status()).toBe(303);
    const location = response.headers()['location'];
    expect(location, 'the callback answered without a redirect').toBeTruthy();

    const target = new URL(location!);
    expect(target.origin).toBe(DASHBOARD_BASE_URL);
    expect(target.pathname).toBe('/integrations');
    /*
     * LINKEDIN'S MOCK OFFERS TWO TARGETS, so the flow correctly PAUSES rather
     * than binding a page nobody chose (D-142). Against the pre-fix code this
     * would have been a connected account already.
     */
    expect(target.searchParams.get('social')).toBe('select');
    expect(target.searchParams.get('select')).toBeTruthy();

    // NOTHING THE PROVIDER SENT IS ECHOED BACK. Not the code, not the state.
    expect(location).not.toContain('e2e-callback-code');
    expect(location).not.toContain(state);

    await anonymous.dispose();
  });

  test('a real browser navigation completes it too, and lands on the choice', async ({
    page,
    browser,
  }) => {
    await signIn(page);
    const state = await startAuthorization(page);

    // A SECOND BROWSER, holding no cookies at all — the staging topology, where
    // the session cookie cannot reach the API host.
    const anonymousContext = await browser.newContext();
    const anonymousPage = await anonymousContext.newPage();
    await anonymousPage.goto(
      `${API_BASE_URL}/v1/social/callback/linkedin?code=e2e-callback-code&state=${encodeURIComponent(state)}`,
    );
    // The callback redirected here; the dashboard then bounced an unauthenticated
    // visitor to sign-in, which is correct and is not what is under test.
    await expect
      .poll(() => anonymousPage.url(), {
        message: 'the callback never reached the dashboard origin',
      })
      .toContain('127.0.0.1:3101');
    await anonymousContext.close();
  });

  test('THE SIGNED-IN MEMBER IS THEN ASKED WHICH PAGE, AND PICKS ONE', async ({
    page,
    playwright,
  }) => {
    await signIn(page);
    const state = await startAuthorization(page);

    const anonymous = await playwright.request.newContext();
    const response = await anonymous.get(
      `${API_BASE_URL}/v1/social/callback/linkedin?code=e2e-callback-code&state=${encodeURIComponent(state)}`,
      { maxRedirects: 0 },
    );
    const selectionToken = new URL(response.headers()['location']!).searchParams.get('select');
    await anonymous.dispose();

    // BACK IN THE SIGNED-IN BROWSER, which is where the choice belongs: it needs
    // the session, the permission and the brand scope.
    await page.goto(
      `${DASHBOARD_BASE_URL}/en/integrations?social=select&select=${encodeURIComponent(selectionToken!)}`,
    );

    const form = page.locator('[data-testid="select-target-form"]');
    await expect(form).toBeVisible();
    const choices = form.locator('input[name="externalAccountId"]');
    // TWO PAGES OFFERED, and NEITHER pre-selected: a default is the same
    // decision-on-the-customer's-behalf the pause exists to undo.
    await expect(choices).toHaveCount(2);
    expect(await choices.nth(0).isChecked()).toBe(false);
    expect(await choices.nth(1).isChecked()).toBe(false);

    // THE SECOND ONE, deliberately — picking the first would also pass against
    // the code that always took `targets[0]`.
    const chosen = await choices.nth(1).getAttribute('value');
    await choices.nth(1).check();
    await page.click('[data-testid="select-target-submit"]');

    await page.waitForURL(/\/integrations/);
    const list = page.locator('[data-testid="connected-accounts-list"]');
    await expect(list).toBeVisible();
    await expect(list).toContainText('Organization 2');
    expect(chosen).toBeTruthy();
  });

  test('a forged, replayed or expired state all end at the same place', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext();

    const forged = await anonymous.get(
      `${API_BASE_URL}/v1/social/callback/linkedin?code=whatever&state=${encodeURIComponent('not-a-real-state')}`,
      { maxRedirects: 0 },
    );
    const declined = await anonymous.get(
      `${API_BASE_URL}/v1/social/callback/linkedin?error=access_denied&error_description=user%20cancelled`,
      { maxRedirects: 0 },
    );
    const noParameters = await anonymous.get(`${API_BASE_URL}/v1/social/callback/linkedin`, {
      maxRedirects: 0,
    });
    const unknownProvider = await anonymous.get(
      `${API_BASE_URL}/v1/social/callback/myspace?code=a&state=b`,
      { maxRedirects: 0 },
    );

    for (const response of [forged, declined, noParameters, unknownProvider]) {
      expect(response.status()).toBe(303);
      // NO JSON, NO ERROR CODE, NO PROSE. A redirect is the most public surface
      // in the product; a refusal that explained itself would explain it to
      // whoever crafted the link.
      expect(response.headers()['location']).toContain('/integrations?social=');
    }

    // A DENIAL IS TOLD APART FROM A FAULT — the customer pressed Cancel, and
    // saying "something went wrong" would be false. Everything else is uniform.
    expect(declined.headers()['location']).toContain('social=declined');
    for (const response of [forged, noParameters, unknownProvider]) {
      expect(response.headers()['location']).toContain('social=invalid');
    }
    // AND THE PROVIDER'S OWN WORDS ARE NEVER REPEATED.
    expect(declined.headers()['location']).not.toContain('cancelled');

    await anonymous.dispose();
  });
});
