import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { CreditLedgerService } from '@brandspace/entitlements';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * PR E (D-496, Settings 3) — "AI DRAFTS GO TO REVIEW".
 *
 *   - Settings → AI draws the prototype's third switch; saving it stores
 *     `brand.aiDraftsToReview` and audits the change.
 *   - With it on, a post the Studio's AI writes is sent for review as it is
 *     created, through "Send for review" (the existing submit path); with it
 *     off it stays a draft, as before.
 */

/** Credits and one approved fact, so the deterministic provider writes a post. */
async function readyToWrite(own: OwnWorkspace): Promise<void> {
  await withPlatformPrisma(async (prisma) => {
    await prisma.creditWallet.upsert({
      where: { workspaceId: own.workspaceId },
      create: { workspaceId: own.workspaceId },
      update: {},
    });
    await new CreditLedgerService({ prisma }).grant({
      workspaceId: own.workspaceId,
      source: 'PROMOTIONAL_GRANT',
      credits: 1_000,
      reason: 'PR E end-to-end allowance',
      idempotencyKey: `e2e-pr-e-grant:${own.workspaceId}`,
    });
    await prisma.brand.update({
      where: { id: own.brandId },
      data: { defaultLocale: 'EN', supportedLocales: ['EN', 'AR'] },
    });
    const item = await prisma.brandKnowledgeItem.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        area: 'OFFERS',
        memory: 'CANONICAL',
        origin: 'HUMAN',
        status: 'ACTIVE',
        itemKey: 'offers.current',
        title: { en: 'Cold brew offer' },
        body: { en: 'Cold brew is two for one on Fridays.' },
        version: 1,
      },
      select: { id: true },
    });
    await prisma.brandKnowledgeVersion.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        knowledgeItemId: item.id,
        version: 1,
        area: 'OFFERS',
        memory: 'CANONICAL',
        origin: 'HUMAN',
        status: 'ACTIVE',
        title: { en: 'Cold brew offer' },
        body: { en: 'Cold brew is two for one on Fridays.' },
        changeKind: 'created',
      },
    });
  });
}

/** The Studio's own request, from the signed-in page, as the composer sends it. */
async function generate(page: Page, brandId: string) {
  return page.evaluate(
    async ({ brandId, key }) => {
      const response = await fetch('/api/content/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          brandId,
          brief: 'Tell people about the Friday cold brew offer',
          locale: 'EN',
          platformKeys: ['instagram'],
          idempotencyKey: key,
        }),
      });
      return {
        status: response.status,
        body: (await response.json()) as {
          itemId?: string;
          insufficientKnowledge?: boolean;
          submittedForReview?: boolean;
        },
      };
    },
    { brandId, key: `e2e-pr-e-${randomUUID()}` },
  );
}

for (const locale of ['en', 'ar'] as const) {
  test(`Settings → AI: "AI drafts go to review" is a switch that saves (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace(`pr-e-ai-switch-${locale}`);
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/settings/ai`);
    const row = page.getByTestId(`ai-drafts-review-${own.brandId}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`ai-form-${own.brandId}`)).toContainText(
      locale === 'ar' ? 'إرسال مسودات الذكاء الاصطناعي للمراجعة' : 'AI drafts go to review',
    );
    const box = page
      .getByTestId(`ai-form-${own.brandId}`)
      .locator('input[type="checkbox"][name="aiDraftsToReview"]');
    // A brand that existed before PR E starts off (Q3).
    await expect(box).not.toBeChecked();
    await box.check({ force: true });
    await page.getByTestId(`ai-save-${own.brandId}`).click();
    await page.waitForURL(/ok=SETTINGS_SAVED/);
    const saved = await withPlatformPrisma((prisma) =>
      prisma.brand.findUniqueOrThrow({
        where: { id: own.brandId },
        select: { aiDraftsToReview: true },
      }),
    );
    expect(saved.aiDraftsToReview).toBe(true);
    const audited = await withPlatformPrisma((prisma) =>
      prisma.auditEvent.count({
        where: { workspaceId: own.workspaceId, action: 'brand.ai_drafts_to_review.changed' },
      }),
    );
    expect(audited).toBe(1);
  });
}

test('with the switch on, an AI-written post goes to review; off, it stays a draft', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
  test.setTimeout(120_000);
  const own = await ownWorkspace('pr-e-ai-review');
  await readyToWrite(own);
  await enter(page, own.slug, 'en');

  // Off (the column's default): a draft, as before.
  const off = await generate(page, own.brandId);
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect(off.body.insufficientKnowledge).toBe(false);
  expect(off.body.submittedForReview).toBe(false);

  await withPlatformPrisma((prisma) =>
    prisma.brand.update({ where: { id: own.brandId }, data: { aiDraftsToReview: true } }),
  );
  const on = await generate(page, own.brandId);
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  expect(on.body.submittedForReview).toBe(true);

  const [draft, reviewed] = await withPlatformPrisma((prisma) =>
    Promise.all([
      prisma.contentItem.findUniqueOrThrow({
        where: { id: off.body.itemId! },
        select: { status: true },
      }),
      prisma.contentItem.findUniqueOrThrow({
        where: { id: on.body.itemId! },
        select: { status: true, approvals: { select: { status: true } } },
      }),
    ]),
  );
  expect(draft.status).toBe('DRAFT');
  expect(reviewed.status).toBe('IN_REVIEW');
  expect(reviewed.approvals.map((approval) => approval.status)).toEqual(['PENDING']);
});
