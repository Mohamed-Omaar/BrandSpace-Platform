import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { withPlatformPrisma } from './platform-prisma';

/**
 * THE ASSET LIBRARY'S SECOND PAGE — the one a customer could not reach.
 *
 * THE DEFECT. `AssetLibraryService.browse` has always returned `nextCursor`,
 * and the view has always rendered a "Load more" link carrying it as `?cursor=`.
 * The page component never read that parameter back. So the link went round in
 * a circle: every press re-requested the FIRST page, the grid redrew the same
 * 48 tiles, and a workspace with more assets than fit on one page had no way to
 * reach the rest of them. Pagination was complete at both ends and disconnected
 * in the middle — which is exactly the shape of defect that no service test can
 * see, because the service was never wrong.
 *
 * SO THIS HAS TO BE A BROWSER TEST. The isolation suite already proves the
 * keyset walks every asset once with no repeats; what it cannot prove is that
 * pressing the button in the product does anything.
 *
 * THE DATASET IS SEEDED DIRECTLY, for the reason `secrets-pagination.spec.ts`
 * gives: the property under test is how the page behaves with more rows than
 * fit, and uploading forty-nine files through a picker would take minutes to
 * assert something the uploading is incidental to. Every seeded row carries
 * this run's token in its tag, the listing is filtered to that tag so no other
 * suite can perturb it, and the teardown removes exactly those rows.
 */

test.describe.configure({ mode: 'serial' });

/** The page's own limit. One more than this is what makes a second page exist. */
const PAGE_SIZE = 48;
const SEEDED = PAGE_SIZE + 3;
const RUN_TAG = `e2epage${randomUUID().replace(/-/g, '').slice(0, 10)}`;

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error(
      'The end-to-end credentials file is missing. Run `pnpm e2e:seed` first — ' +
        '`pnpm test:e2e` does it for you.',
    );
  }
}

/**
 * SIGNING IN IS NOT THE SAME AS BEING IN A WORKSPACE. The E2E customer is a
 * member of two, so the password step lands on the CHOOSER — and every later
 * `goto` bounces straight back to it until one is picked. The first version of
 * this helper stopped at "the URL is no longer /sign-in", which the chooser
 * satisfies, so the library rendered zero tiles for the most boring possible
 * reason.
 */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'), { timeout: 30_000 });
  await page.click(`[data-testid="choose-workspace-${credentials().customer.workspaceSlug}"]`);
  await page.waitForURL(/\/en\/overview$/, { timeout: 30_000 });
}

/** Names are zero-padded so the newest-first ordering is predictable. */
function assetName(index: number): string {
  return `${RUN_TAG}-${String(index).padStart(3, '0')}.png`;
}

test.beforeAll(async () => {
  const creds = credentials();
  const { primaryBrandId } = brandFixtures(creds);
  await withPlatformPrisma(async (prisma) => {
    const uploader = await prisma.user.findFirst({
      where: { email: creds.customer.email },
      select: { id: true },
    });
    await prisma.asset.createMany({
      data: Array.from({ length: SEEDED }, (_, index) => ({
        workspaceId: creds.customer.workspaceId,
        brandId: primaryBrandId,
        name: assetName(index),
        kind: 'IMAGE' as const,
        mimeType: 'image/png',
        sizeBytes: 1_024 + index,
        storageKey: `ws/${creds.customer.workspaceId}/pagination/${RUN_TAG}-${index}`,
        checksumSha256: `${RUN_TAG}-checksum-${String(index).padStart(3, '0')}`,
        tags: [RUN_TAG],
        scanStatus: 'CLEAN' as const,
        scannedAt: new Date(),
        status: 'READY' as const,
        currentVersion: 1,
        ...(uploader ? { uploadedByUserId: uploader.id } : {}),
      })),
    });
  });
});

test.afterAll(async () => {
  await withPlatformPrisma(async (prisma) => {
    await prisma.asset.deleteMany({ where: { tags: { has: RUN_TAG } } });
  });
});

test.describe('the Asset Library reaches its second page', () => {
  test('LOAD MORE SHOWS DIFFERENT ASSETS, rather than the same first page again', async ({
    page,
  }) => {
    const creds = credentials();
    await signIn(page, creds.customer.email, creds.customer.password);

    // Filtered to this run's rows only, so nothing another suite creates can
    // change what a page holds.
    /*
     * SCOPE IS EXPLICIT. Without `?scope=` the library opens on whatever brand
     * the rail cookie last selected, which would make this suite depend on the
     * order other suites ran in.
     */
    const { primaryBrandId } = brandFixtures(creds);
    await page.goto(
      `${DASHBOARD_BASE_URL}/en/assets?tag=${RUN_TAG}&sort=name&scope=${primaryBrandId}`,
    );

    const tiles = page.locator('[data-testid^="asset-tile-"]');
    await expect(tiles).toHaveCount(PAGE_SIZE);
    // Compared by TEST ID rather than rendered text: the id is the asset, and
    // two tiles could legitimately share a caption.
    const firstPage = await tiles.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-testid') ?? ''),
    );

    // THE LINK EXISTS — the view has always rendered it.
    const loadMore = page.locator('[data-testid="assets-load-more"]');
    await expect(loadMore).toBeVisible();

    await loadMore.click();
    await page.waitForURL((url) => url.searchParams.has('cursor'), { timeout: 30_000 });

    /*
     * THE ASSERTION THAT FAILS AGAINST THE DEFECT. Before the page read
     * `?cursor=`, this second view was byte-for-byte the first: 48 tiles,
     * the same 48 names, for ever.
     */
    await expect(tiles).toHaveCount(SEEDED - PAGE_SIZE);
    const secondPage = await tiles.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-testid') ?? ''),
    );
    for (const id of secondPage) expect(firstPage).not.toContain(id);
  });

  test('changing a filter returns to the first page rather than keeping a stale cursor', async ({
    page,
  }) => {
    const creds = credentials();
    await signIn(page, creds.customer.email, creds.customer.password);
    const { primaryBrandId } = brandFixtures(creds);
    await page.goto(
      `${DASHBOARD_BASE_URL}/en/assets?tag=${RUN_TAG}&sort=name&scope=${primaryBrandId}`,
    );
    await page.locator('[data-testid="assets-load-more"]').click();
    await page.waitForURL((url) => url.searchParams.has('cursor'));

    /*
     * A cursor decodes to "the row after this sort value and id". Carried on to
     * a DIFFERENT filter set it would silently skip rows the reader had never
     * seen, so the filter links deliberately drop it — this proves they do.
     */
    await page.goto(
      `${DASHBOARD_BASE_URL}/en/assets?tag=${RUN_TAG}&sort=name&scope=${primaryBrandId}&kind=IMAGE`,
    );
    expect(new URL(page.url()).searchParams.has('cursor')).toBe(false);
    await expect(page.locator('[data-testid^="asset-tile-"]')).toHaveCount(PAGE_SIZE);
  });
});
