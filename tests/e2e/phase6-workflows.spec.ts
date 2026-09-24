import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §10, §39, D-296 — A RECURRING WORKFLOW, AND AUTOMATION
 * FOUND BY ASKING.
 *
 * The suite writes four weeks of one habit for the signed-in member on the
 * SECOND brand (Arabic Instagram posts made on Thursday and planned for
 * Sunday), sees Home name it, and hands it to the Copilot: the drawer opens
 * with the request written out and NOTHING sent. The Automations screen leads
 * with the same path. Its posts are soft-deleted afterwards; no decision is
 * recorded, so the parallel project is never affected.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).secondBrandId);
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

const KEY = 'weekly:4:instagram:ar:0';
const made: string[] = [];

/** Noon UTC on the `weekday` of the week `weeks` ago — the same local day in any zone within ±11h. */
function weeksAgo(weeks: number, weekday: number): Date {
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12);
  const today = new Date(base).getUTCDay();
  return new Date(base - ((today - weekday + 7) % 7) * 86_400_000 - weeks * 7 * 86_400_000);
}

test.beforeAll(async () => {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).secondBrandId;
  await withPlatformPrisma(async (prisma) => {
    const user = await prisma.user.findFirstOrThrow({
      where: { email: loaded.customer.email },
      select: { id: true },
    });
    // A standing decision from an earlier run would hide the suggestion.
    await prisma.memberSuggestion.deleteMany({
      where: { workspaceId, userId: user.id, brandId, key: KEY },
    });
    for (const weeks of [1, 2, 3, 4]) {
      const createdAt = weeksAgo(weeks, 4);
      const planned = new Date(createdAt.getTime() + 3 * 86_400_000);
      const item = await prisma.contentItem.create({
        data: {
          workspaceId,
          brandId,
          title: `Weekly Arabic post ${randomUUID().slice(0, 6)}`,
          status: 'SCHEDULED',
          primaryLocale: 'AR',
        },
        select: { id: true },
      });
      made.push(item.id);
      await prisma.contentVariant.create({
        data: {
          workspaceId,
          brandId,
          contentItemId: item.id,
          platformKey: 'instagram',
          locale: 'AR',
          body: 'نص',
        },
      });
      await prisma.calendarSlot.create({
        data: {
          workspaceId,
          brandId,
          contentItemId: item.id,
          scheduledAtUtc: planned,
          scheduledLocalTime: planned.toISOString().slice(0, 16),
          timezone: 'UTC',
          status: 'PLANNED',
          platformKeys: ['instagram'],
        },
      });
      await prisma.auditEvent.create({
        data: {
          workspaceId,
          actorType: 'USER',
          actorId: user.id,
          action: 'content.item.authored',
          resourceType: 'ContentItem',
          resourceId: item.id,
          brandId,
          occurredAt: createdAt,
        },
      });
    }
  });
});

test.afterAll(async () => {
  if (made.length === 0) return;
  await withPlatformPrisma(async (prisma) => {
    const now = new Date();
    await prisma.calendarSlot.updateMany({
      where: { contentItemId: { in: made }, status: { not: 'CANCELLED' } },
      data: { status: 'CANCELLED', cancelledAt: now },
    });
    await prisma.contentItem.updateMany({
      where: { id: { in: made } },
      data: { deletedAt: now },
    });
  });
});

test.describe('D-296 · a recurring workflow is offered to the Copilot, not acted on', () => {
  test('Home names the habit, and Give to Copilot fills the box without sending', async ({
    page,
  }) => {
    await signIn(page);
    const row = page.getByTestId(`home-workflow-${KEY}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Arabic');
    await expect(row).toContainText('Thursday');
    await expect(row).toContainText('Sunday');

    const link = page.getByTestId(`home-workflow-copilot-${KEY}`);
    // Without script: the full Copilot screen, with the request in the address.
    await expect(link).toHaveAttribute('href', /\/en\/copilot\?from=overview&ask=/);
    await link.click();
    const drawer = page.getByTestId('copilot-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('copilot-request')).toHaveValue(/Thursday.*Sunday/);
    // Nothing was proposed or run on the person's behalf.
    await expect(drawer.getByTestId('copilot-plan')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/en/overview');
  });

  test('Automations leads with asking the Copilot, and says what stays off', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);
    const panel = page.getByTestId('automations-discover');
    await expect(panel).toContainText('starts switched off');
    await expect(panel).toContainText('asks you before anything goes out');
    await page.getByTestId('automations-discover-copilot').click();
    const drawer = page.getByTestId('copilot-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('copilot-request')).not.toHaveValue('');
    await expect(drawer.getByTestId('copilot-plan')).toHaveCount(0);
  });
});
