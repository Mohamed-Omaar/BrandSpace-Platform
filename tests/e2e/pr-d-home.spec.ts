import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { enter, ownWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';
import { dailyEngagements } from './pr-d-fixtures';

/**
 * PR D — HOME 3 AND 5.
 *
 *   3. A performance change in "Needs you" has "Explain": Performance opens
 *      with the Copilot, the request in its box (not sent).
 *   5. A decided noticed card stays, greyed green, with its result pill.
 */

for (const locale of ['en', 'ar'] as const) {
  test(`Explain opens Performance with the Copilot and the request (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(120_000);
    const own = await ownWorkspace(`pr-d-explain-${locale}`);
    // Twenty quiet days, then two busy ones: a recent shift above.
    await dailyEngagements(own, [...Array.from({ length: 20 }, () => 100), 420, 450]);
    await enter(page, own.slug, locale);

    const explain = page.getByTestId('attention-explain-performance-above');
    await expect(explain).toBeVisible();
    await explain.click();
    await page.waitForURL(new RegExp(`/${locale}/analytics`));
    // The hand-off is taken off the address, and the drawer is open with the request.
    await expect.poll(() => new URL(page.url()).searchParams.has('copilot')).toBe(false);
    const box = page
      .locator(
        '[data-testid="copilot-drawer"] textarea, [data-testid="copilot-drawer"] input[type="text"]',
      )
      .first();
    await expect(box).toBeVisible();
    await expect(box).toHaveValue(/.+/);
  });

  test(`a decided noticed card stays with its result (${locale})`, async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace(`pr-d-noticed-${locale}`);
    // Four audited Shorten edits on generated LinkedIn words: a noticed habit.
    await withPlatformPrisma(async (prisma) => {
      for (let post = 0; post < 4; post += 1) {
        await prisma.auditEvent.create({
          data: {
            workspaceId: own.workspaceId,
            actorType: 'USER',
            actorId: own.ownerId,
            action: 'content.variant.shorten',
            resourceType: 'ContentVariant',
            resourceId: randomUUID(),
            brandId: own.brandId,
            after: { platformKey: 'linkedin', afterGeneration: true },
          },
        });
      }
    });
    await enter(page, own.slug, locale);
    const key = 'shorter:linkedin';
    await expect(page.getByTestId(`home-preference-${key}`)).toBeVisible();
    await page.getByTestId(`home-preference-accept-${key}`).click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'PREFERENCE_ACCEPT');
    await expect(page.getByTestId(`home-preference-${key}`)).toHaveCount(0);
    const decided = page.getByTestId(`home-decided-${key}`);
    await expect(decided).toBeVisible();
    await expect(decided.locator('.bsp-p-ok')).toBeVisible();
    // Once: a reload does not draw it again.
    await page.reload();
    await expect(page.getByTestId(`home-decided-${key}`)).toHaveCount(0);
  });
}
