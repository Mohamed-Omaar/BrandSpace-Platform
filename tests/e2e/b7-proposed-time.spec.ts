import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';

/**
 * BATCH 7 PR C — THE PROPOSED PUBLISH TIME (B1.1–B1.4) AND THE STUDIO'S
 * "WHEN SHOULD IT GO OUT?" POPOVER.
 *
 *   - choosing a time keeps it on the post and schedules nothing (B1.1, B1.2);
 *   - scheduling is the bar's own press, at the time the post keeps (B1.2);
 *   - without real engagement data the popover draws neither "Best time
 *     automatically" nor the chips (popover item 3, hidden state);
 *   - "Approve & schedule" schedules at the proposed time, and a time that
 *     has passed approves without scheduling and says "pick a new time" —
 *     the approval is never refused for it (B1.3, the owner's rule).
 *
 * Each test builds its own brand and post.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page, brandId: string): Promise<void> {
  const { customer } = credentials();
  await useBrand(page, customer.workspaceId, brandId);
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

/** `YYYY-MM-DD`, `days` from today in UTC — far enough from midnight in any zone. */
function dayFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** A fresh brand and a one-variant post in it, written by `author`. */
async function post(input: {
  readonly requireApproval: boolean;
  readonly status: 'DRAFT' | 'IN_REVIEW';
  readonly byColleague: boolean;
  readonly proposedLocalTime?: string;
  readonly publishChoice?: 'NONE' | 'PICK' | 'AFTER_APPROVAL';
}) {
  const { customer } = credentials();
  const suffix = randomUUID().slice(0, 6);
  return withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: customer.email },
      select: { id: true },
    });
    const colleague = await prisma.membership.findFirstOrThrow({
      where: {
        workspaceId: customer.workspaceId,
        status: 'ACTIVE',
        user: { email: { not: customer.email }, name: { not: null } },
      },
      select: { userId: true },
    });
    const author = input.byColleague ? colleague.userId : owner.id;
    const brand = await prisma.brand.create({
      data: {
        workspaceId: customer.workspaceId,
        name: `When ${suffix}`,
        slug: `when-${suffix}`,
        status: 'ACTIVE',
        defaultLocale: 'EN',
        supportedLocales: ['EN'],
      },
      select: { id: true },
    });
    await prisma.approvalPolicy.create({
      data: {
        workspaceId: customer.workspaceId,
        brandId: brand.id,
        requireApprovalBeforeScheduling: input.requireApproval,
      },
    });
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: customer.workspaceId,
        brandId: brand.id,
        title: `When post ${suffix}`,
        status: input.status,
        primaryLocale: 'EN',
        createdByUserId: author,
        proposedLocalTime: input.proposedLocalTime ?? null,
        publishChoice: input.publishChoice ?? (input.proposedLocalTime ? 'PICK' : 'NONE'),
      },
      select: { id: true },
    });
    await prisma.contentVariant.create({
      data: {
        workspaceId: customer.workspaceId,
        brandId: brand.id,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: `Words for the time, ${suffix}.`,
        characterCount: 24,
        validationState: 'VALID',
      },
    });
    const approvalId =
      input.status === 'IN_REVIEW'
        ? (
            await prisma.approval.create({
              data: {
                workspaceId: customer.workspaceId,
                brandId: brand.id,
                contentItemId: item.id,
                requestedByUserId: author,
                assignedToUserId: owner.id,
                status: 'PENDING',
                cycle: 1,
              },
              select: { id: true },
            })
          ).id
        : null;
    return { brandId: brand.id, itemId: item.id, approvalId };
  });
}

async function stored(itemId: string) {
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.findUniqueOrThrow({
      where: { id: itemId },
      select: { status: true, proposedLocalTime: true, publishChoice: true },
    });
    const slots = await prisma.calendarSlot.findMany({
      where: { contentItemId: itemId, status: { not: 'CANCELLED' } },
      select: { status: true, scheduledLocalTime: true },
    });
    return { ...item, slots };
  });
}

test.describe('Batch 7 PR C · the Studio keeps a time, and scheduling is its own press', () => {
  test.describe.configure({ timeout: 120_000 });

  test('choosing a time stores it and schedules nothing; Schedule puts it on the calendar', async ({
    page,
  }) => {
    const f = await post({ requireApproval: false, status: 'DRAFT', byColleague: false });
    await signIn(page, f.brandId);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${f.itemId}`);

    await page.getByTestId('editor-when').click();
    const panel = page.getByTestId('editor-when-panel');
    await expect(panel).toBeVisible();
    // No real engagement data: one choice, no best time, no chips.
    await expect(panel.getByTestId('editor-when-mode-pick')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(panel.getByTestId('editor-when-mode-best')).toHaveCount(0);
    await expect(panel.getByTestId('editor-when-times')).toHaveCount(0);
    await expect(panel.getByTestId('editor-when-note')).toContainText('Press Schedule');

    const day = dayFromNow(3);
    await panel.getByTestId('editor-schedule-date').fill(day);
    await panel.getByTestId('editor-schedule-time').fill('10:30');
    await expect(page.getByTestId('editor-when-label')).toContainText('10:30');
    await expect.poll(async () => (await stored(f.itemId)).proposedLocalTime).toBe(`${day}T10:30`);
    expect(await stored(f.itemId)).toMatchObject({ status: 'DRAFT', slots: [] });

    // Taken off the post, then chosen again.
    await panel.getByTestId('editor-when-clear').click();
    await expect.poll(async () => (await stored(f.itemId)).proposedLocalTime).toBeNull();
    await panel.getByTestId('editor-schedule-time').fill('10:45');
    await expect.poll(async () => (await stored(f.itemId)).proposedLocalTime).toBe(`${day}T10:45`);
    await panel.getByTestId('editor-schedule-submit').click();
    await page.waitForURL(/ok=CONTENT_SCHEDULED/);
    expect(await stored(f.itemId)).toMatchObject({
      status: 'SCHEDULED',
      slots: [{ status: 'SCHEDULED', scheduledLocalTime: `${day}T10:45` }],
    });
  });

  test('a brand that needs approval keeps the time on a draft, and offers no Schedule', async ({
    page,
  }) => {
    const f = await post({ requireApproval: true, status: 'DRAFT', byColleague: false });
    await signIn(page, f.brandId);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${f.itemId}`);
    await page.getByTestId('editor-when').click();
    const panel = page.getByTestId('editor-when-panel');
    await expect(panel.getByTestId('editor-when-note')).toContainText('used when it’s approved');
    const day = dayFromNow(4);
    await panel.getByTestId('editor-schedule-date').fill(day);
    await panel.getByTestId('editor-schedule-time').fill('09:15');
    await expect.poll(async () => (await stored(f.itemId)).proposedLocalTime).toBe(`${day}T09:15`);
    await expect(page.getByTestId('editor-schedule-submit')).toHaveCount(0);
    await expect(page.getByTestId('editor-schedule')).toHaveCount(0);
    expect((await stored(f.itemId)).slots).toEqual([]);

    // Option B — "Right after approval": no time stored, the date and time hidden.
    const after = panel.getByTestId('editor-when-mode-after');
    await expect(after).toContainText('Goes out as soon as');
    await after.click();
    await expect.poll(async () => (await stored(f.itemId)).publishChoice).toBe('AFTER_APPROVAL');
    expect(await stored(f.itemId)).toMatchObject({ proposedLocalTime: null, slots: [] });
    await expect(panel.getByTestId('editor-schedule-date')).toHaveCount(0);
    await expect(page.getByTestId('editor-when-label')).toContainText('Right after approval');
  });

  test('the popover opens upward when there is no room below, and stays in the window', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'desktop geometry');
    const f = await post({
      requireApproval: true,
      status: 'DRAFT',
      byColleague: false,
      proposedLocalTime: `${dayFromNow(3)}T10:00`,
    });
    await signIn(page, f.brandId);
    const box = async () =>
      page.getByTestId('editor-when-panel').evaluate((panel) => {
        const rect = panel.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: window.innerHeight };
      });

    // Room below at 1536×864: it opens down, as the prototype draws it.
    await page.setViewportSize({ width: 1536, height: 864 });
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${f.itemId}`);
    await page.getByTestId('editor-when').click();
    const panel = page.getByTestId('editor-when-panel');
    await expect(panel).toHaveAttribute('data-opens', 'down');

    // A short window: it opens up instead, and none of it is cut off.
    await page.getByTestId('editor-when-done').click();
    await page.setViewportSize({ width: 1536, height: 640 });
    await page.getByTestId('editor-when').click();
    await expect(panel).toHaveAttribute('data-opens', 'up');
    const up = await box();
    expect(up.top).toBeGreaterThanOrEqual(0);
    expect(up.bottom).toBeLessThanOrEqual(up.height);
  });

  test('a brand without approval offers no "right after approval"', async ({ page }) => {
    const f = await post({ requireApproval: false, status: 'DRAFT', byColleague: false });
    await signIn(page, f.brandId);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${f.itemId}`);
    await page.getByTestId('editor-when').click();
    await expect(page.getByTestId('editor-when-mode-pick')).toBeVisible();
    await expect(page.getByTestId('editor-when-mode-after')).toHaveCount(0);
  });
});

test.describe('Batch 7 PR C · Approve & schedule (B1.3)', () => {
  test.describe.configure({ timeout: 120_000 });

  test('schedules the post at the time it proposes', async ({ page }) => {
    const day = dayFromNow(5);
    const f = await post({
      requireApproval: true,
      status: 'IN_REVIEW',
      byColleague: true,
      proposedLocalTime: `${day}T11:00`,
    });
    await signIn(page, f.brandId);
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals?review=${f.approvalId}`);
    const approve = page.getByTestId(`approve-${f.itemId}`);
    await expect(approve).toHaveText('Approve & schedule');
    await expect(approve).toHaveAttribute('data-schedules', 'schedule');
    await approve.click();
    await page.waitForURL(/ok=APPROVED_SCHEDULED/);
    expect(await stored(f.itemId)).toMatchObject({
      status: 'SCHEDULED',
      slots: [{ status: 'SCHEDULED', scheduledLocalTime: `${day}T11:00` }],
    });
  });

  test('"right after approval" is published by the approval of one who may schedule', async ({
    page,
  }) => {
    const f = await post({
      requireApproval: true,
      status: 'IN_REVIEW',
      byColleague: true,
      publishChoice: 'AFTER_APPROVAL',
    });
    await signIn(page, f.brandId);
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals?review=${f.approvalId}`);
    const approve = page.getByTestId(`approve-${f.itemId}`);
    await expect(approve).toHaveText('Approve & publish');
    await expect(approve).toHaveAttribute('data-schedules', 'publish');
    await approve.click();
    await page.waitForURL(/ok=APPROVED_PUBLISHING/);
    const after = await stored(f.itemId);
    expect(after.status).toBe('SCHEDULED');
    expect(after.slots).toHaveLength(1);
  });

  test('a post with no time and nothing chosen is never published by an approval', async ({
    page,
  }) => {
    const f = await post({ requireApproval: true, status: 'IN_REVIEW', byColleague: true });
    expect(await stored(f.itemId)).toMatchObject({
      publishChoice: 'NONE',
      proposedLocalTime: null,
    });
    await signIn(page, f.brandId);
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals?review=${f.approvalId}`);
    const approve = page.getByTestId(`approve-${f.itemId}`);
    // The approver may schedule, and still only "Approve" is offered.
    await expect(approve).toHaveText('Approve');
    await expect(approve).not.toHaveAttribute('data-schedules', /.+/);
    await approve.click();
    await page.waitForURL(/ok=SAVED/);
    expect(await stored(f.itemId)).toMatchObject({ status: 'APPROVED', slots: [] });
  });

  test('a time that has passed approves, does not schedule, and asks for a new time', async ({
    page,
  }) => {
    const f = await post({
      requireApproval: true,
      status: 'IN_REVIEW',
      byColleague: true,
      proposedLocalTime: `${dayFromNow(-2)}T11:00`,
    });
    await signIn(page, f.brandId);
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals?review=${f.approvalId}`);
    await page.getByTestId(`approve-${f.itemId}`).click();
    await page.waitForURL(/ok=APPROVED_PICK_NEW_TIME/);
    await expect(page.getByText('pick a new time')).toBeVisible();
    expect(await stored(f.itemId)).toMatchObject({ status: 'APPROVED', slots: [] });
  });
});
