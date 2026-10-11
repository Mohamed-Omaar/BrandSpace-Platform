import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { signIn } from './own-workspace';

/**
 * PR D — SETTINGS → GENERAL: THE TIME-ZONE NOTE SITS WHERE THE PROTOTYPE PUTS IT.
 *
 * The prototype's picker (`CB_mk`, `Main.dc.html` line 1344) is a column with
 * `gap: 6px`; its note is `font-size: 11.5px; color: #6a6a72; line-height:
 * 1.45`. At the customer app's 0.88 the gap is the `--bsp-px-6` token (5.5px)
 * and the text takes the 11px floor. The note sat 3.5px under the field on a
 * 10.5px line — shorter than its own text — so it read as touching the field.
 */
for (const locale of ['en', 'ar'] as const) {
  test(`the time-zone note keeps the prototype's spacing (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the phone layout is post-launch (D-468 (b))');
    await page.setViewportSize({ width: 1536, height: 864 });
    await signIn(page, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/settings`);
    const note = page.locator('#timezone-hint');
    await expect(note).toBeVisible();
    const measured = await page.evaluate(() => {
      const hint = document.getElementById('timezone-hint')!;
      const field = document.querySelector('[data-testid="settings-timezone"]')!;
      const style = getComputedStyle(hint);
      return {
        gap: hint.getBoundingClientRect().top - field.getBoundingClientRect().bottom,
        fontSize: parseFloat(style.fontSize),
        lineHeight: parseFloat(style.lineHeight),
        color: style.color,
      };
    });
    expect(Math.abs(measured.gap - 5.5)).toBeLessThanOrEqual(0.5);
    expect(measured.fontSize).toBe(11);
    expect(Math.abs(measured.lineHeight - 11 * 1.45)).toBeLessThanOrEqual(0.5);
    expect(measured.color).toBe('rgb(106, 106, 114)');
  });
}
