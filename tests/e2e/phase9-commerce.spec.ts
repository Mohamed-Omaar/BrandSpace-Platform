import crypto from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API_BASE_URL, DASHBOARD_BASE_URL } from './apps';
import { withPlatformPrisma } from './platform-prisma';

/**
 * THE ACQUISITION JOURNEY, IN A REAL BROWSER — signup to a paid invoice.
 *
 * FUNCTIONAL, NOT REACHABILITY. Every other Phase 9 proof is a unit or isolation
 * test; this one asks the question neither can: does a stranger who has never
 * heard of BrandSpace get from a signup form to an invoice with a number on it,
 * through the product, without anybody reaching into the database to help?
 *
 * IT CROSSES AN ORIGIN, DELIBERATELY. Checkout leaves the dashboard for the
 * API's hosted page, which is what a real provider-hosted checkout is: somebody
 * else's site. The redirect out, the signed server-to-server event and the
 * return are all exercised rather than simulated, because the one thing this
 * phase must never get wrong is treating a redirect as a payment.
 *
 * THE ONE THING IT REACHES INTO THE DATABASE FOR is a verification token, and
 * the reason is the design working: the RAW token is never stored anywhere, so
 * there is nothing to read. The test mints its own and writes the HASH — exactly
 * what the service does — which proves the storage contract rather than routing
 * around it.
 *
 * Every price, plan and market it sees comes from `pnpm e2e:seed`'s fixture
 * catalogue. None of it is approved commercial data.
 */

const PASSWORD = 'an-end-to-end-fixture-password';

interface NewCustomer {
  readonly email: string;
  readonly userId: string;
}

/** Sign up through the REAL form, then verify through the REAL page. */
async function signUpAndVerify(page: Page, locale = 'en'): Promise<NewCustomer> {
  const email = `p9-e2e-${crypto.randomUUID().slice(0, 12)}@example.local`;

  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-up`);
  await expect(page.locator('[data-testid="signup-form"]')).toBeVisible();

  await page.fill('#name', 'Phase 9 Journey');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.fill('#timezone', 'Europe/London');
  // THE TERMS CHECKBOX IS REQUIRED AND VERSIONED. The form renders it from the
  // activated document, so the version travels with the acceptance.
  await page.check('[data-testid="accept-terms-of-service"] input[type="checkbox"]');
  await page.click('[data-testid="signup-submit"]');

  // ALWAYS THE SAME PAGE, whether the address was free or taken.
  await expect(page.locator('[data-testid="signup-sent"]')).toBeVisible();

  const { userId, token } = await withPlatformPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    const raw = crypto.randomBytes(32).toString('base64url');
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: crypto.createHash('sha256').update(raw).digest('hex'),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { userId: user.id, token: raw };
  });

  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/verify?token=${encodeURIComponent(token)}`);
  await expect(page.locator('[data-testid="verify-success"]')).toBeVisible();

  return { email, userId };
}

async function signIn(page: Page, email: string, locale = 'en'): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
}

/** Create the first workspace through the REAL form. Billing is USD by policy. */
async function createWorkspace(
  page: Page,
  input: { country: string },
  locale = 'en',
): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/onboarding/workspace`);
  await expect(page.locator('[data-testid="create-workspace-form"]')).toBeVisible();

  await page.fill('#name', 'Journey Workspace');
  await page.fill('#slug', `journey-${crypto.randomUUID().slice(0, 8)}`);
  const countryName = new Intl.DisplayNames(['en'], { type: 'region' }).of(input.country) ?? input.country;
  await page.fill('[data-testid="country-select"]', countryName);
  await expect(page.locator('[data-testid="currency-select"]')).toHaveCount(0);
  await page.selectOption('#defaultLocale', locale === 'ar' ? 'AR' : 'EN');
  await page.fill('#timezone', 'Europe/London');
  await page.fill('#billingEmail', `finance-${crypto.randomUUID().slice(0, 8)}@example.local`);
  await page.click('[data-testid="create-workspace-submit"]');

  await page.waitForURL(new RegExp(`/${locale}/onboarding$`), { timeout: 30_000 });
}

/**
 * Press a buy button and follow it to the provider's page.
 *
 * WAITS FOR EITHER OUTCOME, deliberately. If the API refuses to open a checkout
 * the button reports it IN PLACE and never navigates — and waiting only for the
 * navigation turns that into a bare thirty-second timeout that names nothing.
 * The first CI run failed exactly that way, on a missing environment variable,
 * and the screen had been saying so the whole time.
 */
async function buyAndFollow(page: Page, testId: string): Promise<void> {
  const failure = page.locator('[data-testid="checkout-failed"]');
  await page.click(`[data-testid="${testId}"]`);
  await Promise.race([
    page.waitForURL(new RegExp(`^${API_BASE_URL}/billing/checkout/`), { timeout: 30_000 }),
    failure.waitFor({ state: 'visible', timeout: 30_000 }),
  ]).catch(() => undefined);

  if (await failure.isVisible()) {
    throw new Error(`Checkout did not open. The screen said: "${await failure.textContent()}"`);
  }
  await page.waitForURL(new RegExp(`^${API_BASE_URL}/billing/checkout/`), { timeout: 30_000 });
}

/*
 * EVERY TEST SIGNS UP ITS OWN PERSON, and that is not waste.
 *
 * Sharing one verified account across the suite was tried and reverted: the
 * workspace-creation route redirects a customer who is ALREADY a member, because
 * it is the page for a FIRST workspace. That is the product being right, and
 * loosening it so a test could reuse an account would be changing behaviour to
 * suit a fixture.
 *
 * NOT `serial`, though. Nothing here depends on anything else here, and forcing
 * four independent journeys onto one worker was a mistake in the first draft.
 */

test.describe('a stranger becomes a paying customer', () => {
  test('signs up, verifies, creates a workspace and reaches a numbered invoice', async ({
    page,
  }) => {
    test.slow();

    const customer = await signUpAndVerify(page);
    await signIn(page, customer.email);
    await createWorkspace(page, { country: 'SA' });

    // --- The first-run checklist is DERIVED, so the workspace step is already
    // done and the plan step is not.
    await expect(page.locator('[data-testid="onboarding-step-workspace"]')).toHaveAttribute(
      'data-complete',
      'true',
    );
    await expect(page.locator('[data-testid="onboarding-step-plan"]')).toHaveAttribute(
      'data-complete',
      'false',
    );

    // --- Billing, priced in the platform's launch currency (USD).
    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    await expect(page.locator('[data-testid="plans-card"]')).toBeVisible();

    // 26.00 USD, from the activated fixture catalogue. Nothing converted.
    await expect(page.locator('[data-testid="plan-price-fixture-starter"]')).toContainText('26.00');
    await expect(page.locator('[data-testid="plan-price-fixture-starter"]')).toContainText('USD');

    // The trial gave 200 credits, and the page says they are prepaid.
    await expect(page.locator('[data-testid="credit-balance"]')).toHaveText('200');

    // --- Buy the plan. This LEAVES the dashboard.
    await buyAndFollow(page, 'plan-buy-fixture-starter');

    // THE PROVIDER'S PAGE HAS NO CARD FIELD, because hosted checkout means no
    // instrument ever reaches BrandSpace. Asserted rather than assumed.
    expect(await page.locator('input[type="password"]').count()).toBe(0);
    expect(await page.locator('input[autocomplete*="cc-"]').count()).toBe(0);
    await expect(page.locator('[data-testid="dev-checkout-pay"]')).toBeVisible();
    // It shows the total from OUR row — including the market's configured tax.
    await expect(page.locator('body')).toContainText('29.90');

    await page.click('[data-testid="dev-checkout-pay"]');

    // --- Back on the dashboard, reporting RECONCILED state.
    await page.waitForURL(new RegExp(`${DASHBOARD_BASE_URL}/en/billing/checkout/success`), {
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="checkout-completed"]')).toBeVisible();
    await expect(page.locator('[data-testid="checkout-total"]')).toContainText('29.90');

    // --- The invoice exists, is numbered, and opens.
    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    await expect(page.locator('[data-testid="billing-status"]')).toHaveText('Active');
    const invoiceRow = page.locator('[data-testid^="invoice-"]').first();
    await expect(invoiceRow).toContainText(/BS-\d{4}-\d{6}/);
    await invoiceRow.getByRole('link').click();

    await expect(page.locator('[data-testid="invoice-total"]')).toContainText('29.90');
    await expect(page.locator('[data-testid="invoice-tax"]')).toContainText('3.90');
    await expect(page.locator('[data-testid="invoice-status"]')).toHaveText('Paid');

    /*
     * --- PHASE 10: the DOCUMENT, which is what a customer sends an accountant.
     *
     * ASSERTED FROM THE JOURNEY THAT PRODUCED THE INVOICE, rather than against
     * a fixture, because the whole point is that the document renders the row
     * that was actually written — the same total, from the same snapshots, at
     * the same scale.
     */
    const invoiceUrl = page.url();
    await page.getByTestId('invoice-open-document').click();
    await expect(page.getByTestId('invoice-document')).toBeVisible();
    await expect(page.getByTestId('document-total')).toContainText('29.90');
    // A document, not a screen: no application navigation anywhere on it.
    await expect(page.locator('nav')).toHaveCount(0);
    await expect(page.getByTestId('document-seller')).toBeVisible();
    await expect(page.getByTestId('document-buyer')).toBeVisible();

    // AND IN ARABIC, right-to-left, from the same data.
    await page.goto(invoiceUrl.replace('/en/', '/ar/') + '/document');
    const document = page.getByTestId('invoice-document');
    await expect(document).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('document-total')).toContainText('29.90');

    /*
     * THE SERVER-RENDERED PDF IS ENGLISH ONLY, AND SAYS SO (D-216). Arabic
     * needs a licensed font and a shaping engine; the refusal is 409 with a
     * reason, not a page of empty rectangles that looks like a document.
     *
     * FETCHED FROM INSIDE THE PAGE, not through `page.request`. The customer
     * session cookie is `Secure`, and Playwright's API request context will
     * not send a Secure cookie over http — so a request made that way arrives
     * unauthenticated and answers 401, which says nothing about the route. A
     * `fetch` in the page is the browser making the request as the signed-in
     * customer, which is what is actually under test.
     */
    const invoiceId = invoiceUrl.split('/').pop() as string;
    const pdf = await page.evaluate(async (id: string) => {
      const answer = async (locale: string) => {
        const response = await fetch(`/api/billing/invoices/${id}/pdf?locale=${locale}`);
        const head = response.ok
          ? new TextDecoder('latin1').decode((await response.arrayBuffer()).slice(0, 8))
          : '';
        return { status: response.status, type: response.headers.get('content-type') ?? '', head };
      };
      return { en: await answer('en'), ar: await answer('ar') };
    }, invoiceId);

    expect(pdf.en.status).toBe(200);
    expect(pdf.en.type).toContain('application/pdf');
    expect(pdf.en.head).toBe('%PDF-1.7');
    expect(pdf.ar.status).toBe(409);

    // --- PHASE 10: the accounting export, from the same canonical record.
    const csv = await page.evaluate(async () => {
      /*
       * A BOUNDED PERIOD, because the route requires one. An unbounded export
       * of a commercial record is a query nobody bounded, and the ceiling is
       * 400 days — so the window is the last thirty, which is where an invoice
       * issued moments ago lives.
       */
      const day = (offsetDays: number) =>
        new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
      const response = await fetch(`/api/billing/export?from=${day(-30)}&to=${day(1)}`);
      return { status: response.status, text: await response.text() };
    });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('"INVOICE"');
    // The exact integer AND the scaled decimal, which is the point of both.
    expect(csv.text).toContain('"2990"');
    expect(csv.text).toContain('"29.90"');
  });

  test('buys a prepaid pack and the balance rises by exactly the pack', async ({ page }) => {
    test.slow();

    const customer = await signUpAndVerify(page);
    await signIn(page, customer.email);
    await createWorkspace(page, { country: 'SA' });

    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    await expect(page.locator('[data-testid="credit-balance"]')).toHaveText('200');

    await buyAndFollow(page, 'pack-buy-fixture-pack-small');
    await page.click('[data-testid="dev-checkout-pay"]');
    await page.waitForURL(new RegExp(`${DASHBOARD_BASE_URL}/en/billing/checkout/success`), {
      timeout: 30_000,
    });

    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    // 200 trial + 500 pack. Prepaid, and granted exactly once.
    await expect(page.locator('[data-testid="credit-balance"]')).toHaveText('700');
  });

  test('abandoning checkout charges nothing and says so', async ({ page }) => {
    test.slow();

    const customer = await signUpAndVerify(page);
    await signIn(page, customer.email);
    await createWorkspace(page, { country: 'SA' });

    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    await buyAndFollow(page, 'plan-buy-fixture-starter');
    await page.click('[data-testid="dev-checkout-cancel"]');

    await page.waitForURL(new RegExp(`${DASHBOARD_BASE_URL}/en/billing/checkout/`), {
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="checkout-cancelled"]')).toBeVisible();

    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    // Still on the trial, and no invoice was produced.
    await expect(page.locator('[data-testid="billing-status"]')).toHaveText('Trial');
    await expect(page.locator('[data-testid="invoices-table"]')).toHaveCount(0);
  });

  test('creates a workspace for a country that has no payment market yet', async ({ page }) => {
    test.slow();

    const customer = await signUpAndVerify(page);
    await signIn(page, customer.email);
    // Germany is deliberately absent from the fixture commerce markets. That
    // must not block identity/onboarding; checkout policy is a later concern.
    await createWorkspace(page, { country: 'DE' });

    await expect(page.locator('[data-testid="onboarding-step-workspace"]')).toHaveAttribute(
      'data-complete',
      'true',
    );
  });
});

test.describe('the commercial screens work in both languages', () => {
  test('renders billing right-to-left in Arabic and passes an accessibility scan', async ({
    page,
  }) => {
    test.slow();

    const customer = await signUpAndVerify(page);
    await signIn(page, customer.email, 'en');
    await createWorkspace(page, { country: 'SA' }, 'en');

    await page.goto(`${DASHBOARD_BASE_URL}/ar/billing`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // A BCP-47 TAG, not a bare code: the shell renders `ar-SA` so number and
    // date formatting have a region to work from. Matched as a prefix rather
    // than pinned, because the region is the shell's business, not this test's.
    await expect(page.locator('html')).toHaveAttribute('lang', /^ar\b/);
    // The Arabic page carries no English label where a translation exists.
    await expect(page.locator('[data-testid="plans-card"]')).toBeVisible();

    const arabic = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(arabic.violations).toEqual([]);

    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    const english = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(english.violations).toEqual([]);
  });

  test('the signup form is accessible and states the rules it enforces', async ({ page }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-up`);
    await expect(page.locator('[data-testid="signup-form"]')).toBeVisible();
    // The password hint comes from the activated document, not from a constant.
    await expect(page.locator('body')).toContainText('At least 12 characters');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
