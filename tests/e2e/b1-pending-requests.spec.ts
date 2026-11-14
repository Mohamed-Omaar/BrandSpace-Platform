import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Request } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * B1 (owner, 2026-11-14) — WHAT A PAGE ASKS THE SERVER FOR, OVER 30 SECONDS.
 *
 * Before B1, a Media page with one file still being checked re-rendered the
 * whole page every 2.5 s and re-downloaded every picture each time (801
 * requests a minute measured locally, 792 of them images). Now:
 *
 *   - an idle page asks for nothing;
 *   - with one file pending, it asks the small status route on a back-off
 *     (2.5, 5, 10, 15, 25 s → at most 5 in 30 s), never re-renders the page
 *     and never re-fetches a picture;
 *   - a hidden tab asks for nothing at all;
 *   - when the file is done, the page is re-read ONCE, and the asking stops.
 */

type Kind = 'pending' | 'refresh' | 'image' | 'other';
function kind(request: Request): Kind | null {
  const url = new URL(request.url());
  if (url.pathname.startsWith('/_next/static') || request.resourceType() === 'font') return null;
  if (url.pathname === '/api/pending') return 'pending';
  const headers = request.headers();
  if (headers['next-router-prefetch']) return null;
  if (headers['rsc'] === '1' || url.searchParams.has('_rsc')) return 'refresh';
  if (url.pathname.includes('/assets/file/')) return 'image';
  return 'other';
}

async function count(page: Page, ms: number): Promise<Record<Kind, number>> {
  const seen: Record<Kind, number> = { pending: 0, refresh: 0, image: 0, other: 0 };
  const listener = (request: Request) => {
    const k = kind(request);
    if (k) seen[k] += 1;
  };
  page.on('request', listener);
  await page.waitForTimeout(ms);
  page.off('request', listener);
  return seen;
}

async function mediaWith(page: Page, pending: boolean) {
  const world = await ownWorkspace(`b1-${pending ? 'pending' : 'idle'}`);
  const assetId = randomUUID();
  if (pending) {
    // A file still being checked. No processing job exists for it, so the
    // worker leaves it pending for as long as the test needs.
    await withPlatformPrisma((prisma) =>
      prisma.asset.create({
        data: {
          id: assetId,
          workspaceId: world.workspaceId,
          brandId: world.brandId,
          name: 'still-checking.png',
          kind: 'IMAGE',
          mimeType: 'image/png',
          sizeBytes: 1_024,
          storageKey: `e2e/b1/${assetId}.png`,
          checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          status: 'PROCESSING',
          scanStatus: 'PENDING',
        },
      }),
    );
  }
  await enter(page, world.slug, 'en');
  await page.goto(`${DASHBOARD_BASE_URL}/en/assets`);
  await page.waitForLoadState('networkidle');
  return { world, assetId };
}

test.describe('B1 · requests over 30 seconds', () => {
  test.skip(
    ({ isMobile }) => isMobile === true,
    'the timing is the same on a phone; once is enough',
  );

  test('an idle Media page asks for nothing', async ({ page }) => {
    test.setTimeout(120_000);
    await mediaWith(page, false);
    const seen = await count(page, 30_000);
    expect(seen).toEqual({ pending: 0, refresh: 0, image: 0, other: 0 });
  });

  test('one pending file: a few small status questions, no page re-render, no picture re-fetched; hidden, nothing; done, one re-read', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const { assetId } = await mediaWith(page, true);
    await expect(page.getByTestId(`asset-tile-${assetId}`)).toBeVisible();

    const visible = await count(page, 30_000);
    expect(visible.pending).toBeGreaterThanOrEqual(3);
    expect(visible.pending).toBeLessThanOrEqual(5);
    expect(visible.refresh).toBe(0);
    expect(visible.image).toBe(0);

    // A hidden tab: no timer runs at all.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hidden = await count(page, 30_000);
    expect(hidden).toEqual({ pending: 0, refresh: 0, image: 0, other: 0 });

    // Back in view, and the file is done: one question, then the page is
    // re-read once, and the asking stops.
    await withPlatformPrisma((prisma) =>
      prisma.asset.update({
        where: { id: assetId },
        data: { status: 'READY', scanStatus: 'CLEAN', scannedAt: new Date() },
      }),
    );
    const returned = count(page, 20_000);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const after = await returned;
    expect(after.pending).toBe(1);
    expect(after.refresh).toBe(1);
    await expect(
      page.getByTestId(`asset-tile-${assetId}`).getByTestId('asset-preview-ready'),
    ).toBeVisible();
  });

  test("the status route says nothing about another workspace's file", async ({ page }) => {
    test.setTimeout(120_000);
    // Another workspace's file, still pending.
    const elsewhere = await ownWorkspace('b1-elsewhere');
    const theirs = randomUUID();
    await withPlatformPrisma((prisma) =>
      prisma.asset.create({
        data: {
          id: theirs,
          workspaceId: elsewhere.workspaceId,
          brandId: elsewhere.brandId,
          name: 'not-yours.png',
          kind: 'IMAGE',
          mimeType: 'image/png',
          sizeBytes: 1_024,
          storageKey: `e2e/b1/${theirs}.png`,
          checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          status: 'PROCESSING',
          scanStatus: 'PENDING',
        },
      }),
    );
    const { assetId: mine } = await mediaWith(page, true);
    const answer = await page.evaluate(
      async (ids) => {
        const response = await fetch(`/api/pending?assets=${ids.join(',')}`, { cache: 'no-store' });
        return { status: response.status, body: (await response.json()) as unknown };
      },
      [mine, theirs],
    );
    // Its own pending file: still going. The other workspace's: "not going",
    // the same answer as a finished or unknown file — nothing is told.
    expect(answer).toEqual({ status: 200, body: { pending: { [mine]: true, [theirs]: false } } });
  });
});
