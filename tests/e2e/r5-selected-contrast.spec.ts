import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { signIn } from './own-workspace';

/**
 * ROUND 5 (C) — THE SELECTED STATE OF THE SHARED CHIP, TAB AND SEGMENT IS
 * READABLE, measured in the browser.
 *
 * Two of these shipped white on white: the Brand Brain key question once
 * chosen, and the media sheet's chosen tab. Every selected chip, tab and
 * segment on the screens below must reach WCAG 2.2 AA (4.5:1, or 3:1 for
 * large text) against what is actually behind it. The rail is left out: its
 * current item's fill is the pill, a separate element (r4-rail-active covers
 * it). The static guard is `tests/unit/r5-selected-state-contrast.test.ts`.
 */

interface Reading {
  readonly id: string;
  readonly text: string;
  readonly ratio: number;
  readonly need: number;
}

async function selectedReadings(page: Page): Promise<Reading[]> {
  return page.evaluate(() => {
    const SHARED = '.bsp-chip, .bsp-seg-item, .bsp-seg > a, [role="tab"]';
    const SELECTED =
      '[aria-pressed="true"], [aria-selected="true"], [aria-current="page"], [aria-current="true"], [data-chosen="true"]';
    const parse = (value: string) => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      const parts = (match?.[1] ?? '0 0 0 0')
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
    };
    type Rgba = ReturnType<typeof parse>;
    const over = (top: Rgba, under: Rgba): Rgba => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    });
    const lum = (c: Rgba) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const out: { id: string; text: string; ratio: number; need: number }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(SHARED))) {
      if (!el.matches(SELECTED) || el.closest('.bsp-nav')) continue;
      const box = el.getBoundingClientRect();
      const text = el.innerText.trim();
      if (box.width === 0 || text === '') continue;
      const layers: Rgba[] = [];
      for (let node: HTMLElement | null = el; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color.a > 0) layers.push(color);
        if (color.a >= 1) break;
      }
      let bg: Rgba = { r: 255, g: 255, b: 255, a: 1 };
      for (const layer of layers.reverse()) bg = over(layer, bg);
      const style = getComputedStyle(el);
      const raw = parse(style.color);
      const fg = raw.a < 1 ? over(raw, bg) : raw;
      const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number];
      const size = parseFloat(style.fontSize);
      const bold = Number(style.fontWeight) >= 700;
      out.push({
        id: el.getAttribute('data-testid') ?? el.className,
        text: text.slice(0, 30),
        ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
        need: size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5,
      });
    }
    return out;
  });
}

async function expectReadable(page: Page, where: string): Promise<number> {
  // Let a selected state's colour transition finish before measuring it.
  await page.waitForTimeout(400);
  const readings = await selectedReadings(page);
  const failing = readings.filter((reading) => reading.ratio < reading.need);
  expect(failing, `${where}: ${JSON.stringify(failing)}`).toEqual([]);
  return readings.length;
}

for (const locale of ['en', 'ar'] as const) {
  test(`selected chips, tabs and segments are readable (${locale})`, async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'the desktop screens hold every shared control measured here');
    test.setTimeout(120_000);
    await signIn(page, locale);
    let measured = 0;
    let keyQuestion = false;

    // The Brand Brain area: a key question, chosen.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain`);
    const cards = page.locator('[data-testid^="area-card-"]');
    await expect(cards.first()).toBeVisible();
    for (let index = 0; index < (await cards.count()); index += 1) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain`);
      await page.locator('[data-testid^="area-card-"]').nth(index).click();
      const question = page.locator('[data-testid^="drawer-answer-"]').first();
      if ((await question.count()) === 0) continue;
      await question.click();
      await expect(question).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.move(0, 0);
      measured += await expectReadable(page, 'brand brain key question');
      keyQuestion = true;
      break;
    }
    expect(keyQuestion, 'an area with an open key question was found and measured').toBe(true);

    // The calendar's view switch and channel chips.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/calendar`);
    await expect(page.getByTestId('content-calendar')).toBeVisible();
    measured += await expectReadable(page, 'calendar');

    // A draft in the Studio: the format, its channel tabs, Words / Design,
    // and the media sheet's chosen tab.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content?status=DRAFT`);
    const card = page.getByTestId('content-card').first();
    await expect(card).toBeVisible();
    const itemId = (await card.getAttribute('data-item-id')) ?? '';
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?item=${itemId}`);
    await expect(page.getByTestId('draft-editor')).toBeVisible();
    measured += await expectReadable(page, 'studio');
    await page.getByTestId('studio-tab-visual').click();
    const add = page.locator('[data-testid^="content-media-"][data-testid$="-add"]').first();
    if ((await add.count()) > 0) {
      await add.click();
      await expect(page.getByTestId('media-tab-library')).toHaveAttribute('aria-selected', 'true');
      measured += await expectReadable(page, 'studio media sheet');
    }

    expect(measured).toBeGreaterThan(4);
  });
}
