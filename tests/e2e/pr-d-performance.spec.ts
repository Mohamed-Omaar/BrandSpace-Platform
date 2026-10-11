import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';
import { publishedPost } from './pr-d-fixtures';
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
