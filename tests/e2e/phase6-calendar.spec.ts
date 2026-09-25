import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PHASE 6 FINAL · D-277 §32, D-290 — THE CALENDAR AS A PLANNING SURFACE.
 *
 * Filters narrow the month; the unscheduled tray offers what could go on it,
 * by drag or by a button that does the same thing; the post drawer is a side
 * sheet with the post's preview. Scheduling itself is always the existing
 * action and always confirmed — nothing here schedules on a gesture alone.
 */

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

/*
 * EVERY SUITE CLEANS UP AFTER ITSELF: the drafts made here are soft-deleted
 * afterwards, so they never crowd another suite's fixture out of the
 * calendar's picker.
 */
const created: string[] = [];
test.afterAll(async () => {
  if (created.length === 0) return;
  await withPlatformPrisma((prisma) =>
    prisma.contentItem.updateMany({
      where: { id: { in: created } },
      data: { deletedAt: new Date() },
    }),
  );
});

/** An unscheduled draft (with a variant), optionally filed under a new campaign. */
async function draft(withCampaign = false): Promise<{ itemId: string; campaignId: string | null }> {
  const loaded = credentials();
  const workspaceId = loaded.customer.workspaceId;
  const brandId = brandFixtures(loaded).primaryBrandId;
  const suffix = randomUUID().slice(0, 6);
  return withPlatformPrisma(async (prisma) => {
    const campaign = withCampaign
      ? await prisma.campaign.create({
          data: {
            workspaceId,
            brandId,
            name: `Cal ${suffix}`,
            objective: 'AWARENESS',
            status: 'ACTIVE',
          },
          select: { id: true },
        })
      : null;
    const item = await prisma.contentItem.create({
      data: {
        workspaceId,
        brandId,
        title: `Tray post ${suffix}`,
        status: 'DRAFT',
        primaryLocale: 'EN',
        ...(campaign ? { campaignId: campaign.id } : {}),
      },
      select: { id: true },
    });
    await prisma.contentVariant.create({
      data: {
        workspaceId,
        brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: `Tray words ${suffix}`,
      },
    });
    created.push(item.id);
    return { itemId: item.id, campaignId: campaign?.id ?? null };
  });
}

test.describe('D-290 · the calendar', () => {
  test('the tray offers an unscheduled post, and Schedule opens the dialog for it', async ({
    page,
  }) => {
    const { itemId } = await draft();
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/calendar`);
    const tray = page.getByTestId('calendar-tray');
    await expect(tray).toContainText('Unscheduled ·');
    await expect(page.getByTestId(`calendar-tray-${itemId}`)).toBeVisible();
    await page.getByTestId(`calendar-tray-schedule-${itemId}`).click();
    await expect(page.getByTestId('calendar-schedule-dialog')).toBeVisible();
    await expect(page.getByTestId('schedule-item')).toHaveValue(itemId);
  });

  test('dropping a tray post on a day opens the same dialog with that day filled in', async ({
    page,
  }) => {
    test.skip(test.info().project.name.includes('mobile'), 'drag is a desktop gesture');
    const { itemId } = await draft();
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/calendar`);
    // F2 — a day that has not passed: the grid's last day is never before today.
    const day = page.locator('[data-testid^="calendar-day-"]:not([data-past])').last();
    const dayKey = ((await day.getAttribute('data-testid')) ?? '').replace('calendar-day-', '');
    /*
     * THE REAL HTML5 DRAG EVENTS, carrying one DataTransfer from the tray row
     * to the day: the tray sits below the grid, and a pointer drag that has
     * to scroll the page mid-gesture is a test of the harness, not the page.
     */
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await page.getByTestId(`calendar-tray-${itemId}`).dispatchEvent('dragstart', {
      dataTransfer: transfer,
    });
    await day.dispatchEvent('dragover', { dataTransfer: transfer });
    await day.dispatchEvent('drop', { dataTransfer: transfer });
    await expect(page.getByTestId('calendar-schedule-dialog')).toBeVisible();
    await expect(page.getByTestId('schedule-item')).toHaveValue(itemId);
    await expect(page.getByTestId('schedule-date')).toHaveValue(dayKey);
  });

  test('F2: dropping a post on a day that has passed says so and opens nothing', async ({
    page,
  }) => {
    test.skip(test.info().project.name.includes('mobile'), 'drag is a desktop gesture');
    const { itemId } = await draft();
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/calendar`);
    const past = page.locator('[data-testid^="calendar-day-"][data-past="true"]');
    test.skip((await past.count()) === 0, 'the month on screen starts today');
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await page.getByTestId(`calendar-tray-${itemId}`).dispatchEvent('dragstart', {
      dataTransfer: transfer,
    });
    await past.first().dispatchEvent('dragover', { dataTransfer: transfer });
    await past.first().dispatchEvent('drop', { dataTransfer: transfer });
    await expect(page.getByTestId('calendar-past-day')).toContainText('That day has passed');
    await expect(page.getByTestId('calendar-schedule-dialog')).toHaveCount(0);
  });

  test('F2: a new post is proposed for tomorrow at 09:00, and nothing before today is offered', async ({
    page,
  }) => {
    const { itemId } = await draft();
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/calendar`);
    await page.getByTestId(`calendar-tray-schedule-${itemId}`).click();
    const date = page.getByTestId('schedule-date');
    const today = (await date.getAttribute('min')) ?? '';
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const proposed = await date.inputValue();
    expect(proposed > today, `${proposed} is after ${today}`).toBe(true);
    await expect(page.getByTestId('schedule-time')).toHaveValue('09:00');
  });

  test('the campaign filter narrows the tray to that campaign', async ({ page }) => {
    const filed = await draft(true);
    const loose = await draft(false);
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/calendar?campaign=${filed.campaignId}`);
    await expect(page.getByTestId('calendar-filter-campaign')).toHaveValue(filed.campaignId ?? '');
    await expect(page.getByTestId(`calendar-tray-${filed.itemId}`)).toBeVisible();
    await expect(page.getByTestId(`calendar-tray-${loose.itemId}`)).toHaveCount(0);
  });
});

test.describe('D-290 · the post drawer', () => {
  test('a planned draft opens in the side sheet with its preview, and can be sent for review', async ({
    page,
  }) => {
    const { itemId } = await draft();
    const loaded = credentials();
    const month = '2031-06';
    await withPlatformPrisma((prisma) =>
      prisma.calendarSlot.create({
        data: {
          workspaceId: loaded.customer.workspaceId,
          brandId: brandFixtures(loaded).primaryBrandId,
          contentItemId: itemId,
          scheduledAtUtc: new Date(`${month}-12T10:00:00Z`),
          scheduledLocalTime: `${month}-12T10:00`,
          timezone: 'UTC',
          status: 'PLANNED',
          platformKeys: ['instagram'],
        },
      }),
    );
    const title = await withPlatformPrisma(
      async (prisma) =>
        (await prisma.contentItem.findUniqueOrThrow({ where: { id: itemId } })).title,
    );

    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/calendar?month=${month}`);
    await page.getByTestId('calendar-view-agenda').click();
    await expect(page.getByTestId('calendar-view-agenda')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('calendar-agenda').getByRole('button', { name: title }).first().click();

    const sheet = page.getByTestId('calendar-slot-dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('calendar-drawer-preview')).toContainText('Tray words');
    await expect(sheet.getByTestId('calendar-slot-when')).toBeVisible();

    await sheet.getByTestId('calendar-request-approval').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'SUBMITTED');
    expect(new URL(page.url()).pathname).toBe('/en/calendar');
    expect(new URL(page.url()).searchParams.get('month')).toBe(month);
    await expect(page.getByText('The post was sent for review.')).toBeVisible();

    const pending = await withPlatformPrisma((prisma) =>
      prisma.approval.count({ where: { contentItemId: itemId, status: 'PENDING' } }),
    );
    expect(pending).toBe(1);
    // Leave the shared review queue as it was found.
    await withPlatformPrisma((prisma) =>
      prisma.approval.updateMany({
        where: { contentItemId: itemId, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      }),
    );
  });
});
