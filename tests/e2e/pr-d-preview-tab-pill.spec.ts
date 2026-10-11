import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';

/**
 * PR D — THE STUDIO PREVIEW'S CHANNEL TABS: THE PILL FITS THE SELECTED TAB AS
 * CHANNELS COME AND GO.
 *
 * The owner, on staging: two channels on a post, one removed — one tab left,
 * its label across the whole bar, and the white pill still over half of it.
 * `SegmentPill` re-measured on a selection change or a resize of the bar, and
 * removing a channel is neither: the bar keeps its width and the remaining tab
 * stays selected while its own box doubles. The pill now watches every
 * segment's box, and re-reads the segments when one comes or goes.
 *
 * Each step adds or removes a channel and checks that the pill's visible box
 * (the bar's box less the clip's insets) is the selected tab's box, to a pixel.
 */

async function pillFitsSelectedTab(page: Page): Promise<number> {
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('[data-testid^="preview-tab-"]')?.parentElement;
    const fill = bar?.querySelector<HTMLElement>('.bs-seg-pill-fill');
    const tab = bar?.querySelector<HTMLElement>('button[aria-pressed="true"]');
    if (!bar || !fill || !tab) return Infinity;
    const inset = /inset\(([-\d.]+)px ([-\d.]+)px ([-\d.]+)px ([-\d.]+)px/.exec(
      getComputedStyle(fill).clipPath,
    );
    if (!inset) return Infinity;
    const [top, right, bottom, left] = inset.slice(1, 5).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const box = bar.getBoundingClientRect();
    const pill = {
      left: box.left + bar.clientLeft + left,
      top: box.top + bar.clientTop + top,
      right: box.left + bar.clientLeft + bar.clientWidth - right,
      bottom: box.top + bar.clientTop + bar.clientHeight - bottom,
    };
    const r = tab.getBoundingClientRect();
    return (
      Math.abs(pill.left - r.left) +
      Math.abs(pill.top - r.top) +
      Math.abs(pill.right - r.right) +
      Math.abs(pill.bottom - r.bottom)
    );
  });
}

for (const locale of ['en', 'ar'] as const) {
  test(`the preview pill fits the selected channel tab as channels change (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1536, height: 864 });
    const own = await ownWorkspace(`pr-d-pill-${locale}`);
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?mode=write`);
    await expect(page.getByTestId('content-composer')).toBeVisible();

    // Two channels on a new post, then words, so the draft is made.
    const chips = page.locator(
      '[data-testid="content-channel"]:not([disabled]):not([aria-disabled="true"])',
    );
    const keys = await chips.evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).dataset['platform'] ?? ''),
    );
    expect(keys.length).toBeGreaterThanOrEqual(3);
    const [first, second, third] = keys as [string, string, string];
    for (const key of [first, second]) {
      const chip = page.locator(`[data-testid="content-channel"][data-platform="${key}"]`);
      if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
    }
    for (const chip of await chips.all()) {
      const key = await chip.getAttribute('data-platform');
      if (key !== first && key !== second && (await chip.getAttribute('aria-pressed')) === 'true') {
        await chip.click();
      }
    }
    await page.getByTestId('content-caption').click();
    await page.keyboard.type(`Pill ${locale} ${Date.now().toString(36)}`);
    await page.waitForURL((url) => url.searchParams.has('item'), { timeout: 30_000 });

    const tabs = page.locator('[data-testid^="preview-tab-"]');
    const step = async (label: string, count: number) => {
      await expect(tabs, label).toHaveCount(count, { timeout: 15_000 });
      await expect.poll(() => pillFitsSelectedTab(page), { message: label }).toBeLessThan(1);
    };

    await step('two channels', 2);
    // Select the second tab, then remove the FIRST channel: the selected tab
    // stays selected and grows to the whole bar — the owner's case.
    await page.getByTestId(`preview-tab-${second}`).click();
    await step('second tab selected', 2);
    await page.getByTestId(`editor-channel-remove-${first}`).click();
    await step('first channel removed', 1);
    await page.getByTestId(`editor-channel-add-${first}`).click();
    await step('first channel added back', 2);
    await page.getByTestId(`editor-channel-add-${third}`).click();
    await step('a third channel added', 3);
    await page.getByTestId(`preview-tab-${third}`).click();
    await step('third tab selected', 3);
    await page.getByTestId(`editor-channel-remove-${third}`).click();
    await step('the selected channel removed', 2);
    await page.getByTestId(`editor-channel-remove-${second}`).click();
    await step('down to one channel', 1);
  });
}
