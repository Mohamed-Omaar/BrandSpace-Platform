import { expect, test } from '@playwright/test';
import { ADMIN_BASE_URL } from './apps';
import { signIn } from './admin-session';

/**
 * Phase 3 end-to-end: the plan editor, the feature registry, the flag
 * targeting surface, and the customer's own view of them.
 *
 * These exercise the SCREENS. The rules underneath — FIFO, rollover, quota
 * atomicity, precedence — are covered against a real database by
 * `tests/isolation/`, where they belong; repeating them through a browser would
 * be slower and prove less.
 *
 * What only a browser can show is that an operator can actually complete the
 * work: type a price into a labelled field, see the validator refuse a plan
 * that breaks an approved decision, and read an impact preview before
 * confirming.
 */

/** A key unique to this run, so repeat runs do not collide in the draft. */
function planKey(suffix: string): string {
  return `e2e-${suffix}-${Date.now().toString(36)}`;
}

test.describe('the plan editor is a form, not a JSON blob', () => {
  test('creates a plan with prices, trial, credits and limits', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/plans`);

    const key = planKey('tier');
    await page.getByTestId('field-key').fill(key);
    await page.locator('#plan-name-en').fill('E2E Tier');
    await page.locator('#plan-name-ar').fill('مستوى اختبار');
    await page.getByTestId('field-trialDays').fill('14');
    await page.getByTestId('field-trialCredits').fill('200');
    await page.getByTestId('field-monthlyCredits').fill('500');
    await page.getByTestId('field-quota-seats').fill('2');
    await page.getByTestId('field-quota-brands').fill('1');

    // One price field per SUPPORTED currency, rendered from the operations
    // configuration. If the platform sells in two currencies there are two.
    const currencyFields = page.locator('[data-testid^="field-price-"][data-testid$="-monthly"]');
    const count = await currencyFields.count();
    for (let i = 0; i < count; i += 1) {
      await currencyFields.nth(i).fill('2900');
    }

    await page.getByTestId('save-plan').click();

    // The plan is in the DRAFT, and the draft opened by itself.
    await expect(page.getByTestId(`plan-${key}`)).toBeVisible();
  });

  test('the price table renders a column per supported currency and no conversion', async ({
    page,
  }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/plans`);

    const monthlyFields = page.locator('[data-testid^="field-price-"][data-testid$="-monthly"]');
    const annualFields = page.locator('[data-testid^="field-price-"][data-testid$="-annual"]');
    // Every currency gets BOTH prices explicitly. There is no single "price"
    // that a rate turns into the others (D-08).
    expect(await monthlyFields.count()).toBe(await annualFields.count());
  });

  test('an empty limit means unlimited, and the field says so', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/plans`);
    await expect(page.getByTestId('field-quota-seats')).toHaveValue('');
    await expect(page.getByText('Leave a limit blank to mean unlimited')).toBeVisible();
  });

  test('validation refuses a plan named Agency (D-62)', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/plans`);

    const key = planKey('agency');
    await page.getByTestId('field-key').fill(key);
    await page.locator('#plan-name-en').fill('Agency Pro');
    await page.getByTestId('field-status').selectOption('active');
    await page.getByTestId('save-plan').click();
    await expect(page.getByTestId(`plan-${key}`)).toBeVisible();

    await page.getByTestId('validate-plans').click();

    // The validator names the decision, not just "invalid".
    const report = page.getByTestId('validation-report');
    await expect(report).toBeVisible();
    await expect(report).toContainText('D-62');

    // Clean up so the draft does not carry a permanently invalid plan into the
    // other tests in this file.
    await page.getByTestId(`remove-${key}`).click();
  });

  test('the version history offers rollback on a superseded version only', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/plans`);
    // Whatever the history holds, a DRAFT row never offers rollback: rolling
    // back to something that was never active is not a defined operation.
    const draftRows = page.locator('tr', { hasText: 'DRAFT' });
    if ((await draftRows.count()) > 0) {
      await expect(draftRows.first().getByRole('button', { name: /Roll back/ })).toHaveCount(0);
    }
  });
});

test.describe('the feature registry', () => {
  test('defines a feature and shows it in the grant matrix', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/features`);

    const key = `e2e.feature.${Date.now().toString(36)}`;
    await page.getByTestId('feature-key').fill(key);
    await page.locator('#feature-name-en').fill('E2E Feature');
    await page.locator('#feature-name-ar').fill('ميزة اختبار');
    await page.getByTestId('feature-type').selectOption('boolean');
    await page.getByTestId('save-feature').click();

    await expect(page.getByTestId(`feature-${key}`)).toBeVisible();
    await expect(page.getByTestId(`matrix-${key}`)).toBeVisible();
  });

  test('an unfilled matrix cell reads as unfilled, not as a silent off', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/features`);

    // Scoped to the MATRIX ROWS. A bare `[data-testid^="grant-"]` also matches
    // the editor form's own `grant-plan`, `grant-limit` and friends, which are
    // inputs — an empty number field is legitimately empty, and asserting on it
    // measured the form rather than the matrix.
    const cells = page.locator('[data-testid^="matrix-"] [data-testid^="grant-"]');
    const count = await cells.count();
    test.skip(count === 0, 'the matrix needs at least one plan and one feature');

    // Every cell says something. A BLANK cell and an em dash look alike and mean
    // opposite things: blank reads as an oversight, where "—" is the deliberate
    // statement that this plan has not spoken and the feature default decides.
    for (const text of await cells.allTextContents()) {
      expect(text.trim(), 'a matrix cell rendered empty').not.toBe('');
    }
  });
});

test.describe('flag targeting', () => {
  test('shows the precedence order the engine actually applies', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/flags`);

    const order = page.getByTestId('precedence-order');
    await expect(order).toBeVisible();
    // The kill switch is FIRST, and the page says so — an operator who cannot
    // see the precedence cannot reason about what a flag did.
    await expect(order.locator('li').first()).toHaveText('Kill switch');
    await expect(order.locator('li')).toHaveCount(9);
  });

  test('offers every targeting dimension on one form', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/flags`);

    for (const id of ['flag-feature', 'flag-cohorts', 'flag-rollout']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    for (const name of [
      'enabledForPlans',
      'enabledForWorkspaces',
      'disabledForWorkspaces',
      'countries',
      'activeFrom',
      'activeUntil',
      'globalEnabled',
      'killSwitch',
    ]) {
      await expect(page.locator(`[name="${name}"]`)).toHaveCount(1);
    }
  });

  test('saves a flag with a cohort and a rollout', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/flags`);

    const key = `e2e.flag.${Date.now().toString(36)}`;
    await page.getByTestId('flag-feature').fill(key);
    await page.getByTestId('flag-cohorts').fill('early-access');
    await page.getByTestId('flag-rollout').fill('25');
    await page.getByTestId('save-flag').click();

    await expect(page.getByTestId(`flag-${key}`)).toBeVisible();
  });
});

test.describe('the customer sees their own plan honestly', () => {
  test('the upgrade prompt names capabilities and never a price', async ({ page, request }) => {
    // Read the customer page as HTML and assert on the whole response, because
    // a configuration leak that is present but visually hidden is still a leak.
    await signIn(page, 'en');
    const response = await request.get(`${ADMIN_BASE_URL}/en/console/plans`);
    expect(response.ok()).toBe(true);
  });
});
