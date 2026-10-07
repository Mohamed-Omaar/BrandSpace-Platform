import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * ROUND 5 (A) — THE STUDIO UNDER A SLOW LINK.
 *
 * The owner tested from Egypt against a server in Amsterdam: channel chips and
 * the publish time took a click only sometimes. Locally every save is instant,
 * which hid it. Here the browser adds a delay to every request (Chrome's own
 * network emulation; `latency` is the added round trip, so 600 ms is 300 ms
 * each way and 2000 ms is 1 s each way), and the person works in quick
 * succession: each channel toggled, words typed straight through the moment
 * the draft is made, Design and Words, a hashtag, then the time opened and
 * set. Every action must show at once and still be there after a reload.
 *
 * The time is set LAST on purpose: in a workspace without approval, setting
 * it schedules the post, and a scheduled post's words wait for "Save edit"
 * (the autosave guard, which stays).
 */

async function slowLink(page: Page, latency: number): Promise<(on: boolean) => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  return async (on: boolean) => {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: on ? latency : 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  };
}

/** The tab is pressed: `aria-selected` on the new post, `aria-pressed` on its draft. */
async function chosen(page: Page, testId: string): Promise<boolean> {
  const tab = page.getByTestId(testId);
  return (
    (await tab.getAttribute('aria-selected')) === 'true' ||
    (await tab.getAttribute('aria-pressed')) === 'true'
  );
}

for (const latency of [600, 2000]) {
  test(`the Studio keeps every action under a ${latency} ms round trip`, async ({
    page,
    isMobile,
    browserName,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.skip(browserName !== 'chromium', 'the delay is Chrome network emulation');
    test.setTimeout(180_000);
    const own = await ownWorkspace(`r5-delay-${latency}`);
    await enter(page, own.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?mode=write`);
    await expect(page.getByTestId('content-composer')).toBeVisible();
    const slow = await slowLink(page, latency);
    await slow(true);

    // 1. Every channel this format carries, toggled on — each one at once.
    const chips = page.locator(
      '[data-testid="content-channel"]:not([disabled]):not([aria-disabled="true"])',
    );
    const keys = await chips.evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset['platform'] ?? ''),
    );
    expect(keys.length).toBeGreaterThan(1);
    for (const key of keys) {
      const chip = page.locator(`[data-testid="content-channel"][data-platform="${key}"]`);
      if ((await chip.getAttribute('aria-pressed')) === 'true') {
        // Off and on again: both presses take.
        await chip.click();
        await expect(chip).toHaveAttribute('aria-pressed', 'false', { timeout: 300 });
      }
      await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'true', { timeout: 300 });
    }

    // 2. Words, typed straight through the moment the draft is made.
    const marker = `Slow ${latency} ${Date.now().toString(36)}`;
    await page.getByTestId('content-caption').click();
    await page.keyboard.type(marker, { delay: 15 });
    // A pause long enough for the draft to start being made, then more words
    // while it is: they must land in the draft's own field, not in nothing.
    await page.waitForTimeout(1_100);
    let typed = marker;
    for (let i = 1; i <= 8; i += 1) {
      await page.waitForTimeout(350);
      const word = ` w${i}`;
      await page.keyboard.type(word, { delay: 15 });
      typed += word;
    }
    const caption = page.locator('textarea[name="body"], [data-testid="content-caption"]').first();
    await expect(caption).toHaveValue(typed, { timeout: 10_000 });

    // 3. Design, then Words — each pressed at once.
    await page.getByTestId('studio-tab-visual').click();
    expect(await chosen(page, 'studio-tab-visual')).toBe(true);
    await page.getByTestId('studio-tab-words').click();
    expect(await chosen(page, 'studio-tab-words')).toBe(true);

    await page.waitForURL((url) => url.searchParams.has('item'), { timeout: 30_000 });
    const itemId = new URL(page.url()).searchParams.get('item') ?? '';
    await expect(page.getByTestId('variant-tabs')).toBeVisible({ timeout: 30_000 });

    // 3b. Round 5 (B, D-478): the draft's format and channels still change.
    //     A format some channels cannot carry is refused in words, at once.
    const format = (type: string) =>
      page.locator(`[data-testid="editor-format"] button[data-value="${type}"]`);
    // Round 6 (D-481): the format is dimmed BEFORE the press, so the press is forced.
    await expect(format('REEL')).toHaveAttribute('aria-disabled', 'true');
    await format('REEL').click({ force: true });
    await expect(page.getByTestId('editor-shape-note')).toContainText('LinkedIn', {
      timeout: 300,
    });
    await expect(format('REEL')).toHaveAttribute('aria-pressed', 'false');
    // X off, back on, and off again; LinkedIn off — each shows at once.
    await page.getByTestId('editor-channel-remove-x').click();
    await expect(page.getByTestId('variant-tab-x')).toHaveCount(0, { timeout: 300 });
    await page.getByTestId('editor-channel-add-x').click();
    await expect(page.getByTestId('editor-channel-add-x')).toHaveAttribute('aria-pressed', 'true', {
      timeout: 300,
    });
    await expect(page.getByTestId('variant-tab-x')).toBeVisible({ timeout: 15 * latency + 10_000 });
    await page.getByTestId('editor-channel-remove-x').click();
    await page.getByTestId('editor-channel-remove-linkedin').click();
    await expect(page.getByTestId('variant-tab-linkedin')).toHaveCount(0, { timeout: 300 });
    await format('REEL').click();
    await expect(format('REEL')).toHaveAttribute('aria-pressed', 'true', { timeout: 300 });
    // What a Reel needs that the post does not hold yet is said, not refused.
    await expect(page.getByText('This Reel needs a vertical video.').first()).toBeVisible({
      timeout: 15 * latency + 10_000,
    });
    const kept = keys.filter((key) => key !== 'x' && key !== 'linkedin');

    // 4. A hashtag, in whichever field is on screen.
    const tagField = page.locator('input[data-testid^="content-hashtags-"]:visible').first();
    await tagField.fill('slowlink', { timeout: 10_000 });
    await page.locator('[data-testid^="content-hashtags-add-"]:visible').first().click();
    await expect(page.locator('.bsp-st-tag', { hasText: '#slowlink' }).first()).toBeVisible({
      timeout: 300,
    });

    // 5. The time: the panel opens on the first press, and "Set" waits for the
    //    words to be saved instead of being disabled while they are.
    await page.getByTestId('editor-when').click();
    await expect(page.getByTestId('editor-when-panel')).toBeVisible({ timeout: 300 });
    const set = page.getByTestId('editor-schedule-submit');
    await expect(set).toBeEnabled({ timeout: 300 });
    await page.getByTestId('editor-schedule-time').fill('16:40');
    await set.click();
    await expect(page.getByTestId('editor-when')).toContainText('16:40', {
      timeout: 15 * latency + 10_000,
    });

    // 6. All of it survives a reload.
    await slow(false);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
    await expect(page.getByTestId('editor-when')).toContainText('16:40');
    const rows = await withPlatformPrisma((prisma) =>
      prisma.contentVariant.findMany({
        where: { contentItemId: itemId },
        select: { platformKey: true, body: true, hashtags: true },
      }),
    );
    expect(rows.map((row) => row.platformKey).sort()).toEqual([...kept].sort());
    const item = await withPlatformPrisma((prisma) =>
      prisma.contentItem.findUniqueOrThrow({
        where: { id: itemId },
        select: { contentType: true },
      }),
    );
    expect(item.contentType).toBe('REEL');
    // Each channel has its own version: all of them carry what was typed
    // before the draft opened, and the one on screen everything typed after.
    const shown = (await page
      .locator('[data-testid="content-variant"]:visible')
      .getAttribute('data-platform')) as string;
    for (const row of rows) {
      const body = row.body ?? '';
      expect(typed.startsWith(body) && body.startsWith(marker)).toBe(true);
    }
    expect(kept.length).toBeGreaterThan(0);
    expect(rows.find((row) => row.platformKey === shown)?.body).toBe(typed);
    expect(rows.some((row) => row.hashtags.includes('slowlink'))).toBe(true);
    await expect(page.locator('textarea[name="body"]').first()).toHaveValue(typed);
  });
}
