import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';
import { publishedPost } from './pr-d-fixtures';

/**
 * PR D — BRAND BRAIN 2–4 AND STRATEGY 5, 7, 9, 10.
 *
 *   Brand Brain 2  "Reason for the change (optional)" rides on the new version.
 *   Brand Brain 3  Tone: "Open area →" and "n waiting for review".
 *   Brand Brain 4  Rules: the same, for Do and Don't.
 *   Strategy 5     "≈ n posts a week · m a month" from the plan's own weeks.
 *   Strategy 7     "How it's going": average engagements per pillar, "Best".
 *   Strategy 9     "Open →" opens that fact's own area.
 *   Strategy 10    The AI start's busy card while the strategy is written.
 */

async function fact(own: OwnWorkspace, area: string, text: string): Promise<string> {
  return withPlatformPrisma(async (prisma) => {
    const row = await prisma.brandKnowledgeItem.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        area: area as never,
        memory: 'CANONICAL',
        origin: 'HUMAN',
        status: 'ACTIVE',
        itemKey: `${area.toLowerCase()}.pr-d-${randomUUID().slice(0, 8)}`,
        title: { en: text, ar: text },
        body: { en: text, ar: text },
        createdByUserId: own.ownerId,
        version: 1,
      },
      select: { id: true },
    });
    return row.id;
  });
}

async function waiting(own: OwnWorkspace, area: string, text: string): Promise<void> {
  await withPlatformPrisma(async (prisma) => {
    const run = randomUUID().slice(0, 8);
    const document = await prisma.brandSourceDocument.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        fileName: `notes-${run}.txt`,
        mimeType: 'text/plain',
        byteSize: 10,
        checksum: `pr-d-${run}`,
        storageKey: `ws/${own.workspaceId}/brand-brain/pr-d-${run}`,
        status: 'READY',
        idempotencyKey: `pr-d-${run}`,
      },
      select: { id: true },
    });
    await prisma.brandKnowledgeCandidate.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        sourceDocumentId: document.id,
        area: area as never,
        itemKey: `${area.toLowerCase()}.pr-d-${run}`,
        extractedTitle: { en: text, ar: text },
        extractedBody: { en: text, ar: text },
        confidenceMilli: 900,
        evidence: [{ locator: 'page 1', quote: text, method: 'keyword', keywordHits: 2 }],
        status: 'PENDING',
      },
    });
  });
}

async function acceptedStrategy(own: OwnWorkspace): Promise<void> {
  const now = new Date();
  const week = (weekNumber: number, postsPlanned: number) => ({
    weekNumber,
    theme: { en: `Week theme ${weekNumber}`, ar: `موضوع ${weekNumber}` },
    postsPlanned,
    rationale: { evidenceRefs: [], text: { en: 'Steady.', ar: 'ثابت.' } },
  });
  await withPlatformPrisma((prisma) =>
    prisma.insight.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        type: 'STRATEGY',
        status: 'ACCEPTED',
        basis: 'BRAND_CONTEXT',
        title: { en: 'Strategy', ar: 'استراتيجية' },
        body: {
          summary: { en: 'Teach first.', ar: 'التعليم أولًا.' },
          pillars: [
            {
              name: { en: 'Education', ar: 'Education' },
              sharePercent: 60,
              rationale: { evidenceRefs: [], text: { en: 'Trust.', ar: 'ثقة.' } },
            },
            {
              name: { en: 'Offers', ar: 'Offers' },
              sharePercent: 40,
              rationale: { evidenceRefs: [], text: { en: 'Sales.', ar: 'مبيعات.' } },
            },
          ],
          channelMix: [
            {
              platformKey: 'instagram',
              sharePercent: 100,
              rationale: { evidenceRefs: [], text: { en: 'Audience.', ar: 'الجمهور.' } },
            },
          ],
          monthlyPlan: [week(1, 3), week(2, 4)],
        },
        periodStart: new Date(now.getTime() - 30 * 86_400_000),
        periodEnd: now,
        reviewedAt: now,
        idempotencyKey: `pr-d-strategy-${randomUUID()}`,
      },
    }),
  );
}

for (const locale of ['en', 'ar'] as const) {
  test(`Brand Brain: a reason on the new version; Tone and Rules open their areas (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(120_000);
    const own = await ownWorkspace(`pr-d-brain-${locale}`);
    const audience = await fact(own, 'AUDIENCE', `Students nearby ${locale}`);
    await waiting(own, 'TONE_OF_VOICE', `Warm and short ${locale}`);
    await waiting(own, 'DO_DONT', `Never shout ${locale}`);
    await waiting(own, 'DO_DONT', `Say thank you ${locale}`);
    await enter(page, own.slug, locale);

    // 2. The reason box, between the words and the end date; it is stored.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain?area=AUDIENCE`);
    await expect(page.getByTestId('area-drawer')).toBeVisible();
    await page.getByTestId(`edit-item-${audience}`).click();
    const reason = page.getByTestId(`change-reason-${audience}`);
    await expect(reason).toHaveAttribute('placeholder', /.+/);
    await page
      .locator(`[data-testid="edit-item-form-${audience}"] [name="titleEn"]`)
      .fill(`Students and staff nearby ${locale}`);
    await reason.fill(`New campus opened ${locale}`);
    await page.getByTestId(`save-item-${audience}`).click();
    await expect
      .poll(() =>
        withPlatformPrisma(async (prisma) => {
          const version = await prisma.brandKnowledgeVersion.findFirst({
            where: { knowledgeItemId: audience },
            orderBy: { version: 'desc' },
            select: { changeReason: true },
          });
          return version?.changeReason ?? null;
        }),
      )
      .toBe(`New campus opened ${locale}`);

    // 3 and 4. Tone and Rules: "n waiting for review", and both open the area.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain?tab=look`);
    await expect(page.getByTestId('voice-tone-waiting')).toContainText('1');
    await expect(page.getByTestId('voice-do-waiting')).toContainText('2');
    await page.getByTestId('voice-tone-waiting').click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();
    await expect(page.locator('#tab-knowledge')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('drawer-pending')).toBeVisible();

    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain?tab=look`);
    await page.getByTestId('voice-do-open-area').click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();
    await expect(page.getByTestId('drawer-pending')).toBeVisible();
  });

  test(`Strategy: cadence, how it's going, and Open → into the fact's area (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(120_000);
    const own = await ownWorkspace(`pr-d-strat-${locale}`);
    await acceptedStrategy(own);
    const audience = await fact(own, 'AUDIENCE', `Families on weekends ${locale}`);
    await publishedPost(own, `Lesson one ${locale}`, { pillar: 'Education', engagements: 60 });
    await publishedPost(own, `Lesson two ${locale}`, { pillar: 'Education', engagements: 40 });
    await publishedPost(own, `Weekend deal ${locale}`, { pillar: 'Offers', engagements: 20 });
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/strategy`);

    // 5. Seven posts over two weeks: 3.5 a week, 7 a month.
    await expect(page.getByTestId('strategy-cadence')).toContainText('3.5');
    await expect(page.getByTestId('strategy-cadence')).toContainText('7');

    // 7. Education averages 50, Offers 20: Education first, and "Best".
    await expect(page.getByTestId('strategy-how-0')).toContainText('Education');
    await expect(page.getByTestId('strategy-how-0')).toContainText('50');
    await expect(page.getByTestId('strategy-how-1')).toContainText('Offers');
    await expect(page.getByTestId('strategy-how-1')).toContainText('20');
    await expect(page.getByTestId('strategy-how-best')).toHaveCount(1);
    await expect(page.getByTestId('strategy-how-0').getByTestId('strategy-how-best')).toHaveCount(
      1,
    );

    // 9. Open → the fact's own area, open.
    const open = page.getByTestId(`strategy-audience-open-${audience}`);
    await expect(open).toHaveAttribute('href', `/${locale}/brand-brain?area=AUDIENCE`);
    await open.click();
    await page.waitForURL(/\/brand-brain\?area=AUDIENCE/);
    await expect(page.getByTestId('area-drawer')).toBeVisible();
    await expect(page.getByTestId(`edit-item-${audience}`)).toBeVisible();
  });

  test(`Strategy: no readings, no "How it's going" (${locale})`, async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace(`pr-d-strat0-${locale}`);
    await acceptedStrategy(own);
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/strategy`);
    await expect(page.getByTestId('strategy-cadence')).toBeVisible();
    await expect(page.getByTestId('strategy-how')).toHaveCount(0);
  });

  test(`Strategy: the AI start shows its busy card while it works (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(120_000);
    const own = await ownWorkspace(`pr-d-busy-${locale}`);
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/strategy?view=next`);
    await expect(page.getByTestId('strategy-form')).toBeVisible();
    // Hold the action's request a moment, so the pending state is visible.
    await page.route(`**/${locale}/strategy**`, async (route) => {
      if (route.request().method() === 'POST') {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      await route.continue();
    });
    await page.getByTestId('strategy-objective-input').fill(`More bookings ${locale}`);
    await page.getByTestId('strategy-form').locator('button[type="submit"]').click();
    await expect(page.getByTestId('strategy-busy')).toBeVisible();
    await expect(page.getByTestId('strategy-form')).toBeHidden();
    // When the action lands (a proposal, or a refusal), the card goes.
    await expect(page.getByTestId('strategy-busy')).toHaveCount(0, { timeout: 60_000 });
  });
}
