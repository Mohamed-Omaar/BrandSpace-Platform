import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, signIn } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { seedPost, utcDay } from './calendar-seed';
import { useBrand } from './brand';

/**
 * PR D — THE STUDIO (audit Studio S1–S8).
 *
 *   S1  a declined draft names who declined it and why — the latest cycle only;
 *   S2  a scheduled post has "Unschedule";
 *   S3  a published post has "Results";
 *   S4  the campaign chip opens the glass listbox, and choosing files the post;
 *   S5  the reviewer chip lists "Name · Role";
 *   S6  a paid AI action names what it cost;
 *   S7  an open post's empty picture offers "Add a visual";
 *   S8  with Brand Brain off for writing, "Turn on →" leads to Settings → AI.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

/** A brand of its own in the e2e workspace (approval required), with one owner's draft. */
async function reviewedDraft(declineNote: string | null): Promise<{
  brandId: string;
  itemId: string;
}> {
  const { customer } = credentials();
  const suffix = randomUUID().slice(0, 8);
  return withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: customer.email },
      select: { id: true },
    });
    const colleague = await prisma.membership.findFirstOrThrow({
      where: {
        workspaceId: customer.workspaceId,
        status: 'ACTIVE',
        user: { email: { not: customer.email }, name: { not: null } },
      },
      select: { userId: true },
    });
    const brand = await prisma.brand.create({
      data: {
        workspaceId: customer.workspaceId,
        name: `Studio ${suffix}`,
        slug: `studio-${suffix}`,
        status: 'ACTIVE',
        defaultLocale: 'EN',
        supportedLocales: ['EN'],
      },
      select: { id: true },
    });
    await prisma.approvalPolicy.create({
      data: {
        workspaceId: customer.workspaceId,
        brandId: brand.id,
        requireApprovalBeforeScheduling: true,
      },
    });
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: customer.workspaceId,
        brandId: brand.id,
        title: `Studio post ${suffix}`,
        status: 'DRAFT',
        primaryLocale: 'EN',
        createdByUserId: owner.id,
      },
      select: { id: true },
    });
    await prisma.contentVariant.create({
      data: {
        workspaceId: customer.workspaceId,
        brandId: brand.id,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: `Words, ${suffix}.`,
        characterCount: 12,
        validationState: 'VALID',
      },
    });
    if (declineNote !== null) {
      await prisma.approval.create({
        data: {
          workspaceId: customer.workspaceId,
          brandId: brand.id,
          contentItemId: item.id,
          requestedByUserId: owner.id,
          assignedToUserId: colleague.userId,
          decidedByUserId: colleague.userId,
          decidedAt: new Date(),
          decisionNote: declineNote,
          status: 'REJECTED',
          cycle: 1,
        },
      });
    }
    return { brandId: brand.id, itemId: item.id };
  });
}

async function openOnBrand(page: Page, brandId: string, itemId: string, locale: string) {
  const { customer } = credentials();
  await useBrand(page, customer.workspaceId, brandId);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?item=${itemId}`);
  await expect(page.getByTestId('draft-editor')).toBeVisible();
}

for (const locale of ['en', 'ar'] as const) {
  test(`S1: a declined draft says who declined it and why (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the desktop run covers it');
    const note = `Too long ${randomUUID().slice(0, 4)}`;
    const declined = await reviewedDraft(note);
    const fresh = await reviewedDraft(null);
    await signIn(page, locale);

    await openOnBrand(page, declined.brandId, declined.itemId, locale);
    await expect(page.getByTestId('editor-declined')).toContainText(note);

    // A draft with no declined review shows no note.
    await openOnBrand(page, fresh.brandId, fresh.itemId, locale);
    await expect(page.getByTestId('editor-declined')).toHaveCount(0);
  });

  test(`S5: the reviewer chip lists "Name · Role" (${locale})`, async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'the desktop run covers it');
    // The Copywriter's own draft in the primary brand: the owner (all brands,
    // may approve) is among the reviewers, the Copywriter is not.
    const loaded = credentials();
    const { customer } = loaded;
    const itemId = await withPlatformPrisma(async (prisma) => {
      const copywriter = await prisma.user.findFirstOrThrow({
        where: { email: customer.copywriterEmail },
        select: { id: true },
      });
      const brandId = brandFixtures(loaded).primaryBrandId;
      const item = await prisma.contentItem.create({
        data: {
          workspaceId: customer.workspaceId,
          brandId,
          title: `Reviewers ${randomUUID().slice(0, 6)}`,
          status: 'DRAFT',
          primaryLocale: 'EN',
          createdByUserId: copywriter.id,
        },
        select: { id: true },
      });
      await prisma.contentVariant.create({
        data: {
          workspaceId: customer.workspaceId,
          brandId,
          contentItemId: item.id,
          platformKey: 'instagram',
          locale: 'EN',
          body: 'Words for the reviewers.',
          characterCount: 24,
          validationState: 'VALID',
        },
      });
      return item.id;
    });
    await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
    await page.fill('#email', customer.copywriterEmail);
    await page.fill('#password', customer.copywriterPassword);
    await page.click('[data-testid="signin-submit"]');
    await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
    await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
    await page.waitForURL(new RegExp(`/${locale}/overview$`));
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?item=${itemId}`);

    const chip = page.getByTestId('submit-reviewer');
    await expect(chip).toBeVisible();
    await chip.click();
    const list = page.getByTestId('submit-reviewer-list');
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('role', 'listbox');
    const rows = list.getByRole('option');
    expect(await rows.count()).toBeGreaterThan(1);
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
    await expect(rows.nth(1)).toContainText(' · ');
    // Choosing shows the name on the chip; Escape closes the list.
    await rows.nth(1).click();
    await expect(list).toHaveCount(0);
    await chip.click();
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
  });

  test(`S6: a paid AI edit names what it cost (${locale})`, async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'the desktop run covers it');
    const loaded = credentials();
    const { customer } = loaded;
    const brandId = brandFixtures(loaded).primaryBrandId;
    const itemId = await withPlatformPrisma(async (prisma) => {
      const owner = await prisma.user.findFirstOrThrow({
        where: { email: customer.email },
        select: { id: true },
      });
      const item = await prisma.contentItem.create({
        data: {
          workspaceId: customer.workspaceId,
          brandId,
          title: `Spend ${randomUUID().slice(0, 6)}`,
          status: 'DRAFT',
          primaryLocale: 'EN',
          createdByUserId: owner.id,
        },
        select: { id: true },
      });
      await prisma.contentVariant.create({
        data: {
          workspaceId: customer.workspaceId,
          brandId,
          contentItemId: item.id,
          platformKey: 'instagram',
          locale: 'EN',
          body: 'A long caption that a shorter version could say in fewer words, surely.',
          characterCount: 72,
          validationState: 'VALID',
        },
      });
      return item.id;
    });
    await signIn(page, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?item=${itemId}`);
    await page.locator('[data-testid="content-tool"][data-tool="shorten"]').first().click();
    await expect(page.getByTestId('studio-spent-toast')).toBeVisible({ timeout: 30_000 });
  });

  test(`S2 + S3 + S4 + S7 + S8 on posts of its own (${locale})`, async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(90_000);
    const own = await ownWorkspace(`pr-d-studio-${locale}`);
    const scheduled = await seedPost(own, `${utcDay(5)}T10:00`);
    const published = await seedPost(own, `${utcDay(-3)}T10:00`, 'PUBLISHED');
    const campaignId = await withPlatformPrisma(async (prisma) => {
      await prisma.brand.update({ where: { id: own.brandId }, data: { useBrandBrain: false } });
      const campaign = await prisma.campaign.create({
        data: {
          workspaceId: own.workspaceId,
          brandId: own.brandId,
          name: `Spring ${randomUUID().slice(0, 4)}`,
          objective: 'AWARENESS',
          status: 'ACTIVE',
          channels: ['instagram'],
        },
        select: { id: true },
      });
      return campaign.id;
    });
    await enter(page, own.slug, locale);

    // S2 — Unschedule returns the post to draft.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?item=${scheduled.itemId}`);
    await page.getByTestId('editor-unschedule').click();
    await page.waitForURL(/ok=CONTENT_UNSCHEDULED/);
    await expect(page.getByTestId('editor-unschedule')).toHaveCount(0);
    expect(
      await withPlatformPrisma((prisma) =>
        prisma.contentItem
          .findUniqueOrThrow({ where: { id: scheduled.itemId }, select: { status: true } })
          .then((row) => row.status),
      ),
    ).not.toBe('SCHEDULED');

    // S4 — the campaign chip: a glass listbox, None chosen, and choosing files it.
    const chip = page.getByTestId('content-campaign');
    await chip.click();
    const list = page.getByTestId('content-campaign-list');
    await expect(list).toBeVisible();
    await expect(page.getByTestId('content-campaign-option-none')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByTestId(`content-campaign-option-${campaignId}`).click();
    await expect
      .poll(() =>
        withPlatformPrisma((prisma) =>
          prisma.contentItem
            .findUniqueOrThrow({ where: { id: scheduled.itemId }, select: { campaignId: true } })
            .then((row) => row.campaignId),
        ),
      )
      .toBe(campaignId);
    await expect(page.getByTestId('content-campaign')).toHaveAttribute('data-value', campaignId);

    // S7 — an empty picture offers "Add a visual", which opens Design.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?item=${scheduled.itemId}`);
    await expect(page.getByTestId('content-campaign')).toHaveAttribute('data-value', campaignId);
    await page.getByTestId('editor-add-design').first().click();
    await expect(page.getByTestId('studio-tab-visual')).toHaveAttribute('aria-pressed', 'true');

    // S8 — Brand Brain off: "Turn on →" to Settings → AI.
    await page.getByTestId('studio-tab-words').click();
    await expect(page.getByTestId('variant-facts-turn-on')).toHaveAttribute(
      'href',
      `/${locale}/settings/ai`,
    );

    // S3 — a published post has "Results".
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?item=${published.itemId}`);
    await expect(page.getByTestId('editor-results')).toHaveAttribute(
      'href',
      `/${locale}/analytics`,
    );
  });
}
