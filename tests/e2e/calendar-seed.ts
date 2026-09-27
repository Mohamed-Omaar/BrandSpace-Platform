import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import type { OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * §8.2 (Phase 2B-2b item 10) — A PLANNED POST IN A WORKSPACE OF ITS OWN, for
 * the drag specs. The workspace's zone is UTC (`ownWorkspace`), so "today" and
 * every instant below are known exactly; nobody else's posts share its days.
 * Seeded through the platform client; every assertion is made through the
 * screen, and the server's answer is read back from the database.
 */

export interface SeededPost {
  readonly itemId: string;
  readonly slotId: string;
  readonly title: string;
}

/** `YYYY-MM-DD`, `offset` days from today in UTC. */
export function utcDay(offset = 0): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset))
    .toISOString()
    .slice(0, 10);
}

/** Next month in UTC, as `YYYY-MM` and a day key maker. */
export function nextUtcMonth(): { month: string; day: (d: number) => string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const month = first.toISOString().slice(0, 7);
  return { month, day: (d) => `${month}-${String(d).padStart(2, '0')}` };
}

/** A post planned at `localTime` (`YYYY-MM-DDTHH:mm`, UTC), SCHEDULED unless told otherwise. */
export async function seedPost(
  workspace: OwnWorkspace,
  localTime: string,
  status: 'SCHEDULED' | 'PUBLISHED' = 'SCHEDULED',
): Promise<SeededPost> {
  const title = `Drag post ${randomUUID().slice(0, 6)}`;
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: workspace.workspaceId,
        brandId: workspace.brandId,
        title,
        status,
        primaryLocale: 'EN',
      },
      select: { id: true },
    });
    await prisma.contentVariant.create({
      data: {
        workspaceId: workspace.workspaceId,
        brandId: workspace.brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: `${title} words`,
      },
    });
    const slot = await prisma.calendarSlot.create({
      data: {
        workspaceId: workspace.workspaceId,
        brandId: workspace.brandId,
        contentItemId: item.id,
        scheduledAtUtc: new Date(`${localTime}:00Z`),
        scheduledLocalTime: localTime,
        timezone: 'UTC',
        status,
        platformKeys: ['instagram'],
        createdByUserId: workspace.ownerId,
      },
      select: { id: true },
    });
    return { itemId: item.id, slotId: slot.id, title };
  });
}

/** Where the server says the slot is, and how many moves it has audited. */
export async function slotState(
  slotId: string,
): Promise<{ localTime: string; utc: string; moves: number }> {
  return withPlatformPrisma(async (prisma) => {
    const slot = await prisma.calendarSlot.findUniqueOrThrow({
      where: { id: slotId },
      select: { scheduledLocalTime: true, scheduledAtUtc: true },
    });
    const moves = await prisma.auditEvent.count({
      where: { action: 'content.rescheduled', resourceId: slotId },
    });
    return {
      localTime: slot.scheduledLocalTime,
      utc: slot.scheduledAtUtc.toISOString(),
      moves,
    };
  });
}

/** Moves the slot behind the page's back — "somebody else moved it since". */
export async function moveBehindTheBack(slotId: string, localTime: string): Promise<void> {
  await withPlatformPrisma((prisma) =>
    prisma.calendarSlot.update({
      where: { id: slotId },
      data: { scheduledLocalTime: localTime, scheduledAtUtc: new Date(`${localTime}:00Z`) },
    }),
  );
}

/** "Wed 21" — the words the drag label and the toast use, in English. */
export function dayWords(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00Z`);
  const weekday = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }).format(date);
  return `${weekday} ${Number(dayKey.slice(8))}`;
}

export async function openCalendar(page: Page, month: string): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/en/calendar?month=${month}`);
  // Hydrated, with the drag armed: a gesture before this would do nothing.
  await expect(page.locator('[data-testid="calendar-page"][data-drag-ready]')).toBeVisible();
}
