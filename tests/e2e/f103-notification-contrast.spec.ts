import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { enter, ownWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * F-103 (FINAL REVIEW) — AN UNREAD NOTIFICATION'S TIME LINE MEETS WCAG 2.2 AA.
 *
 * `phase6-states.spec.ts:48` failed axe `color-contrast` only when an unread
 * notification happened to be in the feed (4.29:1 at phone width), so it
 * depended on the data. Here the unread row is always there: the workspace's
 * owner gets one unread and one read notification, and the open feed passes
 * axe's colour-contrast rule at phone and desktop widths, in en and ar.
 *
 * FINAL WALK — AND THE POPOVER IS FULLY OPAQUE. Home's "Performance · last 28
 * days" showed through an unread row of the 94% glass; the card is now solid
 * white with no backdrop filter, asserted at both widths.
 */

const SIZES = [
  { width: 375, height: 812 },
  { width: 1536, height: 864 },
] as const;

for (const locale of ['en', 'ar'] as const) {
  test(`an unread notification's time line passes colour contrast (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; this test sets both widths itself');
    test.setTimeout(120_000);
    const own = await ownWorkspace(`f103-${locale}`);
    await withPlatformPrisma(async (prisma) => {
      for (const readAt of [null, new Date()]) {
        await prisma.notification.create({
          data: {
            workspaceId: own.workspaceId,
            userId: own.ownerId,
            brandId: own.brandId,
            templateKey: 'approval.requested',
            payload: { itemTitle: 'Morning pour-over', brandName: 'Café', actorName: 'Reema' },
            readAt,
            idempotencyKey: `f103-${own.workspaceId}-${readAt === null ? 'unread' : 'read'}`,
          },
        });
      }
    });
    await enter(page, own.slug, locale);

    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.reload();
      await page.getByTestId('topbar-notifications').click();
      const feed = page.getByTestId('notifications-feed');
      await expect(feed).toBeVisible();
      await expect(feed.locator('.bsp-ntf-row[data-unread]')).toHaveCount(1);
      // Let the entrance transition settle before measuring colours.
      await page.waitForTimeout(400);
      // Final walk (owner, review of #83): the popover is fully opaque, so the
      // page behind it never shows through its rows.
      expect(
        await feed.evaluate((element) => {
          const style = getComputedStyle(element);
          return { background: style.backgroundColor, backdrop: style.backdropFilter };
        }),
        `${size.width}px`,
      ).toEqual({ background: 'rgb(255, 255, 255)', backdrop: 'none' });
      const results = await new AxeBuilder({ page })
        .include('[data-testid="notifications-feed"]')
        .withRules(['color-contrast'])
        .analyze();
      expect(
        results.violations.map((violation) => violation.id),
        `${size.width}px`,
      ).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(feed).toBeHidden();
    }
  });
}
