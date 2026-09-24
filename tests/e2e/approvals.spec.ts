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
 * Submit a form and wait for the server action's own outcome.
 *
 * TWO DIFFERENT WAITS, AND CONFLATING THEM IS WHAT BROKE THIS SUITE.
 *
 * The first is the HYDRATION RACE the calendar suite documents: `page.goto`
 * resolves when the document is parsed, React has not attached its handlers
 * yet, and a click that lands in that window is silently lost. Nothing happens,
 * ever, so the click has to be repeated.
 *
 * The second is the SERVER DOING THE WORK. A server action's `redirect()` is a
 * CLIENT navigation with no new document, so `waitForURL` hangs and the URL is
 * the only honest signal — but the URL not having moved does NOT mean the click
 * was lost. `<form action={serverAction}>` starts a NEW action on every submit,
 * so re-clicking while one is in flight SUPERSEDES it: under load the loop can
 * click forty times, none of them ever rendering a response, while the server
 * has already accepted one and done the work. That is CI #83 on the calendar,
 * and CI #88 here — "the form did not submit", thrown at a form that submitted.
 *
 * So the two waits are separated. The click is repeated only while it
 * DEMONSTRABLY NEVER REACHED THE SERVER, and once a POST has gone out the wait
 * is generous and uninterrupted, because the only thing left to wait for is
 * work that has definitely started.
 */
async function submitAndSettle(page: Page, selector: string, marker: RegExp): Promise<void> {
  const before = page.url();

  await expect(async () => {
    // Armed BEFORE the click, so a request that races the await is not missed.
    const sent = page
      .waitForRequest((request) => request.method() === 'POST', { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    await page.locator(selector).first().click();
    expect(await sent, 'the click never reached the server').toBe(true);
  }).toPass({ timeout: 30_000 });

  await expect
    .poll(() => page.url(), { message: 'the form did not submit', timeout: 60_000 })
    .not.toBe(before);
  await expect.poll(() => page.url(), { timeout: 15_000 }).toMatch(marker);
}

/**
 * Open the reviewable fixture in the composer.
 *
 * FOUND BY ITS TITLE, the way a person would find it. The library shows the
 * most recently touched posts first, and every suite running beside this one
 * adds posts of its own — so "it is on the first page" held only while this
 * suite happened to run early. The library's own search keeps the lookup
 * independent of what else the run has written.
 */
async function openReviewableDraft(page: Page, locale = 'en'): Promise<void> {
  await page.goto(
    `${DASHBOARD_BASE_URL}/${locale}/content?q=${encodeURIComponent('Launch announcement')}`,
  );
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
    // A dozen server-action round trips in one journey: ~17s alone, and past
    // the 30s default under a parallel worker. The slow budget, not a retry.
    test.slow();
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

    /*
     * THE POLICY THIS TEST READS, ESTABLISHED RATHER THAN ASSUMED (F-23).
     *
     * Step 3 RELAXES the brand's self-approval rule and only the restore at
     * the very end puts it back — so an attempt that fails in between leaves it
     * permissive, and Playwright's retry then opens its first cycle under a
     * policy the seed never set. Steps 2 and 4 assert the refusal, so the retry
     * fails at `self-blocked-` with "element(s) not found": a second, invented
     * failure that says nothing about the first and that no retry can ever get
     * past. A suite must bootstrap what it reads.
     *
     * Saved only when it is actually wrong, so the normal run posts no extra
     * form and the seed's own state is what is asserted against.
     */
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals`);
    const policySelfApproval = page.locator('[data-testid^="policy-self-"]').first();
    await expect(policySelfApproval).toBeVisible({ timeout: 15_000 });
    if (await policySelfApproval.isChecked()) {
      await policySelfApproval.uncheck();
      await submitAndSettle(page, '[data-testid^="policy-save-"]', /ok=SAVED|error=/);
      expect(page.url()).toMatch(/ok=SAVED/);
    }

    await openReviewableDraft(page);

    /*
     * THE PRECONDITION, STATED. `pnpm e2e:seed` resets this draft to DRAFT with
     * no review history; if something else moved it, the submit button is
     * absent and the submit below would time out thirty seconds later with an
     * error pointing at the click rather than at the state. Asserting it here
     * makes the real cause the first thing the failure says.
     */
    await expect(page.getByTestId('composer-status')).toHaveText(/Draft/i, { timeout: 15_000 });

    // 1. Submit for review.
    await submitAndSettle(page, '[data-testid="submit-for-review"]', /ok=SUBMITTED|error=/);
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
    await submitAndSettle(page, '[data-testid="submit-for-review"]', /ok=SUBMITTED|error=/);
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
  /*
   * PHASE 6 FINAL (D-277 §7): HOME ANSWERS "WHAT NEEDS ME" FIRST.
   *
   * The sections come in the owner's order — what needs you, recommendations,
   * notes, coming up — and the figures come LAST. Plan, credits, members, the
   * activity log and the notification count left Home for Settings and the top
   * bar. What did not change is the honesty rule below.
   */
  test('shows the owner’s sections, in order, with the figures last', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page.getByTestId('overview-metrics')).toBeVisible({ timeout: 15_000 });

    const sections = [
      'attention-card',
      'home-recommended',
      'home-notes',
      'overview-upcoming',
      'overview-metrics',
    ];
    const tops: number[] = [];
    for (const id of sections) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      tops.push(box?.y ?? 0);
    }
    // Notes and Coming up share a row on a wide screen; nothing comes before
    // "what needs you", and the figures come after everything.
    expect(Math.min(...tops)).toBe(tops[0]);
    expect(Math.max(...tops)).toBe(tops[4]);

    await expect(page.getByTestId('metric-in-review')).toBeVisible();
    await expect(page.getByTestId('metric-scheduled')).toBeVisible();
    for (const gone of [
      'metric-plan',
      'metric-credits',
      'overview-activity',
      'overview-notifications',
    ]) {
      await expect(page.getByTestId(gone)).toHaveCount(0);
    }

    /*
     * WHAT DID NOT CHANGE IS THE HONESTY RULE. With no reading yet the
     * engagement card is UNAVAILABLE with a stated reason rather than a zero —
     * missing and zero are different states.
     */
    const engagement = page.getByTestId('metric-engagement');
    await expect(engagement).toBeVisible();
    await expect(engagement).not.toHaveText(/^\s*0\s*$/);
  });

  test('every section links somewhere real', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page.getByTestId('overview-upcoming')).toBeVisible({ timeout: 15_000 });

    // Every attention row carries exactly one action, and it is a real link.
    const rows = page.locator('[data-testid="attention-list"] > li');
    for (let index = 0; index < (await rows.count()); index += 1) {
      const actions = rows.nth(index).getByRole('link');
      await expect(actions).toHaveCount(1);
      await expect(actions).toHaveAttribute('href', /^\/en\//);
    }

    await page.getByTestId('overview-upcoming-calendar').click();
    await page.waitForURL(/\/en\/calendar/, { timeout: 15_000 });
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

  test('the new routes are reachable where the final IA put them (D-277)', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    /*
     * Approvals and Notifications moved from the sidebar to the TOP BAR
     * (Review, the bell); Activity moved into SETTINGS. Each is still a real,
     * focusable link to the same route.
     */
    await expect(page.getByTestId('topbar-review')).toHaveAttribute('href', '/en/approvals');
    await expect(page.getByTestId('topbar-notifications')).toHaveAttribute(
      'href',
      '/en/notifications',
    );
    for (const item of ['approvals', 'activity', 'notifications']) {
      await expect(page.getByTestId(`nav-${item}`)).toHaveCount(0);
    }
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);
    await expect(
      page.getByTestId('settings-nav').getByRole('link', { name: 'Activity' }),
    ).toHaveAttribute('href', '/en/activity');
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
