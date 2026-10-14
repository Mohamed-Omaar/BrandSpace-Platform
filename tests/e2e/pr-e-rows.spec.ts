import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * PR E (D-496) — THE SMALLER GROUP B ROWS.
 *
 *   - Brand Brain 1, Strategy 1: the first-visit hint card; × hides it, and it
 *     stays hidden in this browser.
 *   - Strategy 6: "Campaigns in this period" — three months, a bar per campaign
 *     by status, a name opening that campaign.
 *   - Auth 8: "+ Add your own" goal — typed, added as a chip, chosen, saved as
 *     the brand's goal in the person's own words.
 *   - Shell 1, 2: the Notes square opens the popover, "All notes" opens Notes.
 *   - Studio S9: the hashtag count reads "N · Recommended 3–5" where the
 *     platform's range is configured (the calendar fixture gives Instagram the
 *     prototype's 3–5), and "N / max" where it is not.
 */

for (const locale of ['en', 'ar'] as const) {
  test(`first-visit hints on Brand Brain and Strategy close and stay closed (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace(`pr-e-hint-${locale}`);
    await enter(page, own.slug, locale);
    for (const [path, id] of [
      ['/brand-brain', 'hint-brain'],
      ['/strategy', 'hint-strategy'],
    ] as const) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}${path}`);
      const hint = page.getByTestId(id);
      await expect(hint).toBeVisible();
      await expect(hint).toHaveAttribute('role', 'note');
      await expect(hint).toHaveCSS('background-color', 'rgb(246, 243, 255)');
      await page.getByTestId(`${id}-close`).click();
      await expect(hint).toHaveCount(0);
      await page.reload();
      await expect(page.getByTestId(id)).toHaveCount(0);
    }
  });

  test(`Strategy draws this period's campaigns as bars, by status (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace(`pr-e-tl-${locale}`);
    const now = new Date();
    const day = (monthOffset: number, date: number) =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, date));
    const ids = await withPlatformPrisma(async (prisma) => {
      const make = async (name: string, status: string, start: Date, end: Date) =>
        (
          await prisma.campaign.create({
            data: {
              workspaceId: own.workspaceId,
              brandId: own.brandId,
              name,
              objective: 'AWARENESS',
              status: status as never,
              startDate: start,
              endDate: end,
            },
            select: { id: true },
          })
        ).id;
      return {
        run: await make('Running one', 'ACTIVE', day(0, 5), day(1, 1)),
        // FINAL REVIEW (owner, item 6) — every row is inside the window whether
        // the server renders in this month or (seconds later) the next: the
        // paused one ran to the 20th of THIS month, and a render after midnight
        // on the 1st dropped it.
        paused: await make('Paused one', 'PAUSED', day(-2, 1), day(1, 20)),
        plan: await make('Planned one', 'PLANNED', day(2, 3), day(4, 1)),
        outside: await make('Long ago', 'COMPLETED', day(-6, 1), day(-5, 1)),
      };
    });
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/strategy`);
    const timeline = page.getByTestId('strategy-timeline');
    await expect(timeline).toBeVisible();
    await expect(timeline.locator('.bsp-sp-tl-month')).toHaveCount(3);
    await expect(page.getByTestId(`strategy-timeline-${ids.outside}`)).toHaveCount(0);
    for (const [id, kind] of [
      [ids.run, 'run'],
      [ids.paused, 'paused'],
      [ids.plan, 'plan'],
    ] as const) {
      const row = page.getByTestId(`strategy-timeline-${id}`);
      await expect(row.locator('.bsp-sp-tl-bar')).toHaveAttribute('data-kind', kind);
      await expect(row.getByRole('link')).toHaveAttribute('href', `/${locale}/campaigns/${id}`);
    }
    // The paused one began before the window: its bar starts at the window's edge.
    const paused = page.getByTestId(`strategy-timeline-${ids.paused}`).locator('.bsp-sp-tl-bar');
    expect(await paused.evaluate((bar) => (bar as HTMLElement).style.insetInlineStart)).toBe('0%');
    await expect(page.getByTestId('strategy-timeline-all')).toHaveAttribute(
      'href',
      `/${locale}/campaigns`,
    );
  });

  test(`setup: "+ Add your own" goal is typed, chosen and saved (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace(`pr-e-goal-${locale}`);
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/onboarding?step=goal`);
    const open = page.getByTestId('setup-goal-own-open');
    await expect(open).toHaveText(locale === 'ar' ? '+ أضف هدفك' : '+ Add your own');
    await expect(open).toHaveCSS('border-style', 'dashed');
    await open.click();
    const words = `Open a second branch ${randomUUID().slice(0, 4)}`;
    await page.getByTestId('setup-goal-own-input').fill(words);
    await page.getByTestId('setup-goal-own-add').click();
    await expect(page.getByTestId('setup-goal-own')).toBeChecked();
    await expect(page.getByTestId('setup-goal-own-open')).toBeVisible();
    await page.getByTestId('setup-goal-submit').click();
    await page.waitForURL(/step=done/);
    const goal = await withPlatformPrisma(async (prisma) => ({
      item: await prisma.brandKnowledgeItem.findFirstOrThrow({
        where: { brandId: own.brandId, area: 'STRATEGY', itemKey: 'goal.primary' },
        select: { title: true, origin: true },
      }),
      brand: await prisma.brand.findUniqueOrThrow({
        where: { id: own.brandId },
        select: { primaryGoalKey: true },
      }),
    }));
    expect(goal.item.title).toEqual({ en: words, ar: words });
    expect(goal.item.origin).toBe('SETUP');
    expect(goal.brand.primaryGoalKey).toBeNull();
    // Back on the step, the typed goal is its own chip, chosen.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/onboarding?step=goal`);
    await expect(page.getByTestId('setup-goal-own')).toBeChecked();
    await expect(page.getByTestId('setup-goal')).toContainText(words);
  });

  test(`the Notes square opens its popover; All notes opens Notes (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the top bar square is desktop');
    const own = await ownWorkspace(`pr-e-notes-${locale}`);
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/overview`);
    await page.getByTestId('topbar-notes').click();
    const pop = page.getByTestId('notes-popover');
    await expect(pop).toBeVisible();
    await expect(pop).toHaveAttribute('role', 'dialog');
    // A new workspace has no notes yet, and says so.
    await expect(page.getByTestId('notes-popover-empty')).toBeVisible();
    await expect(page.getByTestId('notes-popover-all')).toHaveText(
      locale === 'ar' ? 'كل الملاحظات' : 'All notes',
    );
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await page.getByTestId('topbar-notes').click();
    await page.getByTestId('notes-popover-all').click();
    await page.waitForURL(new RegExp(`/${locale}/notes$`));
  });
}

for (const locale of ['en', 'ar'] as const) {
  test(`Studio: the hashtag count names the configured range (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace(`pr-e-tags-${locale}`);
    const { itemId, instagram, linkedin } = await withPlatformPrisma(async (prisma) => {
      const base = { workspaceId: own.workspaceId, brandId: own.brandId };
      const item = await prisma.contentItem.create({
        data: {
          ...base,
          title: 'Friday cold brew',
          contentType: 'POST',
          primaryLocale: 'EN',
          status: 'DRAFT',
          createdByUserId: own.ownerId,
        },
        select: { id: true },
      });
      const variant = (platformKey: string) =>
        prisma.contentVariant.create({
          data: {
            ...base,
            contentItemId: item.id,
            platformKey,
            locale: 'EN',
            body: 'Two for one on Fridays.',
            hashtags: ['coldbrew', 'friday'],
            characterCount: 23,
            validationState: 'VALID',
          },
          select: { id: true },
        });
      return {
        itemId: item.id,
        instagram: (await variant('instagram')).id,
        linkedin: (await variant('linkedin')).id,
      };
    });
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?item=${itemId}`);
    await expect(page.getByTestId(`studio-tags-count-${instagram}`)).toHaveText(
      locale === 'ar' ? '2 · المقترح 3–5' : '2 · Recommended 3–5',
    );
    // LinkedIn has no configured range: the ceiling, as before.
    await page
      .getByRole('tab', { name: /LinkedIn/ })
      .first()
      .click();
    await expect(page.getByTestId(`studio-tags-count-${linkedin}`)).toHaveText(/^2 \/ \d+$/);
  });
}
