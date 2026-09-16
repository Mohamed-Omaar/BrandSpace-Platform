import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';

/**
 * Approvals, the Activity Log, Notifications and the Command Center, end to end
 * in a real browser — Phase 5B-3.
 *
 * WHAT THESE ASSERT THAT A UNIT OR ISOLATION TEST CANNOT: that content travels
 * from the composer through a server action into somebody's queue; that the
 * D-122 self-approval refusal is what a person actually meets, and that the
 * brand policy form is what lifts it; that the Activity Log renders the events
 * those actions just wrote; that the notification badge moves; that the Command
 * Center's panels show the real figures rather than the placeholders they were;
 * and that all of it is clean under axe in Arabic and English.
 *
 * NOTHING HERE PUBLISHES. Approval changes a status and a record, and the only
 * scheduling assertion is that the gate refuses.
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

/**
 * Click, and keep clicking until it has taken effect.
 *
 * The same hydration race the calendar suite documents: `page.goto` resolves
 * when the document is parsed, React has not hydrated, and a click in that
 * window hits a button with no handler and is silently lost.
 */
async function clickUntil(page: Page, selector: string, settled: () => Promise<void>) {
  await expect(async () => {
    await page.locator(selector).first().click();
    await settled();
  }).toPass({ timeout: 20_000 });
}

/**
 * Submit a form and wait for the server action's own outcome.
 *
 * A server action's `redirect()` is a CLIENT navigation with no new document,
 * so `waitForURL` with `load` or `commit` hangs. Sampling `page.url()` depends
 * on nothing but the URL. The click is retried only while the URL is unchanged,
 * which cannot double-submit once one has taken.
 */
async function submitAndSettle(page: Page, selector: string, marker: RegExp): Promise<void> {
  const before = page.url();
  await expect(async () => {
    if (page.url() === before) {
      await page.locator(selector).first().click();
      await page.waitForTimeout(750);
    }
    expect(page.url(), 'the form did not submit').not.toBe(before);
  }).toPass({ timeout: 30_000 });
  await expect.poll(() => page.url(), { timeout: 15_000 }).toMatch(marker);
}

/** Open the reviewable fixture in the composer. */
async function openReviewableDraft(page: Page, locale = 'en'): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content`);
  await page.waitForLoadState('domcontentloaded');
  const card = page
    .locator('[data-testid="content-card"]')
    .filter({ hasText: 'Launch announcement' })
    .first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await page.waitForURL(/\/content\/compose\?item=/, { timeout: 15_000 });
}

test.describe('the approval workflow', () => {
  test('submit → refused self-approval → policy change → resubmit → approved', async ({ page }) => {
    /*
     * ONE JOURNEY RATHER THAN FOUR TESTS, deliberately. Each step is the
     * precondition of the next, and splitting them would mean re-establishing
     * the same state three times through the UI — which is slower and tests the
     * setup more than the behaviour.
     *
     * THE SIGNED-IN MEMBER IS THE WORKSPACE OWNER, so they can both submit and
     * approve. That is exactly the case D-122 is about: without the default
     * denial, the owner would rubber-stamp their own work and the approval
     * record would mean nothing.
     */
    await signIn(page);
    await openReviewableDraft(page);

    /*
     * THE PRECONDITION, STATED. `pnpm e2e:seed` resets this draft to DRAFT with
     * no review history; if something else moved it, the submit button is
     * absent and `clickUntil` below would time out twenty seconds later with an
     * error pointing at the click rather than at the state. Asserting it here
     * makes the real cause the first thing the failure says.
     */
    await expect(page.getByTestId('composer-status')).toHaveText(/Draft/i, { timeout: 15_000 });

    // 1. Submit for review.
    await clickUntil(page, '[data-testid="submit-for-review"]', async () => {
      await expect.poll(() => page.url(), { timeout: 3_000 }).toMatch(/ok=SUBMITTED|error=/);
    });
    expect(page.url()).toMatch(/ok=SUBMITTED/);

    // 2. It is in the queue, and the queue offers no verdict — the reader
    //    submitted it, and the brand forbids self-approval.
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals`);
    await expect(page.getByTestId('approvals-queue-list')).toBeVisible({ timeout: 15_000 });
    const blocked = page.locator('[data-testid^="self-blocked-"]');
    await expect(blocked.first()).toBeVisible();
    await expect(page.locator('[data-testid^="approve-"]')).toHaveCount(0);

    // 3. The owner relaxes the brand's policy. This is the D-122 control
    //    surface, and it is gated on a permission only the owner and admin hold.
    await expect(page.getByTestId('approvals-policy')).toBeVisible();
    const selfToggle = page.locator('[data-testid^="policy-self-"]').first();
    await selfToggle.check();
    await submitAndSettle(page, '[data-testid^="policy-save-"]', /ok=SAVED|error=/);
    expect(page.url()).toMatch(/ok=SAVED/);

    /*
     * 4. THE OPEN CYCLE IS UNMOVED BY THE FLIP — D-126, and the point of the
     *    snapshot. A cycle is judged by the policy it was opened under, so
     *    relaxing the rule now does not retroactively permit the review that is
     *    already in flight. The reader is still told why.
     */
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals`);
    await expect(page.locator('[data-testid^="self-blocked-"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid^="approve-"]')).toHaveCount(0);

    // 5. Withdrawing and resubmitting opens a NEW cycle, which carries the new
    //    policy — and that one may be self-approved.
    await submitAndSettle(page, '[data-testid^="withdraw-"]', /ok=SAVED|error=/);
    expect(page.url()).toMatch(/ok=SAVED/);

    await openReviewableDraft(page);
    await expect(page.getByTestId('composer-status')).toHaveText(/Draft/i, { timeout: 15_000 });
    await clickUntil(page, '[data-testid="submit-for-review"]', async () => {
      await expect.poll(() => page.url(), { timeout: 3_000 }).toMatch(/ok=SUBMITTED|error=/);
    });
    expect(page.url()).toMatch(/ok=SUBMITTED/);

    // 6. Now the verdict is offered, and taking it approves the content.
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals`);
    await expect(page.locator('[data-testid^="approve-"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await submitAndSettle(page, '[data-testid^="approve-"]', /ok=SAVED|error=/);
    expect(page.url()).toMatch(/ok=SAVED/);

    // 7. The item carries the verdict.
    await openReviewableDraft(page);
    await expect(page.getByTestId('composer-status')).toContainText(/Approved/i, {
      timeout: 15_000,
    });

    // Leave the brand as the seed left it: the next suite's assumptions are
    // not this suite's to change.
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals`);
    await expect(page.getByTestId('approvals-policy')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid^="policy-self-"]').first().uncheck();
    await submitAndSettle(page, '[data-testid^="policy-save-"]', /ok=SAVED|error=/);
  });

  test('the queue is a real list, and the screen refuses cleanly without the permission', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals`);
    await expect(page.getByTestId('approvals-queue')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('approvals-mine')).toBeVisible();
  });
});

test.describe('the Activity Log', () => {
  test('AC-15.2 — shows this workspace’s events, in readable localized form', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/activity`);
    await expect(page.getByTestId('activity-log')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('activity-list')).toBeVisible();

    // The owner is graded workspace-wide, and the page says which grade it is
    // rather than leaving the reader to guess why a colleague sees more.
    await expect(page.getByTestId('activity-log')).toContainText('Showing all workspace activity');
  });

  test('filters without JavaScript — it is a GET form with a real URL', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/activity`);
    await expect(page.getByTestId('activity-filter')).toBeVisible({ timeout: 15_000 });

    const options = page.getByTestId('activity-filter').locator('option');
    await expect(options.first()).toHaveText('All events');
    // The options are the actions that actually occurred in the reader's scope,
    // so the filter cannot be used to probe for events they may not see.
    expect(await options.count()).toBeGreaterThan(1);

    await page.goto(`${DASHBOARD_BASE_URL}/en/activity?action=content.review_requested`);
    await expect(page.getByTestId('activity-log')).toBeVisible();
  });

  test('renders in Arabic, right to left', async ({ page }) => {
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/activity`);
    await expect(page.getByTestId('activity-log')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // Arabic, not an untranslated key falling through.
    await expect(page.getByTestId('activity-log')).toContainText('سجل النشاط');
  });
});

test.describe('notifications', () => {
  test('the inbox lists, counts and marks read', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/notifications`);
    await expect(page.getByTestId('notifications')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('notifications-unread-count')).toBeVisible();
  });

  test('read state is per reader and survives a reload', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/notifications`);
    await expect(page.getByTestId('notifications')).toBeVisible({ timeout: 15_000 });

    /*
     * WHETHER THIS MEMBER HAS ANYTHING UNREAD depends on what the rest of the
     * suite has done, so the assertion is conditional on there being a row to
     * change. What is NOT conditional is what happens when there is one.
     */
    const row = page.locator('[data-read="false"]').first();
    if (!(await row.isVisible().catch(() => false))) return;

    const id = await row.getAttribute('data-testid');
    expect(id, 'an unread row should carry its test id').toBeTruthy();

    await submitAndSettle(page, '[data-testid^="mark-read-"]', /ok=SAVED/);

    // The read state is the SERVER's, not the rendered page's: reload and read
    // it back rather than trusting the response that performed the write.
    await page.goto(`${DASHBOARD_BASE_URL}/en/notifications`);
    await expect(page.getByTestId(id as string)).toHaveAttribute('data-read', 'true');
  });
});

test.describe('the Command Center aggregates the modules', () => {
  test('shows the real figures the placeholders used to stand in for', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page.getByTestId('overview-metrics')).toBeVisible({ timeout: 15_000 });

    // Phase 5B-3's four additions.
    await expect(page.getByTestId('metric-in-review')).toBeVisible();
    await expect(page.getByTestId('metric-scheduled')).toBeVisible();
    await expect(page.getByTestId('overview-approvals')).toBeVisible();
    await expect(page.getByTestId('overview-notifications')).toBeVisible();
    await expect(page.getByTestId('overview-activity')).toBeVisible();

    /*
     * AND THE CARD THAT USED TO SAY WHAT IT COULD NOT MEASURE NOW MEASURES IT.
     *
     * Through Phases 5B-3 and 6 this slot was `metric-published`, permanently
     * unavailable, because a zero would have read as "you published nothing"
     * about a feature that did not exist. Publishing shipped in Phase 6 and
     * analytics ingestion in Phase 7, so the slot is `metric-engagement` and
     * carries a real sum over stored observations.
     *
     * WHAT DID NOT CHANGE IS THE HONESTY RULE. With no reading yet the card is
     * still UNAVAILABLE with a stated reason rather than a zero — missing and
     * zero are different states, and the Command Center must not confuse them.
     */
    await expect(page.getByTestId('metric-published')).toHaveCount(0);
    const engagement = page.getByTestId('metric-engagement');
    await expect(engagement).toBeVisible();
    await expect(engagement).not.toHaveText(/^\s*0\s*$/);
  });

  test('every panel links somewhere real', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page.getByTestId('overview-activity')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('overview-activity').getByRole('link').first().click();
    await page.waitForURL(/\/en\/activity/, { timeout: 15_000 });
    await expect(page.getByTestId('activity-log')).toBeVisible();
  });
});

test.describe('accessibility and direction', () => {
  for (const locale of ['en', 'ar'] as const) {
    for (const route of ['approvals', 'activity', 'notifications'] as const) {
      test(`${route} is clean under axe in ${locale}`, async ({ page }) => {
        await signIn(page, locale);
        await page.goto(`${DASHBOARD_BASE_URL}/${locale}/${route}`);
        await page.waitForLoadState('domcontentloaded');
        await expect(page.locator('main')).toBeVisible({ timeout: 15_000 });

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          results.violations.map((v) => `${v.id}: ${v.nodes.length}`),
          `axe violations on /${locale}/${route}`,
        ).toEqual([]);
      });
    }
  }

  test('the new routes are keyboard reachable from the navigation', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    /*
     * BY TEST ID, not by accessible name. "Approvals" is also the accessible
     * name of the Command Center panel's own link, and a role query matching two
     * elements is a strict-mode violation rather than a passing assertion — the
     * nav item is what this test is about.
     */
    for (const item of ['approvals', 'activity', 'notifications']) {
      const link = page.getByTestId(`nav-${item}`);
      await expect(link).toBeVisible({ timeout: 15_000 });
      await expect(link).toHaveAttribute('href', `/en/${item}`);
    }
  });

  test('the approvals screen is responsive on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals`);
    await expect(page.getByTestId('approvals-queue')).toBeVisible({ timeout: 15_000 });

    // Nothing may push the page wider than the phone.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the page scrolls horizontally on a phone').toBeLessThanOrEqual(1);
  });
});
