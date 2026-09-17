import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';

/**
 * D-62 — Viewer (read-only) is READ-ONLY, end to end in a real browser.
 *
 * WHAT THIS FILE USED TO BE. It proved D-121: a per-brand switch admitted the
 * Viewer as a reviewer, and the suite walked default-denied → enabled for
 * Brand A → still denied for Brand B. D-62 supersedes that decision for the
 * MVP. The product has no Client Portal, no client hand-off workflow and no
 * external reviewer surface, so there is nothing for the grant to belong to;
 * the idea is deferred to a future External Review / Guest Approval capability
 * implemented as its own narrow actor, never by repurposing `client_viewer`.
 *
 * SO THE SUITE PROVES THE ABSENCE INSTEAD, and from the outside — through HTTP,
 * as an attacker would, not through the buttons the UI chose to render. The
 * service-level proofs live in `tests/isolation/content-approvals.test.ts`
 * (`D-62 — the Viewer is strictly read-only, end to end`); what can only be
 * shown here is that the ROUTES and the SERVER ACTIONS refuse too.
 *
 * NO FIXTURE OF ITS OWN, deliberately: a suite that proves a member can reach
 * nothing needs nothing set up for them, and the drafts this file used to
 * submit are what made it contend with `approvals.spec.ts`.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('The end-to-end credentials file is missing. Run `pnpm e2e:seed` first.');
  }
}

async function signInAsViewer(page: Page): Promise<void> {
  const { customer } = credentials();
  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
  await page.fill('#email', customer.viewerEmail);
  await page.fill('#password', customer.viewerPassword);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(/\/en\/overview$/);
}

test.describe('D-62 — a read-only Viewer has no approval surface at all', () => {
  test('every approval route answers 404, in both locales', async ({ page }) => {
    await signInAsViewer(page);

    /*
     * `/approvals` IS THE ONE THAT REGRESSED. Making D-121 reachable meant
     * gating it on membership rather than `content.read`, which handed the
     * Viewer a queue. It is back to `content.read`, so the Viewer gets the
     * same not-found any member without the permission gets — and a review
     * id in the query string changes nothing, because the refusal happens
     * before the page reads it.
     */
    for (const path of [
      'en/approvals',
      'ar/approvals',
      'en/approvals?review=00000000-0000-4000-8000-000000000000',
    ]) {
      const response = await page.goto(`${DASHBOARD_BASE_URL}/${path}`);
      expect(response?.status(), `/${path} must not be readable by a Viewer`).toBe(404);
    }
  });

  test('the content surfaces stay closed too', async ({ page }) => {
    await signInAsViewer(page);

    for (const route of ['content', 'content/compose', 'assets', 'brand-brain', 'calendar']) {
      const response = await page.goto(`${DASHBOARD_BASE_URL}/en/${route}`);
      expect(response?.status(), `/${route} must not be readable by a Viewer`).toBe(404);
    }
  });

  test('PHASE 6: connected accounts and publishing are closed to a Viewer', async ({ page }) => {
    /*
     * D-62 and D-130 in their Phase 6 form. A Viewer holds `workspace.read` and
     * nothing else, so they may not connect an account, may not publish, may
     * not cancel or retry — and may not even SEE which external accounts a
     * brand controls, which is business information the narrowest role has no
     * need for.
     *
     * The route requires `integrations.read`, so this is a real refusal rather
     * than a hidden link.
     */
    await signInAsViewer(page);

    for (const path of ['en/integrations', 'ar/integrations']) {
      const response = await page.goto(`${DASHBOARD_BASE_URL}/${path}`);
      expect(response?.status(), `/${path} must not be readable by a Viewer`).toBe(404);
    }
  });

  test('PHASE 7: analytics, strategy, the Copilot and automations are ALL closed to a Viewer', async ({
    page,
  }) => {
    /*
     * D-62 AND D-130 IN THEIR PHASE 7 FORM, and the assertion the whole phase
     * had to keep: nothing new was granted to `client_viewer`.
     *
     * A Viewer holds exactly `workspace.read`. Every Phase 7 route requires a
     * permission they do not have — `analytics.read`, `strategy.read`,
     * `copilot.use`, `automation.read` — so each is a REAL refusal shaped like a
     * genuine miss, not a hidden link. The commercial performance of a business
     * is exactly the information the narrowest role has no need for, and an AI
     * assistant that can change state is exactly the capability it must not
     * have.
     */
    await signInAsViewer(page);

    for (const route of ['analytics', 'strategy', 'copilot', 'automations']) {
      for (const locale of ['en', 'ar']) {
        const response = await page.goto(`${DASHBOARD_BASE_URL}/${locale}/${route}`);
        expect(response?.status(), `/${locale}/${route} must not be readable by a Viewer`).toBe(
          404,
        );
      }
    }
  });

  test('the navigation offers a Viewer no Phase 7 surface at all', async ({ page }) => {
    await signInAsViewer(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    for (const route of ['analytics', 'strategy', 'copilot', 'automations']) {
      await expect(page.locator(`a[href$="/en/${route}"]`), route).toHaveCount(0);
    }
  });

  test('the navigation does not offer connected accounts either', async ({ page }) => {
    await signInAsViewer(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page.locator('a[href$="/en/integrations"]')).toHaveCount(0);
  });

  test('the navigation does not offer Approvals — but the refusal is the control', async ({
    page,
  }) => {
    await signInAsViewer(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page.getByTestId('nav-approvals')).toHaveCount(0);
  });

  test('POSTING to the route hands a Viewer no approvals content either', async ({ page }) => {
    /*
     * WHAT THIS CAN AND CANNOT PROVE, stated honestly.
     *
     * A Next.js server action is a public HTTP endpoint, and CLAUDE.md forbids
     * relying on a hidden button for authorization — so the refusal has to be
     * the SERVER's. But an action can only be invoked with its generated
     * `Next-Action` id, which a test cannot forge; a plain POST to the route is
     * handled as a navigation and answers 307. So this test does not claim to
     * exercise `decideApprovalAction`; it claims the weaker thing the transport
     * actually allows: following the POST to wherever it leads hands this
     * session no approvals screen and no queue.
     *
     * THE REAL PROOF OF THE ACTION'S REFUSAL is at the service, where a Viewer
     * actor's `decide()`, `cancel()`, `reviewSubject()` and assignment are each
     * rejected — `tests/isolation/content-approvals.test.ts`, describe block
     * "D-62 — the Viewer is strictly read-only, end to end". Claiming more here
     * than the transport supports would be the kind of green test this
     * milestone has already been bitten by.
     */
    await signInAsViewer(page);
    const response = await page.request.post(`${DASHBOARD_BASE_URL}/en/approvals`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form: {
        locale: 'en',
        approvalId: '00000000-0000-4000-8000-000000000000',
        verdict: 'APPROVE',
      },
    });

    const body = await response.text();
    expect(body, 'no approvals queue may be rendered for a Viewer').not.toContain(
      'approvals-queue',
    );
    expect(body, 'no policy editor may be rendered for a Viewer').not.toContain('approvals-policy');
    expect(body, 'no review subject may be rendered for a Viewer').not.toContain(
      'approvals-review-subject',
    );
  });
});
