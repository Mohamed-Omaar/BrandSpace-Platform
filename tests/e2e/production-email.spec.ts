import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ADMIN_BASE_URL, DASHBOARD_BASE_URL } from './apps';
import { signIn } from './admin-session';

/**
 * THE WHOLE EMAIL CHAIN, IN A BROWSER — section D of the production-adapters pass.
 *
 * WHAT NO OTHER TEST CAN SHOW. The unit tests prove the adapter composes the
 * right request; the isolation suite proves the credential is stored as a
 * reference and never leaks into a row. Neither can prove the thing an owner
 * actually cares about: that configuring Resend on a Control Center screen
 * changes which adapter a customer signup — in a different process, minutes
 * later — reaches.
 *
 * SO EVERY LINK IS THE REAL ONE:
 *
 *   the owner fills the real Hub form
 *     -> IntegrationsService writes a real secret and a real configuration draft
 *     -> the owner activates it, as a separate act with its own reason
 *     -> a customer signs up on the real dashboard
 *     -> the dashboard asks the API over the internal route
 *     -> the API resolves the ACTIVE provider from configuration
 *     -> it decrypts the key through the Secret Service
 *     -> ResendEmailProvider composes and sends the HTTP request
 *
 * THE ONLY SUBSTITUTION IS THE HOST THAT REQUEST LANDS ON —
 * `tests/e2e/fake-resend.ts`, wired in `playwright.config.ts`. Substituting
 * anything above the socket would prove only that the substitution happened.
 *
 * NO REAL CREDENTIAL AND NO REAL EMAIL. The key below is a fixture that no
 * provider would accept, and nothing in this file opens a connection to
 * Resend. No message leaves the machine.
 */

const FAKE_RESEND = 'http://127.0.0.1:3105';

/** A fixture key, deliberately not shaped like a real one (`re_…`). */
const FIXTURE_KEY = 'e2e-fixture-not-a-credential-4d7f21ab90ce';
const FROM_EMAIL = 'no-reply@brandspace.test';

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string;
  readonly body: Record<string, unknown> | null;
}

async function recorded(page: Page): Promise<RecordedRequest[]> {
  const response = await page.request.get(`${FAKE_RESEND}/__recorded`);
  return (await response.json()) as RecordedRequest[];
}

async function resetTransport(page: Page): Promise<void> {
  await page.request.get(`${FAKE_RESEND}/__reset`);
}

/** Wait for a server action's own outcome, not merely for the network to idle. */
async function settled(page: Page, outcome: RegExp): Promise<void> {
  await page.waitForURL(outcome);
  await page.waitForLoadState('networkidle');
}

const HUB = `${ADMIN_BASE_URL}/en/console/integrations/email/resend`;

/**
 * Make Resend the active email provider, whatever the run inherited.
 *
 * WHY THIS EXISTS — Phase 5. The boundary test below sends through the internal
 * delivery route and asserts that a Resend request reaches the recorder. It
 * established NO precondition of its own: it depended on the journey test above
 * having activated Resend and left it activated. That dependency was invisible
 * for as long as the API memoised its resolved provider for sixty seconds
 * regardless of configuration — a stale cache was standing in for a setup step.
 *
 * Once the provider began following the ACTIVATED VERSION (the real fix), the
 * dependency became a failure instead of a coincidence, which is the correct
 * outcome and the reason this helper is a setup step rather than a retry.
 *
 * Idempotent: if Resend is already active it does nothing, so the journey test
 * above is unaffected and pays no second activation.
 */
async function ensureResendActive(page: Page): Promise<void> {
  await signIn(page, 'en');
  await page.goto(HUB);
  if (/yes/i.test((await page.getByTestId('detail-enabled').innerText()).trim())) return;

  await page.getByTestId('credential-input-apiKey').fill(FIXTURE_KEY);
  await page.getByTestId('setting-fromEmail').fill(FROM_EMAIL);
  await page.getByTestId('setting-fromName').fill('BrandSpace');
  await page
    .getByTestId('save-reason')
    .fill('Test setup: Resend must be the active provider for the boundary assertions.');
  await page.getByTestId('save-configuration').click();
  await settled(page, /ok=CONFIGURATION_SAVED/);

  await page
    .getByTestId('integration-reason')
    .fill('Test setup: activating Resend for the boundary assertions.');
  await page.getByTestId('activate-integration').click();
  await settled(page, /ok=INTEGRATION_ACTIVATED/);
  await expect(page.getByTestId('detail-enabled')).toHaveText(/yes/i);
}

test.describe('the owner connects Resend, and a customer signup uses it', () => {
  test('configure, mask, test, activate, sign up, deliver', async ({ page }) => {
    /*
     * Three configuration writes, an activation, a signup and a cross-process
     * delivery. Each is a real draft, validation and activation against
     * PostgreSQL followed by a revalidation the next step has to let land, and
     * none of that fits the suite's default thirty seconds.
     */
    test.setTimeout(180_000);
    await signIn(page, 'en');
    await resetTransport(page);

    /*
     * ---- 0. START FROM OFF, WHATEVER THE LAST RUN LEFT --------------------
     *
     * `integrations.email` is one document shared by every suite that runs
     * against this database. A run that ended early — or an isolation suite
     * that activated Resend and crashed before restoring it — leaves the
     * provider on, and step 3 below would then read "Yes" and report that Save
     * silently activates. Normalising here means the assertion is about THIS
     * journey rather than about the previous one.
     */
    await page.goto(HUB);
    if (/yes/i.test((await page.getByTestId('detail-enabled').innerText()).trim())) {
      await page
        .getByTestId('integration-reason')
        .fill('End-to-end journey: normalising to a disabled provider before the run.');
      await page.getByTestId('disable-integration').click();
      await settled(page, /ok=INTEGRATION_DISABLED/);
    }

    // ---- 1. The Hub lists Resend as a real provider, not a double ----------
    await page.goto(`${ADMIN_BASE_URL}/en/console/integrations`);
    await expect(page.getByTestId('integration-email-resend')).toBeVisible();
    await page.getByTestId('integration-email-resend').getByRole('link').first().click();
    await expect(page).toHaveURL(/integrations\/email\/resend/);

    // ---- 2. Enter the credential and the From address ----------------------
    await page.getByTestId('credential-input-apiKey').fill(FIXTURE_KEY);
    await page.getByTestId('setting-fromEmail').fill(FROM_EMAIL);
    await page.getByTestId('setting-fromName').fill('BrandSpace');
    await page
      .getByTestId('save-reason')
      .fill('End-to-end journey: connecting Resend as the transactional email provider.');
    await page.getByTestId('save-configuration').click();
    await settled(page, /ok=CONFIGURATION_SAVED/);

    // ---- 3. SAVE IS NOT ACTIVATE ------------------------------------------
    await expect(page.getByTestId('detail-enabled')).toHaveText(/no/i);

    // ---- 4. The value is gone; only a masked hint remains ------------------
    const afterSave = await page.locator('body').innerText();
    expect(afterSave).not.toContain(FIXTURE_KEY);
    /*
     * AND THE INPUT IS EMPTY, which is the part that is easy to get wrong. A
     * form that pre-filled the stored value would put the credential in the
     * page source on every visit, and an owner editing the From address would
     * never notice.
     */
    await expect(page.getByTestId('credential-input-apiKey')).toHaveValue('');
    // The whole document, not the rendered text: a value in a hidden field or
    // an attribute is still a value that reached the browser.
    expect(await page.content()).not.toContain(FIXTURE_KEY);

    // ---- 5. THERE IS NO TEST CONNECTION BUTTON, and the screen says why ---
    /*
     * The credential BrandSpace asks for is a Resend Sending-access key
     * restricted to the verified domain — the least privilege that can send.
     * Every non-destructive check Resend offers is a read, and such a key is
     * refused all of them. A button here could only report a working key as
     * broken, demand a wider key, or send an unsolicited probe message.
     */
    await expect(page.getByTestId('test-connection')).toHaveCount(0);
    await expect(page.getByTestId('integration-note')).toContainText('no Test connection button');
    await expect(page.getByTestId('integration-note')).toContainText('smoke email');

    // NOTHING WAS SENT while the owner configured the provider. A screen that
    // probed the vendor on load would put mail in an inbox nobody asked about.
    expect(await recorded(page)).toEqual([]);

    // ---- 6. STILL NOT ACTIVE ----------------------------------------------
    await expect(page.getByTestId('detail-enabled')).toHaveText(/no/i);

    // ---- 7. Activate, as a separate act with its own reason ---------------
    await page
      .getByTestId('integration-reason')
      .fill('End-to-end journey: activating Resend for transactional email.');
    await page.getByTestId('activate-integration').click();
    await settled(page, /ok=INTEGRATION_ACTIVATED/);
    await expect(page.getByTestId('detail-enabled')).toHaveText(/yes/i);

    // ---- 8. A customer signs up, in a session with no platform identity ----
    await resetTransport(page);
    const customer = await page.context().browser()!.newContext();
    const signup = await customer.newPage();
    const address = `e2e-email-${Date.now()}@brandspace.test`;

    await signup.goto(`${DASHBOARD_BASE_URL}/en/sign-up`);
    await signup.locator('#name').fill('Email Journey Customer');
    await signup.locator('#email').fill(address);
    await signup.locator('#password').fill('An-Adequately-Long-Passphrase-9');
    await signup.locator('#timezone').fill('Asia/Riyadh');
    await signup.locator('#timezone').press('Enter');
    await expect(signup.locator('input[type="hidden"][name="timezone"]')).toHaveValue(
      'Asia/Riyadh',
    );
    for (const box of await signup.locator('input[type="checkbox"][required]').all()) {
      await box.check();
    }
    await signup.getByTestId('signup-submit').click();
    await signup.waitForLoadState('networkidle');

    // ---- 9. THE ACTIVE PROVIDER SENT IT -----------------------------------
    await expect
      .poll(async () => (await recorded(page)).filter((e) => e.path === '/emails').length, {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);

    const sends = (await recorded(page)).filter((entry) => entry.path === '/emails');
    const message = sends[0]!;
    expect(message.method).toBe('POST');
    expect(message.authorization).toBe(`Bearer ${FIXTURE_KEY}`);

    const body = message.body as Record<string, unknown>;
    // Addressed to the person who signed up, from the identity the owner
    // configured — both of which came out of the configuration document rather
    // than out of a constant anywhere.
    expect(body['to']).toEqual([address.toLowerCase()]);
    expect(String(body['from'])).toContain(FROM_EMAIL);
    expect(String(body['subject'])).not.toBe('');
    // A verification message without its link is a message that cannot verify.
    expect(String(body['html'])).toContain(`${DASHBOARD_BASE_URL}/en/verify?token=`);

    await customer.close();

    // ---- 10. Leave the environment as it was found ------------------------
    await page.goto(HUB);
    await page
      .getByTestId('integration-reason')
      .fill('End-to-end journey: restoring the outbox as the email provider.');
    await page.getByTestId('disable-integration').click();
    await settled(page, /ok=INTEGRATION_DISABLED/);
  });
});

test.describe('the secret boundary, observed from outside', () => {
  test('the dashboard never receives the credential in any form', async ({ page }) => {
    /*
     * THE POINT OF THE WHOLE DESIGN. The dashboard originated the message above
     * and holds no `SECRET_VAULT_KEK` and no Resend key — `playwright.config.ts`
     * gives it neither. These assert that nothing leaked back to it through a
     * page instead.
     */
    for (const path of ['en/sign-up', 'en/sign-in', 'en/reset']) {
      const response = await page.goto(`${DASHBOARD_BASE_URL}/${path}`);
      expect(response?.status(), path).toBeLessThan(400);
      const html = await page.content();
      expect(html, path).not.toContain(FIXTURE_KEY);
      expect(html, path).not.toContain('SECRET_VAULT_KEK');
      expect(html, path).not.toContain('api.resend.com');
    }
  });

  test('the internal delivery route answers 404 without the service token', async ({ page }) => {
    /*
     * 404 RATHER THAN 401. Answering "unauthorized" confirms the endpoint to
     * anybody scanning, and there is no legitimate caller who needs to be told
     * they got the token wrong rather than the URL. Without this the route is a
     * way to send mail from the platform's own verified domain to any address.
     */
    const api = `http://127.0.0.1:3103/v1/internal/email/deliver`;
    const payload = {
      to: 'attacker@example.test',
      templateKey: 'auth.email_verification',
      locale: 'EN',
      link: 'https://attacker.example/collect',
    };

    const noToken = await page.request.post(api, { data: payload });
    expect(noToken.status()).toBe(404);

    const wrongToken = await page.request.post(api, {
      data: payload,
      headers: { 'x-brandspace-service-token': 'not-the-token' },
    });
    expect(wrongToken.status()).toBe(404);

    // Neither attempt reached the provider.
    const sends = (await recorded(page)).filter((entry) => entry.path === '/emails');
    expect(sends.every((entry) => JSON.stringify(entry.body).indexOf('attacker') === -1)).toBe(
      true,
    );
  });

  test('a VALID service token cannot point a BrandSpace message at another origin', async ({
    page,
  }) => {
    /*
     * THE HOLE THIS CLOSES, AND WHY THE TOKEN IS NOT THE ANSWER TO IT.
     *
     * The route's contract said "no arbitrary link target"; the schema enforced
     * a length and nothing else. A caller holding `INTERNAL_SERVICE_TOKEN`
     * could therefore have a BrandSpace-branded verification or password-reset
     * message, from the platform's own verified sending domain, carry a link to
     * anywhere — which is a credible phishing primitive with our sending
     * reputation behind it.
     *
     * The token authenticates a PROCESS, not an intention. It sits in three
     * services' environments and would outlive a rotation in any log or backup
     * that captured it. So the link is checked on its own merits: absolute URL,
     * origin exactly equal to `PUBLIC_DASHBOARD_BASE_URL`.
     *
     * EVERY CASE BELOW USES THE REAL, CORRECT TOKEN. That is the point: this is
     * not a test of authentication.
     */
    const api = `http://127.0.0.1:3103/v1/internal/email/deliver`;
    const token = 'e2e-only-internal-service-token-0123456789abcdef';

    /*
     * THIS TEST'S OWN PRECONDITION. The final assertion is that an accepted
     * link reaches the TRANSPORT, which only means anything when a real
     * provider is the active one. Inheriting that from another test made this
     * pass for a reason it does not state.
     */
    test.setTimeout(120_000);
    await ensureResendActive(page);
    await resetTransport(page);

    const base = {
      to: 'recipient@brandspace.test',
      templateKey: 'auth.email_verification' as const,
      locale: 'EN' as const,
    };

    const refused = [
      // A different origin entirely.
      'https://attacker.example/collect',
      // A prefix match on the configured base — what `startsWith` would admit.
      `${DASHBOARD_BASE_URL}.attacker.example/en/verify?token=abc`,
      // The base as a path or a query value, not as the origin.
      `https://attacker.example/${DASHBOARD_BASE_URL}`,
      `https://attacker.example/?next=${encodeURIComponent(DASHBOARD_BASE_URL)}`,
      // Right host, wrong port — `origin` compares all three parts.
      'http://127.0.0.1:9999/en/verify?token=abc',
      // Right host and port, wrong scheme.
      'ftp://127.0.0.1:3101/en/verify?token=abc',
      // Not a URL at all.
      'javascript:alert(1)',
      '/en/verify?token=abc',
      'not a url',
      // Credentials in the authority, which some parsers mis-attribute.
      'https://127.0.0.1:3101@attacker.example/en/verify',
    ];

    for (const link of refused) {
      const response = await page.request.post(api, {
        data: { ...base, link },
        headers: { 'x-brandspace-service-token': token },
      });
      expect(response.status(), `must refuse: ${link}`).toBe(422);
    }

    /*
     * AND NOTHING REACHED THE TRANSPORT. A refusal that still composed and sent
     * the message would satisfy the status assertion above and fail the only
     * one that matters.
     */
    expect((await recorded(page)).filter((entry) => entry.path === '/emails')).toEqual([]);

    // A genuine dashboard link on the same route is accepted, so the guard is
    // a boundary rather than a blanket refusal of the `link` field.
    const accepted = await page.request.post(api, {
      data: { ...base, link: `${DASHBOARD_BASE_URL}/en/verify?token=abc` },
      headers: { 'x-brandspace-service-token': token },
    });
    expect(accepted.status()).toBe(200);

    const sends = (await recorded(page)).filter((entry) => entry.path === '/emails');
    expect(sends).toHaveLength(1);
    expect(String((sends[0]!.body as Record<string, unknown>)['html'])).toContain(
      `${DASHBOARD_BASE_URL}/en/verify?token=abc`,
    );
  });
});

test.describe('the Resend screen in both directions', () => {
  for (const locale of ['ar', 'en']) {
    test(`renders, reads correctly and is accessible in ${locale}`, async ({ page }) => {
      await signIn(page, locale);
      await page.goto(`${ADMIN_BASE_URL}/${locale}/console/integrations/email/resend`);

      // The direction the whole page is laid out in, not a per-element guess.
      const dir = await page.locator('html').getAttribute('dir');
      expect(dir).toBe(locale === 'ar' ? 'rtl' : 'ltr');

      // The form exists and asks for exactly what the registry declares.
      await expect(page.getByTestId('credential-input-apiKey')).toBeVisible();
      await expect(page.getByTestId('setting-fromEmail')).toBeVisible();
      await expect(page.getByTestId('setting-replyTo')).toBeVisible();

      // Whatever is stored, the page never shows it.
      expect(await page.content()).not.toContain(FIXTURE_KEY);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations, `${locale}: ${JSON.stringify(results.violations)}`).toEqual([]);

      await page.context().clearCookies();
    });
  }

  test('object storage is listed with no form, because it is not configured here', async ({
    page,
  }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/integrations/storage/cloudflare-r2`);

    /*
     * A SCREEN THAT SAVED SOMEWHERE NOTHING READ would be worse than no screen:
     * an owner rotating a key there would believe they had rotated it. The
     * object store reads `STORAGE_*` from the deployment and reads nothing
     * else, so the page describes and offers nothing to fill in.
     */
    await expect(page.getByTestId('integration-config')).toHaveCount(0);
    await expect(page.getByTestId('test-connection')).toHaveCount(0);
    // And it SAYS where it is configured, or the empty screen is just a bug.
    await expect(page.getByTestId('integration-note')).toContainText('STORAGE_*');
  });
});
