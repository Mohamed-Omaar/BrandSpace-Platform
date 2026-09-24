import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §14, D-289 — THE CAMPAIGN PROJECT ROOM.
 *
 * One campaign, built here: a draft and a post in review (the second carries a
 * picture), and one audit event about the campaign. The room's tabs read
 * those real rows back — progress, approvals waiting, the content filter, the
 * assets the posts use, the calendar, and the activity timeline.
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

interface Room {
  campaignId: string;
  draftId: string;
  reviewId: string;
  assetId: string;
  name: string;
}

async function room(): Promise<Room> {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).primaryBrandId;
  const suffix = randomUUID().slice(0, 6);
  return withPlatformPrisma(async (prisma) => {
    const campaign = await prisma.campaign.create({
      data: {
        workspaceId,
        brandId,
        name: `Room ${suffix}`,
        objective: 'LAUNCH',
        status: 'ACTIVE',
        channels: ['instagram'],
      },
      select: { id: true },
    });
    const asset = await prisma.asset.create({
      data: {
        workspaceId,
        brandId,
        name: `room-${suffix}.png`,
        kind: 'IMAGE',
        mimeType: 'image/png',
        sizeBytes: 2_048,
        storageKey: `e2e/room/${randomUUID()}`,
        checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        status: 'READY',
        scanStatus: 'CLEAN',
      },
      select: { id: true },
    });
    const post = async (title: string, status: 'DRAFT' | 'IN_REVIEW', assetIds: string[]) => {
      const item = await prisma.contentItem.create({
        data: { workspaceId, brandId, campaignId: campaign.id, title, status, primaryLocale: 'EN' },
        select: { id: true },
      });
      await prisma.contentVariant.create({
        data: {
          workspaceId,
          brandId,
          contentItemId: item.id,
          platformKey: 'instagram',
          locale: 'EN',
          body: title,
          assetIds,
        },
      });
      return item.id;
    };
    const draftId = await post(`Room draft ${suffix}`, 'DRAFT', []);
    const reviewId = await post(`Room review ${suffix}`, 'IN_REVIEW', [asset.id]);
    await prisma.auditEvent.create({
      data: {
        workspaceId,
        actorType: 'USER',
        action: 'campaign.created',
        resourceType: 'Campaign',
        resourceId: campaign.id,
        brandId,
      },
    });
    return {
      campaignId: campaign.id,
      draftId,
      reviewId,
      assetId: asset.id,
      name: `Room ${suffix}`,
    };
  });
}

const at = (r: Room, query = '') =>
  `${DASHBOARD_BASE_URL}/en/campaigns/${r.campaignId}${query ? `?${query}` : ''}`;

test.describe('D-289 · the campaign project room', () => {
  test('overview: progress, approvals waiting and next publish from real rows', async ({
    page,
  }) => {
    const r = await room();
    await signIn(page);
    await page.goto(at(r));
    await expect(page.getByTestId('campaign-tabs')).toBeVisible();
    await expect(page.getByTestId('campaign-progress')).toContainText('0 of 2 posts published');
    await expect(page.getByTestId('campaign-waiting')).toContainText('1 posts are waiting');
    await expect(page.getByTestId('campaign-next')).toContainText('Nothing is scheduled yet');
    await expect(page.getByTestId('campaign-recent-activity')).toContainText(/./);
  });

  test('content: filter by status, and each row says what the post is', async ({ page }) => {
    const r = await room();
    await signIn(page);
    await page.goto(at(r, 'tab=content'));
    await expect(page.getByTestId(`campaign-content-${r.draftId}`)).toBeVisible();
    await expect(page.getByTestId(`campaign-content-${r.reviewId}`)).toContainText('instagram');
    await page
      .getByTestId('campaign-content-filter')
      .getByRole('link', { name: /Waiting for review|In review/ })
      .click();
    await page.waitForURL((url) => url.searchParams.get('status') === 'IN_REVIEW');
    await expect(page.getByTestId(`campaign-content-${r.reviewId}`)).toBeVisible();
    await expect(page.getByTestId(`campaign-content-${r.draftId}`)).toHaveCount(0);
    await expect(page.getByTestId('campaign-write-post')).toHaveAttribute(
      'href',
      `/en/content/compose?campaign=${r.campaignId}`,
    );
  });

  test('assets, calendar, performance and activity read the real domain', async ({ page }) => {
    const r = await room();
    await signIn(page);
    await page.goto(at(r, 'tab=assets'));
    await expect(page.getByTestId(`campaign-asset-${r.assetId}`)).toBeVisible();

    await page.goto(at(r, 'tab=calendar'));
    await expect(page.getByTestId('campaign-calendar')).toContainText(
      'Nothing on the calendar yet',
    );
    await expect(page.getByTestId('campaign-open-calendar')).toHaveAttribute(
      'href',
      `/en/calendar?campaign=${r.campaignId}`,
    );

    await page.goto(at(r, 'tab=performance'));
    await expect(page.getByTestId('campaign-what-changed')).toBeVisible();
    await expect(page.getByTestId('campaign-what-to-try')).toBeVisible();

    await page.goto(at(r, 'tab=activity'));
    await expect(page.getByTestId('campaign-activity')).not.toContainText('No activity');
  });

  test('the room is clean under axe in Arabic', async ({ page }) => {
    const r = await room();
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/campaigns/${r.campaignId}`);
    await expect(page.getByTestId('campaign-tabs')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations)).toEqual([]);
  });
});
