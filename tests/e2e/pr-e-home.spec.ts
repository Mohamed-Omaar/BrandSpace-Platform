import { expect, test } from '@playwright/test';
import { enter, ownWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';
import { failedPost, noticedSuggestion } from './pr-e-fixtures';

/**
 * PR E (D-496) — HOME 1, 2 AND 4.
 *
 *   1. "Needs you" names each failed post — "“title” failed to publish on
 *      Instagram" — up to three, then "and N more" for the rest.
 *   2. "Retry" acts in place: the post's failed job is queued again and Home
 *      comes back saying so; the row is gone.
 *   4. A noticed suggestion has the prototype's two buttons: the direct action
 *      named after the format it suggests ("Make a reel"; "Make a post" when it
 *      names none), which opens the Studio on that format, and "Not now",
 *      which hides it for the configured days.
 */

for (const locale of ['en', 'ar'] as const) {
  test(`Needs you names each failed post, and Retry acts in place (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(120_000);
    const own = await ownWorkspace(`pr-e-needs-${locale}`);
    const posts = [];
    // Four failures, the newest last: three are named, one is "and 1 more".
    for (let index = 0; index < 4; index += 1) {
      posts.push(await failedPost(own, `Autumn menu ${index + 1}`, 50 - index * 10));
    }
    await enter(page, own.slug, locale);

    const named = page.locator('[data-testid^="attention-publishing-failed-"]');
    const newest = posts[3]!;
    const row = page.getByTestId(`attention-publishing-failed-${newest.slotId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Autumn menu 4');
    await expect(row).toContainText('Instagram');
    // Three rows of posts and the "more" row.
    await expect(named).toHaveCount(4);
    await expect(page.getByTestId('attention-publishing-failed-more')).toContainText(
      locale === 'ar' ? 'و1 أخرى' : 'and 1 more',
    );
    await expect(page.getByTestId(`attention-publishing-failed-${posts[0]!.slotId}`)).toHaveCount(
      0,
    );

    // Retry in place: the job is queued again, and Home comes back.
    await page.getByTestId(`attention-retry-${newest.slotId}`).click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'POST_RETRY_QUEUED');
    expect(new URL(page.url()).pathname).toBe(`/${locale}/overview`);
    // The retry was taken: the pipeline audits it. (The job itself may already
    // have been picked up again by the worker, so its status is not asserted.)
    const retried = await withPlatformPrisma((prisma) =>
      prisma.auditEvent.count({
        where: {
          workspaceId: own.workspaceId,
          action: 'social.post.retry_requested',
          resourceId: newest.jobId,
        },
      }),
    );
    expect(retried).toBe(1);
  });

  test(`a noticed suggestion: Make a reel opens the Studio on Reel; Not now hides it (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(120_000);
    const own = await ownWorkspace(`pr-e-noticed-${locale}`);
    const reel = await noticedSuggestion(own, 'Reels reach twice as many people', 'REEL');
    const plain = await noticedSuggestion(own, 'Post on Thursday evenings');
    await enter(page, own.slug, locale);

    const reelCard = page.getByTestId(`home-recommendation-${reel}`);
    await expect(reelCard).toBeVisible();
    await expect(page.getByTestId(`home-recommendation-make-${reel}`)).toHaveText(
      locale === 'ar' ? 'أنشئ ريل' : 'Make a reel',
    );
    await expect(page.getByTestId(`home-recommendation-make-${plain}`)).toHaveText(
      locale === 'ar' ? 'أنشئ منشورًا' : 'Make a post',
    );
    await expect(page.getByTestId(`home-recommendation-snooze-${reel}`)).toHaveText(
      locale === 'ar' ? 'ليس الآن' : 'Not now',
    );
    // The prototype's two buttons, and nothing else on the card.
    await expect(reelCard.locator('.bsp-xfoot').locator('a, button')).toHaveCount(2);

    // "Not now": hidden for the configured days, its status untouched.
    await page.getByTestId(`home-recommendation-snooze-${plain}`).click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'INSIGHT_SNOOZED');
    await expect(page.getByTestId(`home-recommendation-${plain}`)).toHaveCount(0);
    const row = await withPlatformPrisma((prisma) =>
      prisma.insight.findUniqueOrThrow({
        where: { id: plain },
        select: { status: true, snoozedUntil: true },
      }),
    );
    expect(row.status).toBe('NEW');
    const days = (row.snoozedUntil!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    // "Make a reel" opens the Studio on Reel, the suggestion as the brief.
    await page.getByTestId(`home-recommendation-make-${reel}`).click();
    await page.waitForURL(/\/content\/compose\?/);
    const address = new URL(page.url());
    expect(address.searchParams.get('format')).toBe('REEL');
    expect(address.searchParams.get('brief')).toBe('Reels reach twice as many people');
  });
}
