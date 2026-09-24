import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §13, D-292 — STRATEGY AS A PLAN.
 *
 * The suite writes its own ACCEPTED strategy (with evidence) and its own
 * PROPOSAL for the primary brand. THE CONTENT IS CONSTANT AND THE WRITE IS
 * IDEMPOTENT, because the desktop and mobile projects run in parallel: either
 * project's rows satisfy both, and neither retires a row the other is reading.
 * Any OTHER accepted strategy of the brand is retired first. It proves the
 * page reads as a plan from the accepted row, keeps the proposal apart, and
 * turns a week into a pre-filled campaign form and a pre-filled post — without
 * creating either.
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

// The suite's rows are known by their idempotency key, never by a tag in the
// text: what the reader sees is a plan, not a test marker (D-306).
const KEY_PREFIX = 'e2e-strategy-d292-';
const SUMMARY = 'Teach first, sell second.';
const THEME = 'Signs your cat is unwell';
const PROPOSAL_THEME = 'Questions owners ask at the clinic';

async function insight(status: 'ACCEPTED' | 'NEW', theme: string): Promise<string> {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).primaryBrandId;
  const now = new Date();
  return withPlatformPrisma(async (prisma) => {
    const row = await prisma.insight.create({
      data: {
        workspaceId,
        brandId,
        type: 'STRATEGY',
        status,
        basis: 'BRAND_CONTEXT',
        title: { en: 'Proposed strategy', ar: 'استراتيجية مقترحة' },
        body: {
          summary: { en: SUMMARY, ar: SUMMARY },
          pillars: [
            {
              name: { en: 'Education', ar: 'تعليم' },
              sharePercent: 60,
              rationale: {
                evidenceRefs: [1],
                text: { en: 'Teaching earns trust.', ar: 'التعليم يبني الثقة.' },
              },
            },
          ],
          channelMix: [
            {
              platformKey: 'instagram',
              sharePercent: 70,
              rationale: {
                evidenceRefs: [1],
                text: { en: 'Most of the audience.', ar: 'معظم الجمهور.' },
              },
            },
            {
              platformKey: 'linkedin',
              sharePercent: 30,
              rationale: { evidenceRefs: [], text: { en: 'Partners.', ar: 'الشركاء.' } },
            },
          ],
          monthlyPlan: [
            {
              weekNumber: 1,
              theme: { en: theme, ar: theme },
              postsPlanned: 3,
              rationale: { evidenceRefs: [1], text: { en: 'A season of worry.', ar: 'موسم قلق.' } },
            },
          ],
        },
        periodStart: new Date(now.getTime() - 30 * 86_400_000),
        periodEnd: now,
        ...(status === 'ACCEPTED' ? { reviewedAt: now } : {}),
        idempotencyKey: `${KEY_PREFIX}${randomUUID()}`,
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
        labelKey: 'content.pillar_unpublished',
      },
    });
    return row.id;
  });
}

test.beforeAll(async () => {
  const loaded = credentials();
  const where = {
    workspaceId: loaded.customer.workspaceId,
    brandId: brandFixtures(loaded).primaryBrandId,
    type: 'STRATEGY' as const,
  };
  const oursKey = (key: string | null) => key?.startsWith(KEY_PREFIX) === true;
  const existing = await withPlatformPrisma((prisma) =>
    prisma.insight.findMany({
      where: { ...where, status: { in: ['ACCEPTED', 'NEW', 'SEEN'] } },
      select: { id: true, status: true, idempotencyKey: true },
    }),
  );
  // Another plan on screen would not be this suite's: retire it.
  const foreign = existing
    .filter((row) => row.status === 'ACCEPTED' && !oursKey(row.idempotencyKey))
    .map((row) => row.id);
  if (foreign.length > 0) {
    await withPlatformPrisma((prisma) =>
      prisma.insight.updateMany({
        where: { id: { in: foreign } },
        data: { status: 'SUPERSEDED' },
      }),
    );
  }
  const ours = existing.filter((row) => oursKey(row.idempotencyKey));
  if (!ours.some((row) => row.status === 'ACCEPTED')) await insight('ACCEPTED', THEME);
  if (!ours.some((row) => row.status !== 'ACCEPTED')) await insight('NEW', PROPOSAL_THEME);
});

test.describe('D-292 · the strategy reads as a plan', () => {
  test('objective, pillars, channel mix, month and evidence come from the accepted strategy', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/strategy`);
    await expect(page.getByTestId('strategy-objective')).toContainText('Your strategy');
    await expect(page.getByTestId('strategy-summary')).toContainText(SUMMARY);
    await expect(page.getByTestId('strategy-pillars')).toContainText('Education');
    await expect(page.getByTestId('strategy-pillars')).toContainText('60%');
    await expect(page.getByTestId('strategy-channels')).toContainText('70%');
    await expect(page.getByTestId('strategy-week-1')).toContainText(THEME);
    // The evidence reads as a sentence, never as its stored key.
    const evidence = page.getByTestId('strategy-evidence');
    await expect(evidence).toContainText('A declared pillar had no post in this period');
    await expect(evidence).not.toContainText('content.pillar_unpublished');
    // Audience and key messages come from Brand Brain, or say they are missing.
    await expect(page.getByTestId('strategy-audience')).toBeVisible();
    await expect(page.getByTestId('strategy-messages')).toBeVisible();
  });

  test('a proposal is listed apart, marked as an AI proposal, and not part of the plan', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/strategy`);
    const suggestions = page.getByTestId('strategy-suggestions');
    await expect(suggestions).toContainText('AI proposal');
    await expect(page.getByTestId('strategy-month')).not.toContainText(PROPOSAL_THEME);
  });

  test('a week opens a pre-filled campaign form, and nothing is created', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/strategy`);
    const before = await withPlatformPrisma((prisma) =>
      prisma.campaign.count({ where: { name: THEME } }),
    );
    await page.getByTestId('strategy-week-campaign-1').click();
    await page.waitForURL(/\/en\/campaigns\/new\?/);
    await expect(page.getByTestId('campaign-name')).toHaveValue(THEME);
    await expect(page.getByTestId('campaign-brief-en')).toHaveValue('A season of worry.');
    expect(
      await withPlatformPrisma((prisma) => prisma.campaign.count({ where: { name: THEME } })),
    ).toBe(before);
  });

  test('a week opens Create Post with the theme as the brief', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/strategy`);
    await page.getByTestId('strategy-week-content-1').click();
    await page.waitForURL(/\/en\/content\/compose\?/);
    await expect(page.getByTestId('content-brief')).toHaveValue(new RegExp(THEME));
  });

  test('is clean under axe in Arabic', async ({ page }) => {
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/strategy`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('strategy-week-1')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
