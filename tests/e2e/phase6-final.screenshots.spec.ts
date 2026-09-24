import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, repoRoot, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL ACCEPTANCE · §29 — THE OWNER'S SCREENSHOT REVIEW SET.
 *
 * Twenty-six screens, each at desktop (1440×900) and phone (390×844) width, in
 * English and in Arabic: 104 captures into `docs/visual-review/phase-6-final/`.
 * A capture run, not a behaviour test — it asserts only that each screen
 * rendered — registered in the `visual-review` project, so it runs only under
 * `pnpm e2e:screenshots` and never in CI (F-33).
 *
 * The data is the seeded E2E estate (throwaway `@brandspace.test` accounts).
 * The composer states are REAL drafts, not a format picked on an empty page: a
 * feed post, a three-slide carousel and a 9:16 reel with a chosen cover, built
 * from library images whose bytes are actually stored, so every tile shows a
 * picture. The Media Library is shown at its root and inside a folder that
 * holds a subfolder and files. Everything this run writes — those drafts, the
 * folder pair, the folder's file rows and, on a fresh database, a planned post
 * for the calendar drawer — is removed afterwards. It opens sheets and drawers
 * and never submits. Motion is frozen so two runs of the same screen produce
 * the same image. JPEG, full page, so the set stays reviewable without
 * bloating the repository.
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
  readonly feedId: string | null;
  readonly carouselId: string | null;
  readonly reelId: string | null;
  readonly folderId: string | null;
}

/** The seeded records the parameterised screens open, plus this run's own. */
async function targets(): Promise<Targets> {
  const base = await seeded();
  const drafts = await composerDrafts();
  const folderId = await folderWithFiles();
  return { ...base, ...drafts, folderId };
}

type Seeded = Pick<Targets, 'campaignId' | 'assetId' | 'slotMonth' | 'slotTitle'>;

async function seeded(): Promise<Seeded> {
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

/** Library images whose bytes are stored, so a tile shows a real picture. */
async function storedImages(count: number): Promise<string[]> {
  const loaded = credentials();
  const root = process.env['BRANDSPACE_OBJECT_STORE_DIR'] ?? '';
  const rows = await withPlatformPrisma((prisma) =>
    prisma.asset.findMany({
      where: {
        workspaceId: loaded.customer.workspaceId,
        brandId: brandFixtures(loaded).primaryBrandId,
        kind: 'IMAGE',
        status: 'READY',
        scanStatus: 'CLEAN',
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, storageKey: true },
    }),
  );
  return rows
    .filter((row) => root !== '' && existsSync(path.join(root, row.storageKey)))
    .slice(0, count)
    .map((row) => row.id);
}

/**
 * A feed post, a carousel and a reel, each a real draft with real media —
 * the composer as the owner will meet it, not a blank format picker.
 */
async function composerDrafts(): Promise<Pick<Targets, 'feedId' | 'carouselId' | 'reelId'>> {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).primaryBrandId;
  const images = await storedImages(4);
  if (images.length < 4) return { feedId: null, carouselId: null, reelId: null };
  return withPlatformPrisma(async (prisma) => {
    const video = await prisma.asset.findFirst({
      where: { workspaceId, brandId, kind: 'VIDEO', status: 'READY', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const draft = async (
      contentType: 'POST' | 'CAROUSEL' | 'REEL',
      title: string,
      body: string,
      assetIds: string[],
      coverAssetId?: string,
    ): Promise<string> => {
      const item = await prisma.contentItem.create({
        data: { workspaceId, brandId, title, status: 'DRAFT', contentType, primaryLocale: 'EN' },
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
          body,
          assetIds,
          ...(coverAssetId ? { coverAssetId } : {}),
        },
      });
      return item.id;
    };
    const [a, b, c, d] = images as [string, string, string, string];
    return {
      feedId: await draft(
        'POST',
        'Morning pour-over',
        'Slow mornings start with a single-origin pour-over. What is in your cup today?',
        [a],
      ),
      carouselId: await draft(
        'CAROUSEL',
        'Three ways to brew at home',
        'Swipe for three simple ways to brew better coffee at home.',
        [b, c, d],
      ),
      reelId: video
        ? await draft(
            'REEL',
            'Behind the bar in 15 seconds',
            'Fifteen seconds behind the bar, from beans to the first pour.',
            [video.id, a],
            a,
          )
        : null,
    };
  });
}

/** Folders this run made, children first; and the file rows it put in them. */
const folders: string[] = [];
const fileRows: string[] = [];

/**
 * A folder that holds a subfolder and files, so "inside a folder" shows what
 * a folder is for. The files are new library rows over images already stored
 * (fresh ids and checksums), so no seeded asset is moved.
 */
async function folderWithFiles(): Promise<string | null> {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).primaryBrandId;
  const images = await storedImages(3);
  return withPlatformPrisma(async (prisma) => {
    const parent = await prisma.assetFolder.create({
      data: { workspaceId, brandId, name: 'Spring campaign' },
      select: { id: true },
    });
    const child = await prisma.assetFolder.create({
      data: { workspaceId, brandId, name: 'Story frames', parentFolderId: parent.id },
      select: { id: true },
    });
    folders.push(child.id, parent.id);
    const sources = await prisma.asset.findMany({
      where: { id: { in: images } },
      select: {
        name: true,
        kind: true,
        mimeType: true,
        sizeBytes: true,
        width: true,
        height: true,
        storageKey: true,
      },
    });
    for (const source of sources) {
      const row = await prisma.asset.create({
        data: {
          ...source,
          workspaceId,
          brandId,
          folderId: parent.id,
          checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          status: 'READY',
          scanStatus: 'CLEAN',
        },
        select: { id: true },
      });
      fileRows.push(row.id);
    }
    return parent.id;
  });
}

/** Posts this run placed itself. */
const created: string[] = [];

async function cleanup(): Promise<void> {
  await withPlatformPrisma(async (prisma) => {
    if (created.length > 0) {
      await prisma.calendarSlot.deleteMany({ where: { contentItemId: { in: created } } });
      await prisma.contentItem.updateMany({
        where: { id: { in: created } },
        data: { deletedAt: new Date() },
      });
    }
    if (fileRows.length > 0) await prisma.asset.deleteMany({ where: { id: { in: fileRows } } });
    for (const id of folders) await prisma.assetFolder.deleteMany({ where: { id } });
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
  { key: '03-strategy', path: () => '/strategy' },
  {
    key: '04-campaign-room',
    path: (t) => (t.campaignId ? `/campaigns/${t.campaignId}` : null),
  },
  { key: '05-content-library', path: () => '/content' },
  { key: '06-create-post-entry', path: () => '/content/compose' },
  {
    key: '07-feed-post-editor',
    path: (t) => (t.feedId ? `/content/compose?item=${t.feedId}` : null),
    then: async (page) => {
      await expect(page.getByTestId('draft-editor')).toBeVisible();
    },
  },
  {
    key: '08-carousel-editor',
    path: (t) => (t.carouselId ? `/content/compose?item=${t.carouselId}` : null),
    then: async (page) => {
      await expect(page.getByTestId('content-media-instagram-slide-2')).toBeVisible();
      // Page the preview once, so it reads "Slide 2 of 3".
      const next = page.getByTestId('preview-slide-next').first();
      if (await next.isVisible()) await next.click();
    },
  },
  {
    key: '09-reel-editor',
    path: (t) => (t.reelId ? `/content/compose?item=${t.reelId}` : null),
    then: async (page) => {
      await expect(page.getByTestId('content-media-instagram-slide-0')).toBeVisible();
    },
  },
  {
    key: '10-media-drawer',
    overlay: true,
    path: (t) => (t.feedId ? `/content/compose?item=${t.feedId}` : null),
    then: async (page) => {
      await page.getByTestId('content-media-instagram-add').click();
      await expect(page.getByTestId('media-drawer')).toBeVisible();
    },
  },
  { key: '11-media-library', path: () => '/assets' },
  {
    key: '12-media-library-folder',
    path: (t) => (t.folderId ? `/assets?folder=${t.folderId}` : null),
    then: async (page) => {
      await expect(page.getByTestId('assets-crumb-current')).toBeVisible();
    },
  },
  {
    key: '13-asset-detail',
    overlay: true,
    path: (t) => (t.assetId ? `/assets?asset=${t.assetId}` : null),
    then: async (page) => {
      await expect(page.getByTestId('asset-detail')).toBeVisible();
    },
  },
  // Desktop opens on the month; the phone opens on the Agenda (D-306).
  { key: '14-calendar', path: (t) => `/calendar${t.slotMonth ? `?month=${t.slotMonth}` : ''}` },
  {
    key: '15-calendar-post-drawer',
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
  { key: '16-publishing', path: () => '/publishing' },
  { key: '17-analytics', path: () => '/analytics' },
  { key: '18-intelligence', path: () => '/intelligence' },
  {
    key: '19-copilot',
    overlay: true,
    path: () => '/overview',
    then: async (page) => {
      await page.getByTestId('topbar-copilot').click();
      await expect(page.getByTestId('copilot-drawer')).toBeVisible();
    },
  },
  {
    key: '20-notifications',
    overlay: true,
    path: () => '/overview',
    then: async (page) => {
      await page.getByTestId('topbar-notifications').click();
      await expect(page.getByTestId('notifications-feed')).toBeVisible();
    },
  },
  { key: '21-wizard-1-brand', path: () => '/onboarding?step=brand' },
  { key: '22-wizard-2-teach', path: () => '/onboarding?step=learn' },
  { key: '23-wizard-3-review', path: () => '/onboarding?step=review' },
  { key: '24-wizard-4-socials', path: () => '/onboarding?step=connect' },
  { key: '25-wizard-5-goal', path: () => '/onboarding?step=goal' },
  { key: '26-wizard-ready', path: () => '/onboarding?step=done' },
];

test.describe.configure({ timeout: 600_000 });
test.afterAll(cleanup);

test('Phase 6 final review set: 26 screens × desktop/phone × English/Arabic', async ({ page }) => {
  // The set is replaced whole, so no capture from an earlier screen list lingers.
  mkdirSync(OUTPUT, { recursive: true });
  for (const file of readdirSync(OUTPUT)) {
    if (file.endsWith('.jpg')) rmSync(path.join(OUTPUT, file));
  }
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
