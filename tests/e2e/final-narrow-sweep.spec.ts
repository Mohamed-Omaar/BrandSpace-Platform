import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { inlineEndOverhang } from './overflow';

/**
 * FINAL REVIEW (owner, item 8) — BELOW 768 PX: A SANITY PASS, NOT A PHONE LAYOUT.
 *
 * The phone layout itself is post-launch (D-468 (b)); this proves only that
 * nothing is broken at 375 and 414 px, in English and Arabic, on every
 * signed-in customer screen and on the entry screens:
 *
 *   - nothing sticks out past the inline end (`inlineEndOverhang`: a box that
 *     scrolls inside its own container is allowed, the page scrolling sideways
 *     is not), so nothing is cut off or out of reach;
 *   - the top bar's controls do not overlap one another;
 *   - the Copilot button — docked in the top bar below 768 px (Fix PR 2c) —
 *     covers no other control and no text.
 *
 * With `BRANDSPACE_NARROW_SHOTS=<dir>` set it also saves one full-page image
 * per screen, which is how the review's 375/414 screenshots were made.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

const SCREENS = [
  '/overview',
  '/analytics',
  '/intelligence',
  '/brand-brain',
  '/copilot',
  '/automations',
  '/approvals',
  '/calendar',
  '/content',
  '/content/compose',
  '/campaigns',
  '/assets',
  '/creative',
  '/strategy',
  '/notifications',
  '/notes',
  '/integrations',
  '/publishing',
  '/members',
  '/permissions',
  '/activity',
  '/settings',
  '/plan',
  '/workspaces',
] as const;

const ENTRY = ['/sign-in', '/sign-up', '/reset'] as const;

const WIDTHS = [375, 414] as const;
const SHOTS = process.env['BRANDSPACE_NARROW_SHOTS'];

async function signIn(page: Page, locale: string): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

/** Overlaps on screen: the top bar's controls, and the Copilot button against everything. */
async function overlaps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.width > 1 &&
        box.height > 1 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) > 0.05
      );
    };
    const name = (element: Element) =>
      (element as HTMLElement).dataset['testid'] ??
      `${element.tagName.toLowerCase()}.${(element as HTMLElement).className.toString().split(' ')[0] ?? ''}`;
    const cross = (a: DOMRect, b: DOMRect) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    const found: string[] = [];

    // The top bar's own controls.
    const bar = document.querySelector('header.bs-topbar');
    if (bar) {
      const controls = Array.from(
        bar.querySelectorAll('a[href], button, input, select, [role="button"]'),
      ).filter(
        (element) =>
          visible(element) &&
          !Array.from(bar.querySelectorAll('a[href], button, input, select, [role="button"]')).some(
            (other) => other !== element && other.contains(element),
          ),
      );
      for (let i = 0; i < controls.length; i += 1) {
        for (let j = i + 1; j < controls.length; j += 1) {
          const a = controls[i] as Element;
          const b = controls[j] as Element;
          if (cross(a.getBoundingClientRect(), b.getBoundingClientRect())) {
            found.push(`top bar: ${name(a)} overlaps ${name(b)}`);
          }
        }
      }
    }

    // The Copilot button against every other control and every piece of text.
    const fab = document.querySelector('.bsp-fab');
    if (fab && visible(fab)) {
      const at = fab.getBoundingClientRect();
      const candidates = Array.from(
        document.querySelectorAll(
          'a[href], button, input, select, textarea, [role="button"], h1, h2, h3, p, td, th, li, label',
        ),
      ).filter(
        (element) =>
          element !== fab &&
          !fab.contains(element) &&
          !element.contains(fab) &&
          visible(element) &&
          // Only what is drawn on top of nothing else: the page's own stacking.
          getComputedStyle(element).position !== 'fixed',
      );
      for (const element of candidates) {
        if (cross(at, element.getBoundingClientRect())) {
          found.push(`Copilot button covers ${name(element)}`);
        }
      }
    }
    /*
     * A control spilling out of the box it is drawn in: the nearest ancestor
     * that paints a box (a border or a background) must hold it. Inside a
     * box that scrolls, it may run on (it scrolls); inside one that clips
     * without scrolling, it is cut off; inside a visible one, it spills.
     */
    const paints = (element: Element) => {
      const style = getComputedStyle(element);
      return (
        parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth) > 0 ||
        (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent')
      );
    };
    for (const control of Array.from(
      document.querySelectorAll(
        'main a[href], main button, main input, main select, main textarea',
      ),
    )) {
      if (!visible(control)) continue;
      const style = getComputedStyle(control);
      if (style.position === 'fixed' || style.position === 'absolute') continue;
      const at = control.getBoundingClientRect();
      if (at.width <= 2 || at.height <= 2) continue;
      let box = control.parentElement;
      let scrolls = false;
      while (box && box !== document.body) {
        const overflow = getComputedStyle(box).overflowX;
        if (overflow === 'auto' || overflow === 'scroll') {
          scrolls = true;
          break;
        }
        if (paints(box)) break;
        box = box.parentElement;
      }
      if (!box || box === document.body || scrolls) continue;
      const frame = box.getBoundingClientRect();
      const out = Math.max(frame.left - at.left, at.right - frame.right);
      if (out > 1) {
        const clipped = getComputedStyle(box).overflowX !== 'visible';
        found.push(
          `${name(control)} ${clipped ? 'is cut off by' : 'spills out of'} ${name(box)} by ${Math.round(out)}px`,
        );
      }
    }
    return found;
  });
}

for (const locale of ['en', 'ar'] as const) {
  for (const width of WIDTHS) {
    test(`below 768 px: every screen holds together at ${width} px (${locale})`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'the test sets its own phone widths');
      test.setTimeout(600_000);
      await page.setViewportSize({ width, height: 844 });
      const problems: string[] = [];
      const check = async (route: string) => {
        const response = await page.goto(`${DASHBOARD_BASE_URL}/${locale}${route}`);
        expect(response?.status() ?? 0, route).toBeLessThan(400);
        await page.waitForLoadState('networkidle');
        const overhang = await inlineEndOverhang(page);
        if (overhang.px > 1)
          problems.push(`${route}: ${overhang.px}px past the edge (${overhang.offender})`);
        for (const overlap of await overlaps(page)) problems.push(`${route}: ${overlap}`);
        if (SHOTS) {
          mkdirSync(SHOTS, { recursive: true });
          await page.screenshot({
            path: path.join(SHOTS, `${locale}-${width}-${route.slice(1).replace(/\//g, '_')}.png`),
            fullPage: true,
          });
        }
      };

      // The entry screens, signed out.
      for (const route of ENTRY) await check(route);

      await signIn(page, locale);
      for (const route of SCREENS) await check(route);

      expect(problems, problems.join('\n')).toEqual([]);
    });
  }
}
