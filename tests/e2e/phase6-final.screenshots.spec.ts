import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, repoRoot, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §63 step 26 — THE OWNER'S SCREENSHOT REVIEW SET.
 *
 * Seventeen screens, each at desktop (1440×900) and phone (390×844) width, in
 * English and in Arabic: 68 captures into `docs/visual-review/phase-6-final/`.
 * A capture run, not a behaviour test — it asserts only that each screen
 * rendered — registered in the `visual-review` project, so it runs only under
 * `pnpm e2e:screenshots` and never in CI (F-33).
 *
 * The data is the seeded E2E estate (throwaway `@brandspace.test` accounts).
 * It opens sheets and drawers and never submits. The one thing it may write
 * is a planned post for the calendar drawer, and only when the estate has
 * none — so the set is complete on a fresh database — removed afterwards. Motion is frozen
 * so two runs of the same screen produce the same image. JPEG, full page, so
 * the set stays reviewable without bloating the repository.
 */

const OUTPUT = path.join(repoRoot, 'docs', 'visual-review', 'phase-6-final');

const WIDTHS = [
  { key: 'desktop', width: 1440, height: 900 },
  { key: 'mobile', width: 390, height: 844 },
] as const;
const LOCALES = ['en', 'ar'] as const;

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(/\/en\/overview$/);
}

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '*,*::before,*::after{animation:none!important;transition:none!important}',
  });
  await page.waitForLoadState('networkidle');
}

interface Targets {
  readonly campaignId: string | null;
  readonly assetId: string | null;
  readonly slotMonth: string | null;
  readonly slotTitle: string | null;
}

/** The seeded records the parameterised screens open. Read, never written. */
async function targets(): Promise<Targets> {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).primaryBrandId;
  return withPlatformPrisma(async (prisma) => {
    const campaign = await prisma.campaign.findFirst({
      where: { workspaceId, brandId, deletedAt: null, status: { not: 'ARCHIVED' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const asset = await prisma.asset.findFirst({
      where: { workspaceId, brandId, status: 'READY', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const slot = await prisma.calendarSlot.findFirst({
      where: {
        workspaceId,
        brandId,
        status: { in: ['PLANNED', 'SCHEDULED'] },
        item: { deletedAt: null },
      },
      orderBy: { scheduledAtUtc: 'desc' },
      select: { scheduledAtUtc: true, item: { select: { title: true } } },
    });
    if (slot) {
      return {
        campaignId: campaign?.id ?? null,
        assetId: asset?.id ?? null,
        slotMonth: slot.scheduledAtUtc.toISOString().slice(0, 7),
        slotTitle: slot.item.title,
      };
    }
    // Nothing planned: plan one of our own, a month out, removed in cleanup().
    const when = new Date(Date.now() + 30 * 86_400_000);
    when.setUTCHours(10, 0, 0, 0);
    const title = 'Review set — planned post';
    const item = await prisma.contentItem.create({
      data: { workspaceId, brandId, title, status: 'DRAFT', primaryLocale: 'EN' },
      select: { id: true },
    });
    created.push(item.id);
    await prisma.contentVariant.create({
      data: {
        workspaceId,
        brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: 'A planned post, placed for the review set.',
      },
    });
    await prisma.calendarSlot.create({
      data: {
        workspaceId,
        brandId,
        contentItemId: item.id,
        scheduledAtUtc: when,
        scheduledLocalTime: when.toISOString().slice(0, 16),
        timezone: 'UTC',
        status: 'PLANNED',
        platformKeys: ['instagram'],
      },
    });
    return {
      campaignId: campaign?.id ?? null,
      assetId: asset?.id ?? null,
      slotMonth: when.toISOString().slice(0, 7),
      slotTitle: title,
    };
  });
}

/** Posts this run placed itself. */
const created: string[] = [];

async function cleanup(): Promise<void> {
  if (created.length === 0) return;
  await withPlatformPrisma(async (prisma) => {
    await prisma.calendarSlot.deleteMany({ where: { contentItemId: { in: created } } });
    await prisma.contentItem.updateMany({
      where: { id: { in: created } },
      data: { deletedAt: new Date() },
    });
  });
}

interface Screen {
  readonly key: string;
  /** The path to open, or null when the seeded estate has nothing to open. */
  readonly path: (t: Targets) => string | null;
  /** What to do once the page is open: open a sheet, pick a format. */
  readonly then?: (page: Page, t: Targets) => Promise<void>;
  /** An open sheet is captured at the viewport, where the reader sees it. */
  readonly overlay?: boolean;
}

const SCREENS: readonly Screen[] = [
  { key: '01-home', path: () => '/overview' },
  { key: '02-brand-brain', path: () => '/brand-brain' },
  {
    key: '03-campaign-project-room',
    path: (t) => (t.campaignId ? `/campaigns/${t.campaignId}` : null),
  },
  { key: '04-content-library', path: () => '/content' },
  { key: '05-create-feed-post', path: () => '/content/compose?mode=ai' },
  {
    key: '06-create-carousel',
    path: () => '/content/compose?mode=ai',
    then: async (page) => {
      await page.getByTestId('content-format').selectOption('CAROUSEL');
    },
  },
  {
    key: '07-create-reel',
    path: () => '/content/compose?mode=ai',
    then: async (page) => {
      await page.getByTestId('content-format').selectOption('REEL');
    },
  },
  { key: '08-asset-library', path: () => '/assets' },
  {
    key: '09-asset-detail',
    overlay: true,
    path: (t) => (t.assetId ? `/assets?asset=${t.assetId}` : null),
    then: async (page) => {
      await expect(page.getByTestId('asset-detail')).toBeVisible();
    },
  },
  { key: '10-calendar', path: (t) => `/calendar${t.slotMonth ? `?month=${t.slotMonth}` : ''}` },
  {
    key: '11-calendar-post-drawer',
    overlay: true,
    path: (t) => (t.slotMonth && t.slotTitle ? `/calendar?month=${t.slotMonth}` : null),
    then: async (page, t) => {
      await page.getByTestId('calendar-view-agenda').click();
      await page
        .getByTestId('calendar-agenda')
        .getByRole('button', { name: t.slotTitle ?? '' })
        .first()
        .click();
      await expect(page.getByTestId('calendar-slot-dialog')).toBeVisible();
    },
  },
  { key: '12-publishing', path: () => '/publishing' },
  { key: '13-analytics', path: () => '/analytics' },
  { key: '14-intelligence', path: () => '/intelligence' },
  {
    key: '15-global-copilot',
    overlay: true,
    path: () => '/overview',
    then: async (page) => {
      await page.getByTestId('topbar-copilot').click();
      await expect(page.getByTestId('copilot-drawer')).toBeVisible();
    },
  },
  {
    key: '16-notifications',
    overlay: true,
    path: () => '/overview',
    then: async (page) => {
      await page.getByTestId('topbar-notifications').click();
      await expect(page.getByTestId('notifications-feed')).toBeVisible();
    },
  },
  { key: '17-setup-wizard', path: () => '/onboarding' },
];

test.describe.configure({ timeout: 600_000 });
test.afterAll(cleanup);

test('Phase 6 final review set: 17 screens × desktop/phone × English/Arabic', async ({ page }) => {
  mkdirSync(OUTPUT, { recursive: true });
  await signIn(page);
  const found = await targets();
  const skipped: string[] = [];

  for (const size of WIDTHS) {
    await page.setViewportSize({ width: size.width, height: size.height });
    for (const locale of LOCALES) {
      for (const screen of SCREENS) {
        const target = screen.path(found);
        const name = `${screen.key}-${size.key}-${locale}`;
        if (target === null) {
          skipped.push(name);
          continue;
        }
        const response = await page.goto(`${DASHBOARD_BASE_URL}/${locale}${target}`);
        expect(response?.status(), name).toBeLessThan(400);
        await expect(page.locator('main').first(), name).toBeVisible();
        await settle(page);
        if (screen.then) await screen.then(page, found);
        await page.waitForTimeout(250);
        await page.screenshot({
          path: path.join(OUTPUT, `${name}.jpg`),
          type: 'jpeg',
          quality: 72,
          fullPage: screen.overlay !== true,
        });
      }
    }
  }
  // A screen the seeded estate cannot open is named, not silently dropped.
  expect(skipped, `screens with nothing seeded to open: ${skipped.join(', ')}`).toEqual([]);
});
