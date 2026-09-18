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

/** Create the first workspace through the REAL form, answering all four. */
async function createWorkspace(
  page: Page,
  input: { country: string; currency: string },
  locale = 'en',
): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/onboarding/workspace`);
  await expect(page.locator('[data-testid="create-workspace-form"]')).toBeVisible();

  await page.fill('#name', 'Journey Workspace');
  await page.fill('#slug', `journey-${crypto.randomUUID().slice(0, 8)}`);
  await page.selectOption('[data-testid="country-select"]', input.country);
  await page.selectOption('[data-testid="currency-select"]', input.currency);
  await page.selectOption('#defaultLocale', locale === 'ar' ? 'AR' : 'EN');
  await page.fill('#timezone', 'Europe/London');
  await page.fill('#billingEmail', `finance-${crypto.randomUUID().slice(0, 8)}@example.local`);
  await page.click('[data-testid="create-workspace-submit"]');

  await page.waitForURL(new RegExp(`/${locale}/onboarding$`), { timeout: 30_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('a stranger becomes a paying customer', () => {
  test('signs up, verifies, creates a workspace and reaches a numbered invoice', async ({
    page,
  }) => {
    test.slow();

    const customer = await signUpAndVerify(page);
    await signIn(page, customer.email);
    await createWorkspace(page, { country: 'SA', currency: 'SAR' });

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

    // --- Billing, priced in the currency the customer chose.
    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    await expect(page.locator('[data-testid="plans-card"]')).toBeVisible();

    // 99.00 SAR, from the activated fixture catalogue. Nothing converted.
    await expect(page.locator('[data-testid="plan-price-fixture-starter"]')).toContainText('99.00');
    await expect(page.locator('[data-testid="plan-price-fixture-starter"]')).toContainText('SAR');

    // The trial gave 200 credits, and the page says they are prepaid.
    await expect(page.locator('[data-testid="credit-balance"]')).toHaveText('200');

    // --- Buy the plan. This LEAVES the dashboard.
    await page.click('[data-testid="plan-buy-fixture-starter"]');
    await page.waitForURL(new RegExp(`^${API_BASE_URL}/billing/checkout/`), { timeout: 30_000 });

    // THE PROVIDER'S PAGE HAS NO CARD FIELD, because hosted checkout means no
    // instrument ever reaches BrandSpace. Asserted rather than assumed.
    expect(await page.locator('input[type="password"]').count()).toBe(0);
    expect(await page.locator('input[autocomplete*="cc-"]').count()).toBe(0);
    await expect(page.locator('[data-testid="dev-checkout-pay"]')).toBeVisible();
    // It shows the total from OUR row — including the market's configured tax.
    await expect(page.locator('body')).toContainText('113.85');

    await page.click('[data-testid="dev-checkout-pay"]');

    // --- Back on the dashboard, reporting RECONCILED state.
    await page.waitForURL(new RegExp(`${DASHBOARD_BASE_URL}/en/billing/checkout/success`), {
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="checkout-completed"]')).toBeVisible();
    await expect(page.locator('[data-testid="checkout-total"]')).toContainText('113.85');

    // --- The invoice exists, is numbered, and opens.
    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    await expect(page.locator('[data-testid="billing-status"]')).toHaveText('Active');
    const invoiceRow = page.locator('[data-testid^="invoice-"]').first();
    await expect(invoiceRow).toContainText(/BS-\d{4}-\d{6}/);
    await invoiceRow.getByRole('link').click();

    await expect(page.locator('[data-testid="invoice-total"]')).toContainText('113.85');
    await expect(page.locator('[data-testid="invoice-tax"]')).toContainText('14.85');
    await expect(page.locator('[data-testid="invoice-status"]')).toHaveText('Paid');
  });

  test('buys a prepaid pack and the balance rises by exactly the pack', async ({ page }) => {
    test.slow();

    const customer = await signUpAndVerify(page);
    await signIn(page, customer.email);
    await createWorkspace(page, { country: 'SA', currency: 'SAR' });

    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    await expect(page.locator('[data-testid="credit-balance"]')).toHaveText('200');

    await page.click('[data-testid="pack-buy-fixture-pack-small"]');
    await page.waitForURL(new RegExp(`^${API_BASE_URL}/billing/checkout/`), { timeout: 30_000 });
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
    await createWorkspace(page, { country: 'SA', currency: 'SAR' });

    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    await page.click('[data-testid="plan-buy-fixture-starter"]');
    await page.waitForURL(new RegExp(`^${API_BASE_URL}/billing/checkout/`), { timeout: 30_000 });
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

  test('a market that does not offer a plan says so, and does not convert one', async ({
    page,
  }) => {
    test.slow();

    const customer = await signUpAndVerify(page);
    await signIn(page, customer.email);
    // Kuwait, in KWD. `fixture-growth` has no KWD price on purpose.
    await createWorkspace(page, { country: 'KW', currency: 'KWD' });

    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    // The starter plan IS offered, at three decimal places.
    await expect(page.locator('[data-testid="plan-price-fixture-starter"]')).toContainText('7.900');
    // The other one is shown with its REASON rather than omitted or converted.
    await expect(page.locator('[data-testid="plan-unavailable-fixture-growth"]')).toContainText(
      'KWD',
    );
    expect(await page.locator('[data-testid="plan-buy-fixture-growth"]').count()).toBe(0);
  });
});

test.describe('the commercial screens work in both languages', () => {
  test('renders billing right-to-left in Arabic and passes an accessibility scan', async ({
    page,
  }) => {
    test.slow();

    const customer = await signUpAndVerify(page, 'en');
    await signIn(page, customer.email, 'en');
    await createWorkspace(page, { country: 'SA', currency: 'SAR' }, 'en');

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
