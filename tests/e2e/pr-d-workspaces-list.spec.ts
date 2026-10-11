import { expect, test } from '@playwright/test';
import { manyWorkspaces, signInToList } from './pr-d-fixtures';

/**
 * PR D (review of #75) — CHOOSING A WORKSPACE WITH MANY OF THEM.
 *
 * A person who owns a dozen businesses, one of them on a plan that allows
 * more: the rows scroll inside the card, "Create workspace · n/limit" (Auth 6)
 * stays in view at the card's foot, and the window itself never scrolls at
 * 1536 × 864.
 */

for (const locale of ['en', 'ar'] as const) {
  test(`many workspaces: the rows scroll in the card, Create workspace stays in view (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the phone layout scrolls the page (post-launch)');
    await page.setViewportSize({ width: 1536, height: 864 });
    const person = await manyWorkspaces(`many-${locale}`);
    await signInToList(page, person.email, person.password, locale);

    const create = page.getByTestId('workspaces-create');
    await expect(create).toBeVisible();
    const geometry = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-testid="auth-form-card"]')!;
      const list = document.querySelector<HTMLElement>('.bsp-auth-wslist')!;
      const create = document.querySelector<HTMLElement>('[data-testid="workspaces-create"]')!;
      const c = card.getBoundingClientRect();
      const r = create.getBoundingClientRect();
      return {
        createInCard: r.top >= c.top && r.bottom <= c.bottom + 0.5,
        createInWindow: r.bottom <= window.innerHeight,
        listScrolls: list.scrollHeight > list.clientHeight + 1,
        cardScrolls: card.scrollHeight > card.clientHeight + 1,
        windowScrolls:
          document.documentElement.scrollHeight > window.innerHeight ||
          document.scrollingElement!.scrollTop > 0,
      };
    });
    expect(geometry.createInCard, 'the create row is inside the card').toBe(true);
    expect(geometry.createInWindow, 'the create row is on screen').toBe(true);
    expect(geometry.listScrolls, 'the rows scroll inside the card').toBe(true);
    expect(geometry.cardScrolls, 'the card itself does not scroll').toBe(false);
    expect(geometry.windowScrolls, 'the window does not scroll').toBe(false);
  });
}
