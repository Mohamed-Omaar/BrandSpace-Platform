import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §34-§36, D-293 — WHAT CHANGED, WHY IT MIGHT MATTER,
 * WHAT WE CAN TRY — then the numbers.
 *
 * The suite writes its own ANALYTICS_EXPLANATION for the primary brand (its
 * lines cite evidence row e1). THE CONTENT IS CONSTANT AND THE WRITE IS
 * IDEMPOTENT, so the parallel desktop and mobile projects share one row.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page, locale = 'en'): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
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

const TAG = 'e2e-d293';
const CHANGE = 'Arabic educational posts drew more saves.';
const CLAIM = 'Saves rose in the same weeks educational posts went out.';
const TRY = 'Plan two more educational carousels next month.';
let insightId = '';

test.beforeAll(async () => {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).primaryBrandId;
  insightId = await withPlatformPrisma(async (prisma) => {
    const existing = await prisma.insight.findFirst({
      where: { workspaceId, brandId, type: 'ANALYTICS_EXPLANATION', idempotencyKey: TAG },
      select: { id: true },
    });
    // The texts are what a customer would read — the tag is only the
    // idempotency key, never visible copy (D-306) — so an existing row is
    // rewritten to them too.
    const body = {
      summary: { en: 'Education carried the month.', ar: 'التعليم قاد الشهر.' },
      notableChanges: [{ evidenceRefs: [1], text: { en: CHANGE, ar: CHANGE } }],
      claims: [{ evidenceRefs: [1], text: { en: CLAIM, ar: CLAIM } }],
      recommendations: [{ evidenceRefs: [1], text: { en: TRY, ar: TRY } }],
    };
    if (existing) {
      await prisma.insight.update({
        where: { id: existing.id },
        data: { status: 'NEW', createdAt: new Date(), body },
      });
      return existing.id;
    }
    const now = new Date();
    const row = await prisma.insight.create({
      data: {
        workspaceId,
        brandId,
        type: 'ANALYTICS_EXPLANATION',
        status: 'NEW',
        basis: 'OWN_PERFORMANCE',
        title: { en: 'Why this period moved', ar: 'لماذا تحركت هذه الفترة' },
        body,
        periodStart: new Date(now.getTime() - 42 * 86_400_000),
        periodEnd: now,
        idempotencyKey: TAG,
      },
      select: { id: true },
    });
    await prisma.insightEvidence.create({
      data: {
        workspaceId,
        brandId,
        insightId: row.id,
        ordinal: 1,
        kind: 'ABSENCE',
        labelKey: 'content.top_performer',
      },
    });
    return row.id;
  });
});

test.describe('D-293 · analytics tells the story first', () => {
  test('What changed, Why and What we can try come before the metrics', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/analytics?range=90`);

    const changed = page.getByTestId('analytics-what-changed');
    await expect(changed).toContainText(CHANGE);
    await expect(page.getByTestId('analytics-why')).toContainText(CLAIM);
    // Correlation, never causation.
    await expect(page.getByTestId('analytics-why')).toContainText('not proof');
    const attempt = page.getByTestId('analytics-try-0');
    await expect(attempt).toContainText(TRY);
    // A citation in words, never the store's `e1` shorthand (D-306).
    await expect(attempt).toContainText('evidence 1');
    await expect(attempt).not.toContainText('e1');

    // The story is above the numbers, and the export is last.
    const order = await page.evaluate(() => {
      const at = (id: string) => document.querySelector(`[data-testid="${id}"]`);
      const story = at('analytics-what-changed');
      const metric = document.querySelector('[data-testid^="analytics-metric-"]');
      const exported = at('analytics-export');
      const before = (a: Element | null, b: Element | null) =>
        !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return {
        storyFirst: before(story, metric),
        exportLast: exported ? before(metric, exported) : true,
      };
    });
    expect(order.storyFirst).toBe(true);
    expect(order.exportLast).toBe(true);
  });

  test('View evidence opens the one finding, with its period, scope and the loop', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/analytics?range=90`);
    await page.getByTestId('analytics-try-0').getByRole('link').click();
    await page.waitForURL(new RegExp(`/en/intelligence\\?insight=${insightId}`));
    const card = page.getByTestId(`intelligence-${insightId}`);
    await expect(card).toContainText('Brand:');
    await expect(card).toContainText('–');
    // The evidence reads as a sentence, never as its stored key.
    await expect(card).toContainText('A top-performing post');
    await expect(page.getByTestId('intelligence-loop-steps')).toContainText(
      'Accepted learnings join Brand Brain',
    );
  });

  test('is clean under axe in Arabic', async ({ page }) => {
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/analytics?range=90`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('analytics-what-changed')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
