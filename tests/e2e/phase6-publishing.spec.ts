import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §33, D-291 — PUBLISHING: Queue, Failed, and the way
 * back after a reconnection.
 *
 * Every row this suite reads, it writes: its own post, slot, account and jobs,
 * cleaned up afterwards. Queue jobs are PENDING and scheduled a week out, so
 * the E2E worker never claims them. NO REAL PUBLISHING: the stack runs the
 * deterministic mock connectors, the OAuth consent screen is never opened (the
 * Reconnect button is asserted, not pressed), and the reconnection itself is
 * the row state the in-place reconnect writes — proven against PostgreSQL in
 * `tests/isolation/phase6-reconnect-retry.test.ts`.
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

interface Made {
  itemId: string;
  slotId: string;
  connectionId: string;
  jobId: string;
  title: string;
}
const made: Made[] = [];

/** A post with a LinkedIn version, a slot, an account and one job, all ours. */
async function fixture(input: {
  account: 'ACTIVE' | 'NEEDS_REAUTH';
  job: { status: 'PENDING' | 'FAILED'; failureClass?: 'AUTH_REVOKED' };
}): Promise<Made> {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).primaryBrandId;
  const suffix = randomUUID().slice(0, 6);
  const title = `Publishing ${suffix}`;
  const week = new Date(Date.now() + 7 * 86_400_000);
  const result = await withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.create({
      data: {
        workspaceId,
        brandId,
        title,
        status: input.job.status === 'FAILED' ? 'FAILED' : 'SCHEDULED',
        primaryLocale: 'EN',
      },
      select: { id: true },
    });
    const variant = await prisma.contentVariant.create({
      data: {
        workspaceId,
        brandId,
        contentItemId: item.id,
        platformKey: 'linkedin',
        locale: 'EN',
        body: `Words ${suffix}`,
      },
      select: { id: true },
    });
    const slot = await prisma.calendarSlot.create({
      data: {
        workspaceId,
        brandId,
        contentItemId: item.id,
        scheduledAtUtc: week,
        scheduledLocalTime: week.toISOString().slice(0, 16),
        timezone: 'UTC',
        status: input.job.status === 'FAILED' ? 'FAILED' : 'SCHEDULED',
        platformKeys: ['linkedin'],
      },
      select: { id: true },
    });
    const connection = await prisma.socialConnection.create({
      data: {
        workspaceId,
        brandId,
        provider: 'LINKEDIN',
        externalAccountId: `e2e-${suffix}`,
        displayName: `E2E LinkedIn ${suffix}`,
        targetKind: 'organization',
        status: input.account,
        connectedAt: new Date(Date.now() - 3_600_000),
      },
      select: { id: true },
    });
    const job = await prisma.publishJob.create({
      data: {
        workspaceId,
        brandId,
        calendarSlotId: slot.id,
        contentItemId: item.id,
        contentVariantId: variant.id,
        socialConnectionId: connection.id,
        provider: 'LINKEDIN',
        status: input.job.status,
        ...(input.job.failureClass
          ? { failureClass: input.job.failureClass, completedAt: new Date(Date.now() - 600_000) }
          : {}),
        idempotencyKey: `e2e-publishing-${randomUUID()}`,
        scheduledAtUtc: week,
        maxAttempts: 5,
        nextAttemptAt: week,
      },
      select: { id: true },
    });
    return {
      itemId: item.id,
      slotId: slot.id,
      connectionId: connection.id,
      jobId: job.id,
      title,
    };
  });
  made.push(result);
  return result;
}

test.afterAll(async () => {
  if (made.length === 0) return;
  await withPlatformPrisma(async (prisma) => {
    const now = new Date();
    await prisma.publishJob.updateMany({
      where: { id: { in: made.map((m) => m.jobId) }, status: { not: 'PUBLISHED' } },
      data: { status: 'CANCELLED', cancelledAt: now },
    });
    await prisma.calendarSlot.updateMany({
      where: { id: { in: made.map((m) => m.slotId) } },
      data: { status: 'CANCELLED', cancelledAt: now },
    });
    await prisma.socialConnection.updateMany({
      where: { id: { in: made.map((m) => m.connectionId) } },
      data: { status: 'REVOKED', revokedAt: now },
    });
    await prisma.contentItem.updateMany({
      where: { id: { in: made.map((m) => m.itemId) } },
      data: { deletedAt: now },
    });
  });
});

test.describe('D-291 · the queue says whether each post can go out', () => {
  test('a healthy account reads Ready; a broken one says it needs reconnecting', async ({
    page,
  }) => {
    const ready = await fixture({ account: 'ACTIVE', job: { status: 'PENDING' } });
    const broken = await fixture({ account: 'NEEDS_REAUTH', job: { status: 'PENDING' } });
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/publishing`);
    await expect(page.getByTestId(`readiness-${ready.jobId}`)).toContainText('Ready to publish');
    await expect(page.getByTestId(`readiness-${broken.jobId}`)).toContainText(
      'Account needs reconnecting',
    );
    // A text-only post is an intentional neutral tile, not a broken image.
    await expect(page.getByTestId(`publish-job-${ready.jobId}`)).toContainText(ready.title);
  });
});

test.describe('D-291 · failed on a broken account → reconnect → retry', () => {
  test('offers Reconnect first, then Retry once the same account is back', async ({ page }) => {
    const failed = await fixture({
      account: 'NEEDS_REAUTH',
      job: { status: 'FAILED', failureClass: 'AUTH_REVOKED' },
    });
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/publishing?tab=failed`);

    const row = page.getByTestId(`publish-job-${failed.jobId}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`failure-${failed.jobId}`)).not.toBeEmpty();
    // OAuth stays a human action: the button is there; it is not pressed here.
    await expect(page.getByTestId(`reconnect-${failed.jobId}`)).toBeVisible();
    await expect(page.getByTestId(`retry-reconnected-${failed.jobId}`)).toHaveCount(0);

    // The reconnection, as the in-place reconnect leaves the row.
    await withPlatformPrisma((prisma) =>
      prisma.socialConnection.update({
        where: { id: failed.connectionId },
        data: { status: 'ACTIVE', connectedAt: new Date(), lastFailureClass: null },
      }),
    );
    await page.reload();
    await expect(page.getByTestId(`reconnected-${failed.jobId}`)).toContainText(
      'Account reconnected',
    );
    await expect(page.getByTestId(`reconnect-${failed.jobId}`)).toHaveCount(0);

    await page.getByTestId(`retry-reconnected-${failed.jobId}`).click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'POST_RETRY_QUEUED');
    const audited = await withPlatformPrisma((prisma) =>
      prisma.auditEvent.findFirst({
        where: { action: 'social.post.retry_requested', resourceId: failed.jobId },
      }),
    );
    expect(JSON.stringify(audited?.after)).toContain('reconnected_account');
  });

  test('after the OAuth round trip, Connections points back at what it fixed', async ({ page }) => {
    const failed = await fixture({
      account: 'NEEDS_REAUTH',
      job: { status: 'FAILED', failureClass: 'AUTH_REVOKED' },
    });
    await withPlatformPrisma((prisma) =>
      prisma.socialConnection.update({
        where: { id: failed.connectionId },
        data: { status: 'ACTIVE', connectedAt: new Date() },
      }),
    );
    await signIn(page);
    // Where the API's callback redirect lands (D-141).
    await page.goto(`${DASHBOARD_BASE_URL}/en/integrations?social=connected`);
    const link = page.getByTestId('retry-after-reconnect');
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(/\/en\/publishing\?tab=failed$/);
    await expect(page.getByTestId(`retry-reconnected-${failed.jobId}`)).toBeVisible();
  });
});

test.describe('D-291 · Arabic and accessibility', () => {
  test('the failed tab is clean under axe in Arabic', async ({ page }) => {
    await fixture({
      account: 'NEEDS_REAUTH',
      job: { status: 'FAILED', failureClass: 'AUTH_REVOKED' },
    });
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/publishing?tab=failed`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
