import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN_BASE_URL } from './apps';
import { signIn } from './admin-session';
import { expectNoHorizontalOverflow } from './overflow';
import { withPlatformPrisma } from './platform-prisma';

/**
 * The AI usage explorer and request inspector, through a real browser.
 *
 * Two things are asserted here that no unit or isolation test can:
 *
 *   1. THE OPERATOR ACTUALLY SEES A TRUTHFUL TOTAL. `ai-usage-explorer.test.ts`
 *      proves the service returns one; this proves the page renders it, on
 *      every page, in both writing directions, and that every seeded row is
 *      reachable by paging rather than silently capped.
 *   2. NO CUSTOMER CONTENT REACHES THE SCREEN. A sentinel string is stored in
 *      `outputPayload` — which a routing rule is allowed to persist — and the
 *      rendered HTML of both screens is checked for it. Reading a customer's
 *      generated content is a Support Mode decision with its own time box and
 *      audit trail, not a side effect of opening an operations page.
 *
 * Rows are seeded directly. The property under test is how the pages behave
 * with many records; driving thirty AI requests through a provider to get there
 * would take minutes and prove nothing extra.
 */

test.describe.configure({ mode: 'serial' });

const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

/** Enough rows that a 10-row page is neither the first nor the last of two. */
const SEEDED = 25;
const PAGE_SIZE = 10;
const TASK_KEY = 'caption.generate';
const MODEL_KEY = 'e2e-usage-model';
const RUN = `e2e-ai-${Date.now()}`;
/** Must never appear in any rendered page. */
const CONTENT_SENTINEL = 'GENERATED-CONTENT-MUST-NOT-RENDER';

let workspaceId = '';
let inspectableRequestId = '';

function listUrl(locale: 'ar' | 'en', extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams({
    workspace: workspaceId,
    size: String(PAGE_SIZE),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
  });
  return `${ADMIN_BASE_URL}/${locale}/console/ai-usage?${params.toString()}`;
}

async function expectNoBlockingA11yViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ''));
  const detail = blocking
    .map(
      (v) =>
        `  [${v.impact}] ${v.id}: ${v.help}\n${v.nodes.map((n) => `      ${n.target.join(' ')}`).join('\n')}`,
    )
    .join('\n');
  expect(blocking, `serious/critical a11y violations on ${label}:\n${detail}`).toEqual([]);
}

test.beforeAll(async () => {
  await withPlatformPrisma(async (prisma) => {
    const user = await prisma.user.create({
      data: { email: `${RUN}@example.local`, name: 'AI usage E2E', status: 'ACTIVE' },
    });
    // `workspaceId` on a Workspace row is its OWN id — the self-reference the
    // RLS policies key on, enforced by `workspace_tenant_key_matches_id`. Both
    // are set from the same value at creation because the constraint does not
    // permit a moment where they differ.
    const id = crypto.randomUUID();
    const workspace = await prisma.workspace.create({
      data: {
        id,
        workspaceId: id,
        slug: RUN.slice(0, 30),
        name: 'AI usage E2E workspace',
        ownerUserId: user.id,
        status: 'ACTIVE',
      },
    });
    workspaceId = workspace.id;

    for (let index = 0; index < SEEDED; index += 1) {
      const request = await prisma.aiRequest.create({
        data: {
          workspaceId,
          taskKey: TASK_KEY,
          idempotencyKey: `${RUN}-${index}`,
          resolvedModelKey: MODEL_KEY,
          attemptedModelKeys: [MODEL_KEY],
          status: 'SUCCEEDED',
          creditsReservedMilli: 500n,
          creditsChargedMilli: 175n,
          providerCostMicroMinor: 19_500n,
          latencyMs: 120 + index,
          deadlineAt: new Date(Date.now() + 600_000),
          // A rule IS allowed to persist output. The screens still must not
          // show it — that is the point of the sentinel.
          outputPayload: { kind: 'text', text: CONTENT_SENTINEL },
        },
      });
      await prisma.aiUsageLedger.create({
        data: {
          workspaceId,
          aiRequestId: request.id,
          taskKey: TASK_KEY,
          providerKey: 'mock',
          modelKey: MODEL_KEY,
          usageUnits: { promptTokens: 500, completionTokens: 200 },
          providerCostMicroMinor: 19_500n,
          creditsChargedMilli: 175n,
          environment: 'DEVELOPMENT',
        },
      });
      if (index === 0) inspectableRequestId = request.id;
    }
  });
});

test.afterAll(async () => {
  /*
   * The requests stay. The ledger rows behind them are APPEND-ONLY by design —
   * the platform role has no DELETE on that table at all — and a test suite is
   * not an exception to the financial record. What this run must not leave
   * behind is a NON-TERMINAL request, because the stuck-request sweep reads a
   * bounded window of those; every row here is SUCCEEDED, so the window is
   * untouched.
   */
  await withPlatformPrisma(async (prisma) => {
    const remaining = await prisma.aiRequest.count({
      where: { workspaceId, status: { in: ['PENDING', 'RESERVED', 'RUNNING'] } },
    });
    expect(remaining).toBe(0);
  });
});

test.describe('the AI usage explorer pages rather than capping silently', () => {
  test('renders one page and reports the true total', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(listUrl('en'));

    await expect(page.getByTestId('ai-request-range')).toHaveText(`Showing 1–10 of ${SEEDED}`);
    // Ten rows in the DOM, not twenty-five. This is the defect itself.
    await expect(page.locator('[data-testid^="ai-row-"]')).toHaveCount(PAGE_SIZE);
    await expect(page.getByTestId('ai-request-pagination')).toBeVisible();
  });

  test('makes every seeded record reachable by paging, exactly once', async ({ page }) => {
    await signIn(page, 'en');
    const seen: string[] = [];

    for (const pageNumber of [1, 2, 3]) {
      await page.goto(listUrl('en', { page: pageNumber }));
      const ids = await page
        .locator('[data-testid^="ai-row-"]')
        .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset['testid'] ?? ''));
      seen.push(...ids);
    }

    // No record skipped at a page boundary and none shown twice: the total
    // order the service sorts by is what makes this true. A page-size cap
    // bounds ONE REQUEST, never what an operator may see.
    expect(seen).toHaveLength(SEEDED);
    expect(new Set(seen).size).toBe(SEEDED);
  });

  test('walks first, middle and last page with the right range each time', async ({ page }) => {
    await signIn(page, 'en');

    await page.goto(listUrl('en', { page: 1 }));
    await expect(page.getByTestId('ai-request-range')).toHaveText(`Showing 1–10 of ${SEEDED}`);

    await page.goto(listUrl('en', { page: 2 }));
    await expect(page.getByTestId('ai-request-range')).toHaveText(`Showing 11–20 of ${SEEDED}`);

    await page.goto(listUrl('en', { page: 3 }));
    // A short final page, and the total still tells the truth about it.
    await expect(page.getByTestId('ai-request-range')).toHaveText(`Showing 21–25 of ${SEEDED}`);
  });

  test('clamps a page past the end instead of showing a blank screen', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(listUrl('en', { page: 99 }));

    // An operator who bookmarked a deep page and then filtered down sees the
    // last page, not something that looks like data loss.
    await expect(page.getByTestId('ai-request-range')).toHaveText(`Showing 21–25 of ${SEEDED}`);
  });

  test('shows the reservation-leak count even when it is zero', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(listUrl('en'));

    // §12 says it must stay at zero. A metric only rendered when it is broken
    // is a metric nobody trusts.
    await expect(page.getByTestId('ai-leak-count')).toBeVisible();
  });

  test('renders in Arabic without overflowing', async ({ page }) => {
    await signIn(page, 'ar');
    await page.goto(listUrl('ar'));

    await expect(page.getByTestId('ai-request-range')).toHaveText(`عرض 1–10 من ${SEEDED}`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expectNoHorizontalOverflow(page, 'AI usage (ar)');
  });

  test('has no blocking accessibility violations in either direction', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(listUrl('en'));
    await expectNoBlockingA11yViolations(page, 'AI usage (en)');

    await signIn(page, 'ar');
    await page.goto(listUrl('ar'));
    await expectNoBlockingA11yViolations(page, 'AI usage (ar)');
  });
});

test.describe('the request inspector shows accounting, never content', () => {
  test('opens a request and shows what it cost', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/ai-usage/${inspectableRequestId}`);

    await expect(page.getByTestId('ai-request-summary')).toBeVisible();
    await expect(page.getByTestId('ai-request-accounting')).toContainText('Credits charged');
    await expect(page.getByTestId('ai-request-ledger-table')).toBeVisible();
  });

  test('never renders the stored output on either screen', async ({ page }) => {
    await signIn(page, 'en');

    await page.goto(listUrl('en'));
    expect(await page.content()).not.toContain(CONTENT_SENTINEL);

    await page.goto(`${ADMIN_BASE_URL}/en/console/ai-usage/${inspectableRequestId}`);
    expect(await page.content()).not.toContain(CONTENT_SENTINEL);
  });

  test('is unreachable without a session', async ({ page }) => {
    // The earlier tests in this serial file signed in on the same context, so
    // the cookie has to go before "signed out" means anything.
    await page.context().clearCookies();
    await page.goto(`${ADMIN_BASE_URL}/en/console/ai-usage`);

    // Signed out, the console redirects to the login page rather than
    // rendering a financial record to an anonymous visitor.
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/login`);
    expect(await page.content()).not.toContain(CONTENT_SENTINEL);
  });
});
