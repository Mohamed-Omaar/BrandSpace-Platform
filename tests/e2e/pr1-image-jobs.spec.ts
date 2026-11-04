import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PR 1 (Images, D-597) — AN IMAGE IS A BACKGROUND JOB, AND THE PERSON MAY LEAVE.
 *
 *   - From a post's media drawer: ask for an image, leave the page at once,
 *     come back — the image is on the post (attached on the server, audited),
 *     with no Save pressed.
 *   - From the Creative Studio page: ask, leave, come back — the result is
 *     shown.
 *   - The request returns at once with a job (202), never the image.
 *
 * The provider is the deterministic development double (`seed-ai.ts`).
 */

test.describe.configure({ timeout: 180_000 });

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page): Promise<void> {
  const { customer } = credentials();
  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(/\/en\/overview$/);
  await useBrand(page, customer.workspaceId, brandFixtures(credentials()).primaryBrandId);
}

async function draftPost(): Promise<{ itemId: string; variantId: string }> {
  const loaded = credentials();
  const brandId = brandFixtures(loaded).primaryBrandId;
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: loaded.customer.workspaceId,
        brandId,
        title: `PR 1 ${randomUUID().slice(0, 6)}`,
        status: 'DRAFT',
        contentType: 'POST',
        primaryLocale: 'EN',
      },
      select: { id: true },
    });
    const variant = await prisma.contentVariant.create({
      data: {
        workspaceId: loaded.customer.workspaceId,
        brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: 'A post that wants a picture.',
        assetIds: [],
      },
      select: { id: true },
    });
    return { itemId: item.id, variantId: variant.id };
  });
}

const jobFor = (where: { contentVariantId?: string; brief?: string }) =>
  withPlatformPrisma((prisma) =>
    prisma.creativeGenerationJob.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, assetId: true, attachedAt: true },
    }),
  );

test('from a post: ask for an image, leave at once, come back — it is on the post', async ({
  page,
}) => {
  const { itemId, variantId } = await draftPost();
  await signIn(page);
  await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
  await page.getByTestId('studio-tab-visual').click();
  await page.getByTestId('content-media-instagram-add').click();
  await page.getByTestId('media-tab-generate').click();
  await page.getByTestId('media-generate-prompt').fill(`A calm spring window, ${randomUUID()}`);

  const answered = page.waitForResponse(
    (response) =>
      response.url().includes('/api/creative/generate') && response.request().method() === 'POST',
  );
  await page.getByTestId('media-generate-submit').click();
  const response = await answered;
  // The request answers at once with a job, never the image.
  expect(response.status()).toBe(202);
  const body = (await response.json()) as { jobId?: string; job?: { status?: string } };
  expect(typeof body.jobId).toBe('string');
  await expect(page.getByTestId('media-generating-leave')).toBeVisible();

  // Leave immediately: nothing is saved by the editor.
  await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);

  await expect
    .poll(async () => (await jobFor({ contentVariantId: variantId }))?.status, { timeout: 120_000 })
    .toBe('SUCCEEDED');
  const job = await jobFor({ contentVariantId: variantId });
  expect(job?.attachedAt).not.toBeNull();
  const stored = await withPlatformPrisma((prisma) =>
    prisma.contentVariant.findUniqueOrThrow({
      where: { id: variantId },
      select: { assetIds: true },
    }),
  );
  expect(stored.assetIds).toEqual([job?.assetId]);

  // Back on the post: the image is there.
  await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
  await page.getByTestId('studio-tab-visual').click();
  await expect(page.getByTestId('content-media-instagram-slide-0')).toHaveAttribute(
    'data-asset-id',
    job?.assetId ?? '',
    { timeout: 60_000 },
  );
});

test('from the Creative Studio: ask, leave, come back — the result is shown', async ({ page }) => {
  await signIn(page);
  await page.goto(`${DASHBOARD_BASE_URL}/en/creative`);
  await expect(page.getByTestId('creative-studio')).toBeVisible();
  const brief = `A warm flat white on a wooden counter, ${randomUUID()}`;
  await page.getByTestId('creative-brief').fill(brief);
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes('/api/creative/generate') && response.request().method() === 'POST',
  );
  await page.getByTestId('creative-generate').click();
  expect((await answered).status()).toBe(202);

  await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
  await expect
    .poll(async () => (await jobFor({ brief }))?.status, { timeout: 120_000 })
    .toBe('SUCCEEDED');

  await page.goto(`${DASHBOARD_BASE_URL}/en/creative`);
  await expect(page.getByTestId('creative-result-frame')).toBeVisible({ timeout: 60_000 });
});
