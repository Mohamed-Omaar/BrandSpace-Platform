import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';

/**
 * PR D (Studio S38) — "SAFE ZONES" ON A 9:16 PREVIEW, FROM CONFIGURATION.
 *
 * The prototype's chip sits beside the size line on a 9:16 preview only
 * (`showSafeBtn`, `Main.dc.html` line 434) and lays the platform's unsafe bands
 * over the frame: top and bottom across it, the end side between them. The
 * band sizes are each platform's configured `safeZones` — the E2E seed gives
 * Instagram the prototype's own 13 / 22 / 16 per cent and TikTok nothing — and
 * a platform with none configured gets no chip.
 */

async function bands(page: Page) {
  return page.evaluate(() => {
    const overlay = document.querySelector<HTMLElement>('[data-testid="preview-safe-zones"]');
    const frame = overlay?.parentElement;
    if (!overlay || !frame) return null;
    const f = frame.getBoundingClientRect();
    const box = (cls: string) => overlay.querySelector(cls)!.getBoundingClientRect();
    const top = box('.bsp-safe-top');
    const bottom = box('.bsp-safe-bottom');
    const end = box('.bsp-safe-end');
    const rtl = getComputedStyle(frame).direction === 'rtl';
    return {
      top: (top.height / f.height) * 100,
      bottom: (bottom.height / f.height) * 100,
      end: (end.width / f.width) * 100,
      endAtEnd: rtl ? Math.abs(end.left - f.left) < 1 : Math.abs(end.right - f.right) < 1,
      endBetween: Math.abs(end.top - top.bottom) < 1.5 && Math.abs(end.bottom - bottom.top) < 1.5,
      pointerEvents: getComputedStyle(overlay).pointerEvents,
    };
  });
}

for (const locale of ['en', 'ar'] as const) {
  test(`Safe zones: a configured 9:16 preview only, the bands at their configured sizes (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1536, height: 864 });
    const own = await ownWorkspace(`pr-d-safe-${locale}`);
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?mode=write`);
    await expect(page.getByTestId('content-composer')).toBeVisible();

    const chip = (key: string) =>
      page.locator(`[data-testid="content-channel"][data-platform="${key}"]`);
    for (const key of ['instagram', 'tiktok']) {
      if ((await chip(key).getAttribute('aria-pressed')) !== 'true') await chip(key).click();
      await expect(chip(key)).toHaveAttribute('aria-pressed', 'true');
    }
    const toggle = page.getByTestId('preview-safe-toggle');

    // A 4:5 Instagram post: no chip.
    await page.locator('[data-testid="content-format"] button[data-value="POST"]').click();
    await page.getByTestId('composer-preview-tab-instagram').click();
    await expect(toggle).toHaveCount(0);

    // An Instagram Reel (9:16): the chip, off, then the bands.
    await page.locator('[data-testid="content-format"] button[data-value="REEL"]').click();
    await page.getByTestId('composer-preview-tab-instagram').click();
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('preview-safe-zones')).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('preview-safe-zones')).toHaveCount(1);
    const measured = await bands(page);
    expect(measured).not.toBeNull();
    expect(Math.abs(measured!.top - 13)).toBeLessThan(1);
    expect(Math.abs(measured!.bottom - 22)).toBeLessThan(1);
    expect(Math.abs(measured!.end - 16)).toBeLessThan(1);
    expect(measured!.endAtEnd).toBe(true);
    expect(measured!.endBetween).toBe(true);
    expect(measured!.pointerEvents).toBe('none');

    // TikTok is 9:16 too, but has no bands configured: no chip, no overlay.
    await page.getByTestId('composer-preview-tab-tiktok').click();
    await expect(toggle).toHaveCount(0);
    await expect(page.getByTestId('preview-safe-zones')).toHaveCount(0);

    // Off again on Instagram.
    await page.getByTestId('composer-preview-tab-instagram').click();
    await toggle.click();
    await expect(page.getByTestId('preview-safe-zones')).toHaveCount(0);
  });
}
