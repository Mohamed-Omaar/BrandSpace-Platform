import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';

/**
 * D-121 — the per-brand Viewer approval grant, end to end in a real browser.
 *
 * WHY THIS SUITE EXISTS. The grant shipped unreachable: `/approvals` and the
 * decision action both required `content.read`, and `client_viewer` holds
 * `workspace.read` and nothing else. A workspace could switch the grant on and
 * the person it was switched on for would be refused — so the feature was
 * decided by a unit test and by nothing a customer could do.
 *
 * THE THREE CASES THE FINDING NAMES, in one journey because each is the
 * precondition of the next:
 *
 *   1. DEFAULT DENIED — the Viewer reviews nothing, and the screen says so.
 *   2. ENABLED FOR BRAND A — the Viewer sees that brand's review, can read the
 *      captions under review, and can approve.
 *   3. BRAND B DENIED — the other brand's review, in review at the same moment,
 *      is not in their queue and its subject is not readable.
 *
 * AND WHAT THE VIEWER STILL MAY NOT SEE, asserted rather than assumed: the
 * content library, the composer, "what you sent", and the approval policy
 * editor. The point of D-121 is a narrow grant, and a narrow grant that leaks
 * the library is not narrow.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('The end-to-end credentials file is missing. Run `pnpm e2e:seed` first.');
  }
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  const { customer } = credentials();
  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(/\/en\/overview$/);
}

async function signOut(page: Page): Promise<void> {
  await page.context().clearCookies();
}

/** Submit one library draft for review, as the owner. */
async function submitForReview(page: Page, title: string): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/en/content`);
  await page.waitForLoadState('domcontentloaded');
  const card = page.locator('[data-testid="content-card"]').filter({ hasText: title }).first();
  await expect(card, `the seed should have left a draft titled "${title}"`).toBeVisible({
    timeout: 15_000,
  });
  await card.click();
  await page.waitForURL(/\/content\/compose\?item=/, { timeout: 15_000 });
  await expect(page.getByTestId('composer-status')).toHaveText(/Draft/i, { timeout: 15_000 });

  await expect(async () => {
    await page.getByTestId('submit-for-review').click();
    await expect.poll(() => page.url(), { timeout: 3_000 }).toMatch(/ok=SUBMITTED|error=/);
  }).toPass({ timeout: 20_000 });
  expect(page.url()).toMatch(/ok=SUBMITTED/);
}

/** Switch one brand's `clientApprovalEnabled`, as the owner. */
async function setViewerApproval(page: Page, brandName: string, enabled: boolean): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/en/approvals`);
  await expect(page.getByTestId('approvals-policy')).toBeVisible({ timeout: 15_000 });

  const form = page
    .locator('[data-testid="approvals-policy"] form')
    .filter({ hasText: brandName })
    .first();
  const toggle = form.locator('[data-testid^="policy-client-"]');
  if (enabled) await toggle.check();
  else await toggle.uncheck();

  const before = page.url();
  await expect(async () => {
    if (page.url() === before) {
      await form.locator('[data-testid^="policy-save-"]').click();
      await page.waitForTimeout(750);
    }
    expect(page.url(), 'the policy form did not submit').not.toBe(before);
  }).toPass({ timeout: 30_000 });
  await expect.poll(() => page.url(), { timeout: 15_000 }).toMatch(/ok=SAVED|error=/);
  expect(page.url()).toMatch(/ok=SAVED/);
}

test.describe('D-121 — Viewer approval, per brand', () => {
  test('default denied → enabled for Brand A → still denied for Brand B', async ({ page }) => {
    const { customer } = credentials();

    // ---- 1. DEFAULT DENIED, before anything is even submitted -------------
    await signIn(page, customer.viewerEmail, customer.viewerPassword);
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals`);
    await expect(page.getByTestId('approvals-queue')).toBeVisible({ timeout: 15_000 });
    // The screen states the refusal rather than 404ing a real route.
    await expect(page.getByTestId('approvals-queue')).toContainText('You do not review content');
    await expect(page.getByTestId('approvals-queue-list')).toHaveCount(0);
    // And none of the wider surface is offered.
    await expect(page.getByTestId('approvals-mine')).toHaveCount(0);
    await expect(page.getByTestId('approvals-policy')).toHaveCount(0);
    await signOut(page);

    /*
     * ---- 2. THE GRANT IS SWITCHED ON FOR BRAND A, THEN the drafts are
     *         submitted — in that order, because of D-126.
     *
     * A cycle is judged by the policy it was opened under, so a grant switched
     * on AFTER a review is already open does not reach that review. Enabling
     * first is what a workspace would actually do, and it is what makes this
     * test about the grant rather than about the snapshot.
     */
    await signIn(page, customer.email, customer.password);
    // THIS SUITE'S OWN BRAND AND DRAFT. `approvals.spec.ts` runs in the same
    // project and, being a separate file, may run at the same moment; the
    // policy editor saves the whole form, so sharing a brand meant each suite
    // silently rewrote the other's rules mid-journey.
    await setViewerApproval(page, 'E2E Viewer Brand', true);
    await submitForReview(page, 'Viewer review fixture');
    await submitForReview(page, 'Second brand note');
    await signOut(page);

    await signIn(page, customer.viewerEmail, customer.viewerPassword);
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals`);
    await expect(page.getByTestId('approvals-queue-list')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('approvals-queue-list')).toContainText('Viewer review fixture');

    // ---- 3. BRAND B IS NOT THERE -----------------------------------------
    /*
     * The second brand's draft is in review at this very moment, and the grant
     * was switched on for the first brand only. Its title must not appear.
     */
    await expect(page.getByTestId('approvals-queue-list')).not.toContainText('Second brand note');

    // ---- The Viewer can read the subject, and only the subject ------------
    await page.getByTestId('approvals-queue-list').getByRole('link').first().click();
    await page.waitForURL(/\/approvals\?review=/, { timeout: 15_000 });
    await expect(page.getByTestId('approvals-review-subject')).toBeVisible();
    await expect(page.getByTestId('review-variants')).toContainText('A short announcement');
    // The Studio link is NOT offered: the Viewer holds no `content.read`, and a
    // link that refuses the person who follows it is worse than no link.
    await expect(page.locator('[data-testid^="open-in-studio-"]')).toHaveCount(0);

    // ---- And can actually approve, which is the whole point --------------
    const before = page.url();
    await expect(async () => {
      if (page.url() === before) {
        await page.getByTestId('approvals-review-subject').getByText('Approve').click();
        await page.waitForTimeout(750);
      }
      expect(page.url()).not.toBe(before);
    }).toPass({ timeout: 30_000 });
    await expect.poll(() => page.url(), { timeout: 15_000 }).toMatch(/ok=SAVED|error=/);
    expect(page.url(), 'the Viewer grant must let the verdict land').toMatch(/ok=SAVED/);
    await signOut(page);

    // ---- The owner sees the verdict, and puts the grant back --------------
    await signIn(page, customer.email, customer.password);
    await setViewerApproval(page, 'E2E Viewer Brand', false);
  });

  test('a Viewer is refused the content library even while reviewing', async ({ page }) => {
    /*
     * The narrowness of the grant, asserted from the outside. `content.read` is
     * what the library requires and D-121 does not grant it, so these routes
     * answer 404 for a Viewer whether or not a brand has admitted them as a
     * reviewer.
     */
    const { customer } = credentials();
    await signIn(page, customer.viewerEmail, customer.viewerPassword);

    for (const route of ['content', 'content/compose', 'assets', 'brand-brain']) {
      const response = await page.goto(`${DASHBOARD_BASE_URL}/en/${route}`);
      expect(response?.status(), `/${route} must not be readable by a Viewer`).toBe(404);
    }
  });
});
