import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { signIn } from './own-workspace';
import { PROTOTYPE, serveFonts } from './prototype-runtime';
import { prototypeSizes, scaled, scaledType } from './scale';

/**
 * REVIEW OF #68, ROUND 4, STEP 1.9 — THE SHARED CONTROLS ARE THE PROTOTYPE'S
 * SIZE, MEASURED, NOT RESTATED.
 *
 * Every reference value below is read at RUNTIME from the vendored prototype
 * (`docs/visual-reference/prototype-2026-09-27/Main.dc.html`, opened as it
 * is), with `getComputedStyle` and `offsetHeight`. The product's controls are
 * measured the same way on its own screens. Nothing here is a hard-coded
 * pixel value: change a token in `prototype.css` and the product side moves;
 * change the prototype and the reference moves — either way a difference
 * fails the test.
 *
 * TOLERANCE: 0.5px on lengths, exact on font weight. Lengths are the
 * prototype's own whole and half pixels (`13.5px`, `min-block-size: 40px`);
 * the half pixel absorbs layout rounding of a height that comes from a font's
 * line box (a `.chip` is `padding + line-height: normal`), which is the same
 * typeface on both sides but may land on a different subpixel. Anything at or
 * over 0.5px is a real difference.
 *
 * Desktop only: the prototype is a 1440px desktop frame; the phone layout is a
 * post-launch item (D-468 (b)).
 */

const TOLERANCE = 0.5;

interface Measured {
  readonly height: number;
  readonly radius: number;
  readonly padStart: number;
  readonly padEnd: number;
  readonly padTop: number;
  readonly fontSize: number;
  readonly fontWeight: number;
}

/** The computed geometry of the first element matching `selector` that `accept`s it. */
async function measure(
  page: Page,
  selector: string,
  label: string,
  accept = '(el) => true',
): Promise<Measured> {
  const found = await page.evaluate(
    ({ selector, accept }) => {
      const ok = new Function('el', `return (${accept})(el)`) as (el: Element) => boolean;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
        if (!ok(el)) continue;
        const cs = getComputedStyle(el);
        return {
          height: el.offsetHeight,
          radius: parseFloat(cs.borderTopLeftRadius),
          padStart: parseFloat(cs.paddingInlineStart),
          padEnd: parseFloat(cs.paddingInlineEnd),
          padTop: parseFloat(cs.paddingTop),
          fontSize: parseFloat(cs.fontSize),
          fontWeight: Number(cs.fontWeight),
        };
      }
      return null;
    },
    { selector, accept },
  );
  expect(found, `${label}: no visible "${selector}"`).not.toBeNull();
  return found as Measured;
}

function expectSame(
  product: Measured,
  reference: Measured,
  label: string,
  keys: (keyof Measured)[],
) {
  for (const key of keys) {
    if (key === 'fontWeight') {
      expect(product[key], `${label} · ${key}`).toBe(reference[key]);
    } else {
      // D-484: the product is the prototype at 0.88 (`scale.ts`); `height` is
      // `offsetHeight`, a whole pixel on both sides, so its scaled value is
      // rounded the same way.
      const expected =
        key === 'fontSize'
          ? scaledType(reference[key])
          : key === 'height'
            ? Math.round(scaled(reference[key]))
            : scaled(reference[key]);
      expect(
        Math.abs(product[key] - expected),
        `${label} · ${key}: product ${product[key]} vs prototype ${reference[key]} × 0.88 = ${expected}`,
      ).toBeLessThan(TOLERANCE);
    }
  }
}

/** A prototype control whose geometry is the class's own — no inline override of it. */
const PLAIN = `(el) => !/min-block-size|padding|font-size|height/.test(el.getAttribute('style') || '')`;

const ALL: (keyof Measured)[] = [
  'height',
  'radius',
  'padStart',
  'padEnd',
  'fontSize',
  'fontWeight',
];

test.describe('round 4 · shared controls match the prototype, measured', () => {
  test.skip(({ isMobile }) => isMobile, 'the prototype is a 1440px desktop frame');
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(120_000);

  test('buttons, fields, chips, the rail, its badges and the toast', async ({ page, browser }) => {
    /* ---------------------------------------------- the prototype, at runtime */
    const proto = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await serveFonts(proto);
    await proto.goto(PROTOTYPE, { waitUntil: 'networkidle' });
    await proto.evaluate(() => document.fonts.ready);
    const ref = {
      btn: await measure(proto, '.btn:not(.sm)', 'prototype .btn', PLAIN),
      btnSm: await measure(proto, '.btn.sm', 'prototype .btn.sm', PLAIN),
      nav: await measure(proto, '.nav', 'prototype .nav'),
      cnt: await measure(proto, '.cnt', 'prototype .cnt'),
      ibtn: await measure(proto, '.ibtn', 'prototype .ibtn', PLAIN),
    };
    // The Posts screen's filter chips are the plain `.chip`.
    await proto.locator('.nav', { hasText: 'Posts' }).first().click();
    const chipRef = await measure(proto, '.chip', 'prototype .chip', PLAIN);
    await proto.locator('.nav', { hasText: 'Settings' }).first().click();
    // Settings → General: the business name is the prototype's form field.
    const field = await measure(proto, 'main input:not([type])', 'prototype field');
    // Its dropdown trigger states `min-block-size: 40px` — the field height.
    const trigger = await measure(
      proto,
      'main button[aria-haspopup="listbox"]',
      'prototype select',
    );
    await proto.locator('.nav', { hasText: 'Approvals' }).first().click();
    await proto
      .getByRole('button', { name: /^Approve/ })
      .first()
      .click();
    const toast = await measure(proto, '.toastx', 'prototype toast');
    await proto.close();

    /* ------------------------------------------------ the product, the same way */
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await page.evaluate(() => document.fonts.ready);
    expectSame(
      await measure(page, '.bsp-btn:not(.bsp-sm):not(.bsp-lg)', 'product .bsp-btn'),
      ref.btn,
      'button',
      ALL,
    );
    expectSame(await measure(page, '.bsp-nav', 'product .bsp-nav'), ref.nav, 'rail item', ALL);
    expectSame(
      await measure(
        page,
        '.bsp-cnt[data-tone="ink"], .bsp-cnt[data-tone="bad"]',
        'product .bsp-cnt',
      ),
      ref.cnt,
      'rail badge',
      ALL,
    );
    expectSame(
      await measure(page, '.bsp-ibtn:not(.bsp-sbt)', 'product .bsp-ibtn'),
      ref.ibtn,
      'icon button',
      ['height', 'radius'],
    );

    await page.goto(`${DASHBOARD_BASE_URL}/en/calendar`);
    expectSame(
      await measure(page, '.bsp-btn.bsp-sm', 'product .bsp-btn.bsp-sm'),
      ref.btnSm,
      'small button',
      ALL,
    );
    expectSame(await measure(page, '.bsp-chip', 'product .bsp-chip'), chipRef, 'chip', ALL);

    await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);
    const productField = await measure(
      page,
      'main input.bs-control:not([type]), main input.bs-control[type="text"]',
      'product field',
    );
    expectSame(productField, field, 'text field', ALL);
    const productSelect = await measure(page, 'main select.bs-control', 'product select');
    expectSame(productSelect, trigger, 'select', ['height', 'radius', 'padStart', 'fontSize']);

    // A page that hands its `?ok=` to the one toast host (C8).
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/ai?ok=SETTINGS_SAVED`);
    // Hovering holds the toast for as long as it is measured (C8).
    await page.getByTestId('toast').hover();
    const productToast = await measure(page, '[data-testid="toast"]', 'product toast');
    expectSame(productToast, toast, 'toast', ALL);
  });

  test('the collapsed rail: the same width, the same squares, the same badges', async ({
    page,
    browser,
  }) => {
    // Round 4, 2.2 — read from both rails once collapsed: the rail's width,
    // each row's square and where it sits in the rail, and the corner badge.
    const rail = () => {
      const sb = document.querySelector<HTMLElement>('.sb, .bsp-sb')!;
      const box = sb.getBoundingClientRect();
      const rows = Array.from(sb.querySelectorAll<HTMLElement>('.nav, .bsp-nav')).filter(
        (el) => el.offsetParent !== null,
      );
      const badge = sb.querySelector<HTMLElement>(
        '.nav .cnt, .bsp-nav .bsp-cnt[data-tone="ink"], .bsp-nav .bsp-cnt[data-tone="bad"]',
      );
      const row = badge?.closest<HTMLElement>('.nav, .bsp-nav');
      const b = badge?.getBoundingClientRect();
      const r = row?.getBoundingClientRect();
      return {
        width: box.width,
        rows: rows.map((el) => {
          const q = el.getBoundingClientRect();
          return { x: q.x - box.x, width: q.width, height: q.height };
        }),
        badge: b && r ? { x: b.x - r.x, y: b.y - r.y, width: b.width, height: b.height } : null,
      };
    };

    const proto = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await serveFonts(proto);
    await proto.goto(PROTOTYPE, { waitUntil: 'networkidle' });
    await proto.locator('.sb button[aria-label="Collapse menu"]').click();
    await proto.waitForTimeout(900);
    const ref = await proto.evaluate(rail);
    await proto.close();

    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await page.locator('.bsp-sb button[aria-pressed="false"]').first().click();
    await expect(page.locator('.bsp-sb.bsp-min')).toBeVisible();
    await page.waitForTimeout(900);
    const product = await page.evaluate(rail);
    // Collapse is a stored preference: put it back for the next test.
    await page.locator('.bsp-sb button[aria-pressed="true"]').first().click();

    // D-484: the product's rail is the prototype's at 0.88.
    expect(Math.abs(product.width - scaled(ref.width)), 'rail width').toBeLessThan(TOLERANCE);
    expect(product.rows.length, 'rail rows').toBeGreaterThan(0);
    const square = ref.rows[0]!;
    for (const [index, row] of product.rows.entries()) {
      for (const key of ['x', 'width', 'height'] as const) {
        expect(
          Math.abs(row[key] - scaled(square[key])),
          `row ${index} · ${key}: product ${row[key]} vs prototype ${square[key]} × 0.88`,
        ).toBeLessThan(TOLERANCE);
      }
    }
    expect(ref.badge).not.toBeNull();
    expect(product.badge, 'a collapsed row with a count').not.toBeNull();
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(
        Math.abs(product.badge![key] - scaled(ref.badge![key])),
        `badge · ${key}: product ${product.badge![key]} vs prototype ${ref.badge![key]} × 0.88`,
      ).toBeLessThan(TOLERANCE);
    }
  });

  test('no screen draws a button, field or select outside the shared system', async ({ page }) => {
    await signIn(page);
    // Every customer screen with controls: the button heights are the
    // prototype's three (`.btn.sm` 32, `.btn` 40, the hero's 48) or a size the
    // prototype itself states inline (Media's `Use` 28, the toast's undo 26).
    // The prototype's own size tokens; the override below must take hold, or
    // the legacy-type rule would be reading the scaled page.
    const sourceSizes = prototypeSizes();
    expect(sourceSizes['--bsp-fs-12'], 'the 12px type token at its source value').toBe('12px');
    const routes = [
      '/overview',
      '/brand-brain',
      '/brand-brain?tab=look',
      '/strategy',
      '/campaigns',
      '/content',
      '/assets',
      '/approvals',
      '/calendar',
      '/analytics',
      '/automations',
      '/automations?new=1',
      '/notes',
      '/members',
      '/settings',
      '/settings/publishing',
      '/integrations',
      '/billing',
      '/content/compose?mode=write',
    ];
    const problems: string[] = [];
    for (const route of routes) {
      await page.goto(`${DASHBOARD_BASE_URL}/en${route}`);
      await page.waitForLoadState('networkidle').catch(() => undefined);
      // D-484: the button heights are the prototype's at 0.88. The legacy-type
      // rule is checked on the SOURCE size: on screen the 11px floor draws the
      // prototype's 12px and anything smaller alike, so the page is measured
      // with every size token at the prototype's own value (`prototypeSizes`),
      // the 12px limit exactly as before, and then put back.
      const limits = {
        sourceSizes,
        heights: [26, 28, 32, 40, 48].map((height) => scaled(height)),
      };
      const found = await page.evaluate((limits) => {
        const visible = (el: HTMLElement) =>
          el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
        const out: string[] = [];
        // The retired inline button: a filled control set in 9–11px type. The
        // prototype's only filled controls under 12px are the calendar's post
        // chips (`.calchip`, 11px), which are cards, not buttons, and its ★
        // holiday chip (`font-size: 10.5px; background: #fff6d6`).
        const root = document.documentElement.style;
        for (const [name, value] of Object.entries(limits.sourceSizes)) {
          root.setProperty(name, value, 'important');
        }
        const twelve = getComputedStyle(document.documentElement).getPropertyValue('--bsp-fs-12');
        if (twelve.trim() !== '12px')
          out.push(`source sizes did not apply: --bsp-fs-12 is ${twelve}`);
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>('.bsp-frame button, .bsp-frame a'),
        )) {
          if (
            !visible(el) ||
            el.classList.contains('bsp-calchip') ||
            el.classList.contains('bsp-cal-hol')
          ) {
            continue;
          }
          const cs = getComputedStyle(el);
          const filled =
            cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
          if (filled && parseFloat(cs.fontSize) < 12) {
            out.push(
              `legacy control "${(el.textContent ?? '').trim().slice(0, 30)}" at ${cs.fontSize} (source size)`,
            );
          }
        }
        for (const name of Object.keys(limits.sourceSizes)) root.removeProperty(name);
        // `offsetHeight` is a whole pixel; a scaled height may be a half one.
        const shared = (height: number) => limits.heights.some((h) => Math.abs(h - height) <= 0.5);
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('.bsp-btn'))) {
          if (visible(el) && !shared(el.offsetHeight)) {
            out.push(
              `button "${(el.textContent ?? '').trim().slice(0, 30)}" is ${el.offsetHeight}px`,
            );
          }
        }
        for (const el of Array.from(
          document.querySelectorAll<HTMLSelectElement>('.bsp-frame select'),
        )) {
          if (!visible(el)) continue;
          const cs = getComputedStyle(el);
          if (!cs.backgroundImage.includes('svg')) {
            out.push(`select "${el.getAttribute('data-testid') ?? el.name}" has no chevron`);
          }
        }
        return out;
      }, limits);
      problems.push(...found.map((problem) => `${route}: ${problem}`));
    }
    expect(problems).toEqual([]);
  });
});
