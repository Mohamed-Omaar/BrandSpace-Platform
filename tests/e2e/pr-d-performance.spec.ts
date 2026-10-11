import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * PR D — PERFORMANCE (audit Performance 1–6).
 *
 *   1. "Not useful" dismisses a finding, and the Insights tab stays open.
 *   2. Automatic suggestions off: the Insights tab says so instead of listing.
 *   3. A row's post title opens the post.
 *   4. A "—" that a platform does not publish says which platform.
 *   5. "Use this time" carries the best hour to the Studio's When.
 *   6. The other figures draw their own spark (covered by the seeded screen
 *      rendering without error here; the line needs readings to draw).
 */

const DAY = 86_400_000;

/**
 * One published Instagram post with its own readings — engagements, reach and
 * saves, never clicks (Instagram does not publish them) — in the test's own
 * workspace. Written as the product writes them: a channel, the post, its
 * variant and slot, the published job and the observations.
 */
async function publishedPost(own: OwnWorkspace, title: string): Promise<string> {
  return withPlatformPrisma(async (prisma) => {
    const run = Date.now().toString(36);
    const at = new Date(`${new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10)}T14:00:00Z`);
    const base = { workspaceId: own.workspaceId, brandId: own.brandId };
    const connection = await prisma.socialConnection.create({
      data: {
        ...base,
        provider: 'INSTAGRAM',
        externalAccountId: `pr-d-${run}`,
        displayName: 'pr-d',
        targetKind: 'MOCK',
        status: 'ACTIVE',
        connectedByUserId: own.ownerId,
        connectedAt: new Date(Date.now() - 30 * DAY),
      },
      select: { id: true, externalAccountId: true },
    });
    const item = await prisma.contentItem.create({
      data: {
        ...base,
        title,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'PUBLISHED',
        createdByUserId: own.ownerId,
      },
      select: { id: true },
    });
    const variant = await prisma.contentVariant.create({
      data: {
        ...base,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: title,
        characterCount: title.length,
        validationState: 'VALID',
      },
      select: { id: true },
    });
    const slot = await prisma.calendarSlot.create({
      data: {
        ...base,
        contentItemId: item.id,
        scheduledAtUtc: at,
        scheduledLocalTime: `${at.toISOString().slice(0, 10)}T14:00`,
        timezone: 'UTC',
        status: 'PUBLISHED',
        platformKeys: ['instagram'],
        createdByUserId: own.ownerId,
      },
      select: { id: true },
    });
    await prisma.publishJob.create({
      data: {
        ...base,
        calendarSlotId: slot.id,
        contentItemId: item.id,
        contentVariantId: variant.id,
        socialConnectionId: connection.id,
        provider: 'INSTAGRAM',
        status: 'PUBLISHED',
        idempotencyKey: `pr-d-${run}`,
        scheduledAtUtc: at,
        maxAttempts: 3,
        attemptCount: 1,
        completedAt: at,
        publishedAt: at,
        externalPostId: `pr-d-${run}`,
        createdByUserId: own.ownerId,
      },
    });
    const periodStart = new Date(`${at.toISOString().slice(0, 10)}T00:00:00Z`);
    for (const [metricKey, value] of [
      ['engagements', 42],
      ['reach', 900],
      ['saves', 7],
    ] as const) {
      await prisma.metricObservation.create({
        data: {
          ...base,
          socialConnectionId: connection.id,
          provider: 'INSTAGRAM',
          subjectType: 'POST',
          subjectExternalId: `pr-d-post-${run}`,
          contentItemId: item.id,
          metricKey,
          granularity: 'DAY',
          periodStart,
          periodEnd: new Date(periodStart.getTime() + DAY),
          value: BigInt(value),
          unit: 'COUNT',
          observedAt: new Date(periodStart.getTime() + DAY),
          sourceKind: 'MOCK',
          sourceVersion: 'e2e-pr-d-1',
          observationKey: createHash('sha256')
            .update([own.workspaceId, run, metricKey].join('|'))
            .digest('hex'),
        },
      });
    }
    return item.id;
  });
}

for (const locale of ['en', 'ar'] as const) {
  test(`Not useful dismisses a finding; suggestions off says so (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace(`pr-d-perf-${locale}`);
    const insightId = await withPlatformPrisma(async (prisma) => {
      const now = new Date();
      const row = await prisma.insight.create({
        data: {
          workspaceId: own.workspaceId,
          brandId: own.brandId,
          type: 'ANALYTICS_EXPLANATION',
          status: 'NEW',
          basis: 'OWN_PERFORMANCE',
          title: { en: 'Why this period moved', ar: 'لماذا تحركت هذه الفترة' },
          body: { summary: { en: 'A quiet month.', ar: 'شهر هادئ.' } },
          periodStart: new Date(now.getTime() - 28 * 86_400_000),
          periodEnd: now,
          idempotencyKey: `pr-d-perf-${own.slug}`,
        },
        select: { id: true },
      });
      return row.id;
    });
    await enter(page, own.slug, locale);

    // 1. Dismissed, back on the Insights tab, and nothing left to dismiss.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/analytics?view=insights`);
    await expect(page.getByTestId(`analytics-insight-${insightId}`)).toBeVisible();
    await page.getByTestId(`analytics-insight-dismiss-${insightId}`).click();
    await page.waitForURL(/view=insights&ok=INSIGHT_DISMISSED/);
    await expect(page.getByTestId(`analytics-insight-dismiss-${insightId}`)).toHaveCount(0);
    const status = await withPlatformPrisma((prisma) =>
      prisma.insight.findUniqueOrThrow({ where: { id: insightId }, select: { status: true } }),
    );
    expect(status.status).toBe('DISMISSED');

    // 2. Automatic suggestions off: the note, and no list.
    await withPlatformPrisma((prisma) =>
      prisma.brand.update({ where: { id: own.brandId }, data: { aiSuggestionsEnabled: false } }),
    );
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/analytics?view=insights`);
    await expect(page.getByTestId('analytics-insights-off')).toBeVisible();
    await expect(page.getByTestId(`analytics-insight-${insightId}`)).toHaveCount(0);
  });

  test(`a row opens its post, and the best time travels to the Studio (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(120_000);
    const own = await ownWorkspace(`pr-d-rows-${locale}`);
    const itemId = await publishedPost(own, `Opening week ${locale}`);
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/analytics`);

    // 3. The row's title is a link to that post.
    await expect(page.getByTestId(`analytics-post-open-${itemId}`)).toHaveAttribute(
      'href',
      `/${locale}/content/compose?item=${itemId}`,
    );

    // 4. Instagram publishes no clicks: the "—" says so, by name.
    const absent = page.getByTestId(`analytics-clicks-absent-${itemId}`);
    await expect(absent).toHaveText('—');
    await absent.focus();
    await expect(page.getByRole('tooltip')).toContainText('Instagram');
    // Saves were read, so they show as a number.
    await expect(page.getByTestId(`analytics-saves-absent-${itemId}`)).toHaveCount(0);

    // 5. "Use this time" carries the post's hour (14:00, the workspace in UTC).
    await expect(page.getByTestId('analytics-best-time-use')).toHaveAttribute(
      'href',
      `/${locale}/content/compose?time=14:00`,
    );
  });

  test(`the Studio opened with a time offers that time (${locale})`, async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(120_000);
    const own = await ownWorkspace(`pr-d-time-${locale}`);
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?mode=write&time=09:00`);
    await expect(page.getByTestId('content-composer')).toBeVisible();
    const chip = page
      .locator('[data-testid="content-channel"]:not([disabled]):not([aria-disabled="true"])')
      .first();
    if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
    await page.getByTestId('content-caption').click();
    await page.keyboard.type(`Best time ${locale} ${Date.now().toString(36)}`);
    // The draft is made, and the time rides along.
    await page.waitForURL((url) => url.searchParams.has('item'), { timeout: 30_000 });
    expect(new URL(page.url()).searchParams.get('time')).toBe('09:00');
    await page.getByTestId('editor-when').click();
    await expect(page.getByTestId('editor-when-panel')).toBeVisible();
    await expect(page.getByTestId('editor-schedule-time')).toHaveValue('09:00');
  });
}
