import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { createFreshWorkspace, freshSignUp } from './fresh-signup';
import { signIn } from './own-workspace';
import { PROTOTYPE, prototypeFile, serveFonts } from './prototype-runtime';
import { scaled, scaledEntry, scaledEntryType, scaledType } from './scale';

/**
 * ROUND 6 (item 5) — THE ENTRY SCREENS, THE WIZARD AND THE SHELL ARE THE
 * PROTOTYPE'S SIZE AT EVERY COMMON SCREEN, NOT ONLY AT 1440×900.
 *
 * The parity pairs matched at 1440×900 and the owner saw a bigger card at
 * 1920×1080 (a per-site browser zoom, it turned out). Nothing should scale
 * with the window: at 1280×720, 1366×768, 1536×864, 1920×1080 and 2560×1440
 * the sign-in and sign-up cards, every onboarding step and the app shell are
 * measured on both sides — the vendored prototype opened as it is, the
 * product on its own screens — and must agree. Card heights are not compared
 * (the copy differs); widths, padding, heading size, field and button heights
 * and the shell's rail, item and title are.
 *
 * The wizard's card also never outgrows the prototype's: 836px, its 900px
 * stage less the 32px padding each side.
 */

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const;
const TOLERANCE = 1;
// D-484 amended: the prototype's 836px card at the entry screens' 0.80.
const WIZARD_MAX = scaledEntry(836);

interface Card {
  readonly width: number;
  readonly height: number;
  readonly padTop: number;
  readonly padStart: number;
  readonly heading: number;
  readonly field: number | null;
  readonly button: number | null;
}

const PRIMARY =
  /^(Sign in|Create account|Continue|Create my workspace|Create workspace|Finish|Go to|Start)/;

async function card(page: Page, selector: string): Promise<Card> {
  const found = await page.evaluate(
    ({ selector, primary }) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const h1 = el.querySelector('h1');
      const field = Array.from(el.querySelectorAll<HTMLElement>('input, select, textarea')).find(
        (x) =>
          !['hidden', 'checkbox', 'radio'].includes((x as HTMLInputElement).type) &&
          x.getBoundingClientRect().height > 0,
      );
      const button = Array.from(el.querySelectorAll<HTMLElement>('button')).filter(
        (x) =>
          new RegExp(primary).test((x.textContent ?? '').trim()) &&
          x.getBoundingClientRect().width > 80,
      );
      return {
        width: box.width,
        height: box.height,
        padTop: parseFloat(cs.paddingTop),
        padStart: parseFloat(cs.paddingInlineStart),
        heading: h1 ? parseFloat(getComputedStyle(h1).fontSize) : 0,
        field: field ? field.getBoundingClientRect().height : null,
        // The primary action is the tallest match: a "Create account" text link
        // in the same card matches the words too.
        button:
          button.length > 0
            ? Math.max(...button.map((x) => x.getBoundingClientRect().height))
            : null,
      };
    },
    { selector, primary: PRIMARY.source },
  );
  expect(found, `no "${selector}" on the page`).not.toBeNull();
  return found as Card;
}

function same(product: Card, reference: Card, label: string) {
  const near = (a: number, b: number, what: string) =>
    expect(Math.abs(a - b), `${label}: ${what} ${a} vs the prototype's ${b}`).toBeLessThanOrEqual(
      TOLERANCE,
    );
  // D-484 amended: an entry screen is the prototype at 0.80 (`scale.ts`).
  near(product.width, scaledEntry(reference.width), 'card width');
  near(product.padTop, scaledEntry(reference.padTop), 'card padding (top)');
  near(product.padStart, scaledEntry(reference.padStart), 'card padding (start)');
  expect(product.heading, `${label}: heading size`).toBe(scaledEntryType(reference.heading));
  if (product.field !== null && reference.field !== null) {
    near(product.field, scaledEntry(reference.field), 'field height');
  }
  if (product.button !== null && reference.button !== null) {
    near(product.button, scaledEntry(reference.button), 'button height');
  }
}

/** Measure one screen on both sides at every viewport. */
async function atEveryViewport(
  proto: Page,
  product: Page,
  selectors: { readonly proto: string; readonly product: string },
  label: string,
  extra?: (card: Card, viewport: (typeof VIEWPORTS)[number]) => void,
) {
  for (const viewport of VIEWPORTS) {
    await proto.setViewportSize(viewport);
    await product.setViewportSize(viewport);
    await product.waitForTimeout(150);
    const reference = await card(proto, selectors.proto);
    const measured = await card(product, selectors.product);
    same(measured, reference, `${label} at ${viewport.width}×${viewport.height}`);
    extra?.(measured, viewport);
  }
}

test.describe('round 6 · the prototype’s size at five viewports', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop sizes; the phone layout is post-launch');

  test('sign-in, sign-up and every onboarding step', async ({ page, browser }) => {
    test.setTimeout(240_000);
    const proto = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await serveFonts(proto);
    await proto.goto(prototypeFile('Auth.dc.html'), { waitUntil: 'networkidle' });
    const AUTH = { proto: 'div[style*="width: 540px"]', product: '.bsp-auth-card' };
    const WIZARD = { proto: 'div[style*="width: 900px"]', product: '.bsp-wz' };

    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
    await atEveryViewport(proto, page, AUTH, 'sign-in');

    await proto
      .getByRole('button', { name: /^Create account$/ })
      .first()
      .click();
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-up`);
    await atEveryViewport(proto, page, AUTH, 'sign-up');

    // The prototype's wizard: the account made, the link "opened".
    await proto.setViewportSize({ width: 1440, height: 900 });
    await proto.getByRole('checkbox').first().check();
    await proto
      .getByRole('button', { name: /^Create account$/ })
      .last()
      .click();
    await proto.getByRole('button', { name: /^I opened the link in the email$/ }).click();
    const nextStep = async () => {
      await proto.setViewportSize({ width: 1440, height: 900 });
      await proto
        .getByRole('button', { name: /^(Continue|Finish|Go to my dashboard|Start)/ })
        .first()
        .click();
    };
    const capped = (measured: Card, viewport: (typeof VIEWPORTS)[number]) =>
      expect(
        measured.height,
        `wizard card at ${viewport.width}×${viewport.height}`,
      ).toBeLessThanOrEqual(WIZARD_MAX + TOLERANCE);

    await page.setViewportSize({ width: 1440, height: 900 });
    await freshSignUp(page);
    await atEveryViewport(proto, page, WIZARD, 'onboarding 1 (business)', capped);

    await nextStep();
    await page.setViewportSize({ width: 1440, height: 900 });
    await createFreshWorkspace(page);
    await atEveryViewport(proto, page, WIZARD, 'onboarding 2 (brand)', capped);

    await nextStep();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.fill('[data-testid="setup-brand-name"]', 'Viewport Cafe');
    await page.getByTestId('setup-create-brand').click();
    await page.waitForURL(/step=learn/);
    await atEveryViewport(proto, page, WIZARD, 'onboarding 3 (teach)', capped);

    await nextStep();
    await page.goto(`${DASHBOARD_BASE_URL}/en/onboarding?step=connect`);
    await atEveryViewport(proto, page, WIZARD, 'onboarding 4 (accounts)', capped);

    await nextStep();
    await page.goto(`${DASHBOARD_BASE_URL}/en/onboarding?step=goal`);
    await atEveryViewport(proto, page, WIZARD, 'onboarding 5 (goal)', capped);

    // The cap itself, wherever a step scrolls inside its card: at a 1080px
    // window it used to allow 1016px.
    await page.setViewportSize({ width: 1920, height: 1080 });
    const cap = await page.evaluate(() => {
      // Inside the entry layout, where the wizard always is (its 0.80 sizes).
      const host = document.createElement('div');
      host.className = 'bsp-auth';
      const probe = document.createElement('div');
      probe.className = 'bsp-wz bsp-wz-solo';
      probe.innerHTML = '<div class="bsp-wz-scroll"></div>';
      host.append(probe);
      document.body.append(host);
      const value = getComputedStyle(probe).maxHeight;
      host.remove();
      return value;
    });
    expect(parseFloat(cap)).toBeLessThanOrEqual(WIZARD_MAX);
    await proto.close();
  });

  test('the app shell: rail, items, title and the Create button', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const proto = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await serveFonts(proto);
    await signIn(page);
    const shell = (target: Page, product: boolean) =>
      target.evaluate((product) => {
        const nav = document.querySelector<HTMLElement>(product ? '.bsp-nav' : '.nav');
        let rail: HTMLElement | null = nav;
        while (rail && rail.getBoundingClientRect().height < 560) rail = rail.parentElement;
        const h1 = document.querySelector('h1');
        const create = Array.from(document.querySelectorAll('button')).find(
          (x) => /Create/.test(x.textContent ?? '') && x.getBoundingClientRect().width > 60,
        );
        return {
          rail: rail?.getBoundingClientRect().width ?? 0,
          item: nav?.getBoundingClientRect().height ?? 0,
          title: h1 ? parseFloat(getComputedStyle(h1).fontSize) : 0,
          create: create?.getBoundingClientRect().height ?? 0,
        };
      }, product);
    for (const viewport of VIEWPORTS) {
      await proto.setViewportSize(viewport);
      await page.setViewportSize(viewport);
      await proto.goto(PROTOTYPE, { waitUntil: 'networkidle' });
      await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
      await expect(page.getByTestId('sidebar')).toBeVisible();
      const reference = await shell(proto, false);
      const measured = await shell(page, true);
      const at = `${viewport.width}×${viewport.height}`;
      // D-484: the product is the prototype at 0.88 (`scale.ts`).
      expect(
        Math.abs(measured.rail - scaled(reference.rail)),
        `rail width at ${at}`,
      ).toBeLessThanOrEqual(TOLERANCE);
      expect(
        Math.abs(measured.item - scaled(reference.item)),
        `rail item at ${at}`,
      ).toBeLessThanOrEqual(TOLERANCE);
      expect(measured.title, `page title at ${at}`).toBe(scaledType(reference.title));
      expect(
        Math.abs(measured.create - scaled(reference.create)),
        `Create button at ${at}`,
      ).toBeLessThanOrEqual(TOLERANCE);
    }
    await proto.close();
  });
});
