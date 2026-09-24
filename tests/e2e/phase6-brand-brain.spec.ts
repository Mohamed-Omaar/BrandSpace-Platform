import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §12, §36, D-294 — A BRAND BRAIN THAT SAYS WHAT IT KNOWS.
 *
 * The brand by name and what BrandSpace understands about it, counted; the
 * four layers; each value's provenance; a measured learning with its evidence
 * and its computed confidence; and "Ask about this brand" opening the ONE
 * Copilot over this screen. The suite writes its own knowledge value and its
 * own learning, and retires both afterwards — on the SECOND brand, because
 * `brand-brain.spec.ts` measures the primary brand's item count by difference
 * and must not see this suite's rows appear beside its own.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page, locale = 'en'): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).secondBrandId);
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

const RUN = randomUUID().slice(0, 6);
let itemId = '';
let candidateId = '';
let insightId = '';
let authorName = '';

test.beforeAll(async () => {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).secondBrandId;
  await withPlatformPrisma(async (prisma) => {
    const author = await prisma.user.findFirstOrThrow({
      where: { email: loaded.customer.email },
      select: { id: true, name: true, email: true },
    });
    authorName = author.name?.trim() || author.email;
    itemId = (
      await prisma.brandKnowledgeItem.create({
        data: {
          workspaceId,
          brandId,
          area: 'IDENTITY',
          memory: 'CANONICAL',
          origin: 'HUMAN',
          status: 'ACTIVE',
          itemKey: `identity.e2e-${RUN}`,
          title: { en: `Provenance fact ${RUN}`, ar: `معلومة ${RUN}` },
          body: { en: 'We answer every question within a day.', ar: 'نرد على كل سؤال خلال يوم.' },
          createdByUserId: author.id,
        },
        select: { id: true },
      })
    ).id;
    const now = new Date();
    // A measured learning always names the finding it came from
    // (`brand_knowledge_candidate_source_is_present`).
    insightId = (
      await prisma.insight.create({
        data: {
          workspaceId,
          brandId,
          type: 'ANOMALY',
          status: 'SEEN',
          basis: 'OWN_PERFORMANCE',
          title: { en: `Saves spiked ${RUN}`, ar: `ارتفعت الحفظات ${RUN}` },
          body: {},
          periodStart: new Date(now.getTime() - 42 * 86_400_000),
          periodEnd: now,
        },
        select: { id: true },
      })
    ).id;
    candidateId = (
      await prisma.brandKnowledgeCandidate.create({
        data: {
          workspaceId,
          brandId,
          sourceKind: 'ANALYTICS',
          insightId,
          area: 'LEARNINGS',
          itemKey: `learning.e2e-${RUN}`,
          extractedTitle: {
            en: `Educational posts earn saves ${RUN}`,
            ar: `المنشورات التعليمية ${RUN}`,
          },
          extractedBody: {
            en: 'Saves rise when a post teaches.',
            ar: 'تزيد الحفظات عندما يعلّم المنشور.',
          },
          confidenceMilli: 720,
          evidence: {
            inferenceVersion: 'e2e-1',
            metricKey: 'engagements',
            observedValue: '180',
            baselineValue: '120',
            deviationMilli: 500,
            periodStart: new Date(now.getTime() - 42 * 86_400_000).toISOString(),
            periodEnd: now.toISOString(),
            baselineStart: new Date(now.getTime() - 84 * 86_400_000).toISOString(),
            baselineEnd: new Date(now.getTime() - 42 * 86_400_000).toISOString(),
          },
        },
        select: { id: true },
      })
    ).id;
  });
});

test.afterAll(async () => {
  await withPlatformPrisma(async (prisma) => {
    if (itemId) {
      await prisma.brandKnowledgeItem.updateMany({
        where: { id: itemId },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });
    }
    if (candidateId) {
      await prisma.brandKnowledgeCandidate.updateMany({
        where: { id: candidateId },
        data: { status: 'SUPERSEDED' },
      });
    }
    if (insightId) {
      await prisma.insight.updateMany({
        where: { id: insightId },
        data: { status: 'SUPERSEDED' },
      });
    }
  });
});

test.describe('D-294 · the Brand Brain says what it knows', () => {
  test('names the brand and counts its knowledge, never scores it', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain`);
    const loaded = credentials();
    await expect(page.getByTestId('brand-brain-name')).toContainText(
      brandFixtures(loaded).secondBrandName,
    );
    await expect(page.getByTestId('brand-brain-understands')).toContainText(
      /approved facts across \d+ of \d+ areas/,
    );
    for (const layer of ['CANONICAL', 'STRATEGY', 'CONTENT', 'LEARNING']) {
      await expect(page.getByTestId(`brand-brain-layer-${layer}`)).toBeVisible();
    }
    // A learning waiting on a person is said, and is not counted as knowledge.
    await expect(page.getByTestId('brand-brain-layer-LEARNING')).toContainText(
      'waiting for your review',
    );
  });

  test('each value says when, by whom and from what it came', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain`);
    await page.getByTestId('area-card-IDENTITY').click();
    const provenance = page.getByTestId(`bb-provenance-${itemId}`);
    await expect(provenance).toContainText('Updated');
    await expect(provenance).toContainText(`by ${authorName}`);
  });

  test('a measured learning shows its evidence and its computed confidence', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain`);
    const card = page.getByTestId(`intel-${candidateId}`);
    await expect(card).toContainText('From measured performance');
    await expect(page.getByTestId(`intel-evidence-${candidateId}`)).not.toBeEmpty();
    await expect(page.getByTestId(`intel-confidence-${candidateId}`)).toContainText('72%');
    await expect(card).toContainText('may influence future strategy and content suggestions');
  });

  test('"Ask about this brand" opens the one Copilot over this screen', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain`);
    await page.getByTestId('brand-brain-ask').click();
    await expect(page.getByTestId('copilot-drawer')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/en/brand-brain');
  });

  test('is clean under axe in Arabic', async ({ page }) => {
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/brand-brain`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('brand-brain-layers')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
