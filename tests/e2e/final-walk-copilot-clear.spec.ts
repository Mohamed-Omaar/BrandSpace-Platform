import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * FINAL WALK (owner, review of #83, must-check 1) — THE FLOATING COPILOT
 * BUTTON NEVER COVERS TEXT, DATA OR A CONTROL, AT EITHER DESKTOP SIZE.
 *
 * At 1536x864 it sat on the end of the Calendar's last line ("…The time stays
 * the same.") on the first screen: the page's end padding cleared it only once
 * the page was scrolled to its end. The shell now keeps a lane for the button
 * below the scroll area, so nothing — no piece of text, no control, no image —
 * may lie under it, with the page at rest AND with every scroller at its end,
 * on every signed-in customer screen, at 1536x864, 1920x1080 and 1024x768, in
 * English and Arabic. The workspace is the seeded one, whose AI (the
 * development double) is on, so the button is shown and the screens carry
 * data.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

const SCREENS = [
  '/overview',
  '/analytics',
  '/intelligence',
  '/brand-brain',
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

const SIZES = [
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1024, height: 768 },
] as const;

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

/** What the floating Copilot covers, at rest or once every scroller is at its end. */
async function covered(
  page: Page,
  at: 'rest' | 'end',
): Promise<{ shown: boolean; under: string[] }> {
  return page.evaluate((position) => {
    if (position === 'end') {
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
        const style = getComputedStyle(element);
        if (
          /(auto|scroll)/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 1
        ) {
          element.scrollTop = element.scrollHeight;
        }
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
    }
    const fab = document.querySelector<HTMLElement>('.bsp-fab');
    if (!fab || !fab.checkVisibility({ visibilityProperty: true }))
      return { shown: false, under: [] };
    const at = fab.getBoundingClientRect();
    // What is drawn of a box: its rect cut by every ancestor that clips its
    // overflow (a scroller hides what has scrolled out of it).
    const drawn = (element: Element, box: DOMRect) => {
      let [left, top, right, bottom] = [box.left, box.top, box.right, box.bottom];
      for (let up = element.parentElement; up; up = up.parentElement) {
        if (getComputedStyle(up).overflowY === 'visible') continue;
        const clip = up.getBoundingClientRect();
        left = Math.max(left, clip.left);
        top = Math.max(top, clip.top);
        right = Math.min(right, clip.right);
        bottom = Math.min(bottom, clip.bottom);
      }
      return { left, top, right, bottom };
    };
    const hit = (element: Element, box: DOMRect) => {
      const seenBox = drawn(element, box);
      return (
        Math.min(at.right, seenBox.right) - Math.max(at.left, seenBox.left) > 1 &&
        Math.min(at.bottom, seenBox.bottom) - Math.max(at.top, seenBox.top) > 1
      );
    };
    const seen = (element: Element) =>
      element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    const under: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? '';
      if (!text || fab.contains(node)) continue;
      const parent = node.parentElement;
      if (!parent || !seen(parent)) continue;
      // Something drawn on top of the button (a dialog, a toast) is not under it.
      if (Number(getComputedStyle(parent).zIndex) > 36) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (Array.from(range.getClientRects()).some((box) => hit(parent, box)))
        under.push(`text "${text.slice(0, 50)}"`);
    }
    for (const element of Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, [role="button"], img, svg, canvas',
      ),
    )) {
      if (element === fab || fab.contains(element) || element.contains(fab)) continue;
      if (!seen(element)) continue;
      const box = element.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      if (hit(element, box)) {
        under.push(
          `${element.tagName.toLowerCase()} ${element.dataset['testid'] ?? element.getAttribute('aria-label') ?? ''}`.trim(),
        );
      }
    }
    return { shown: true, under };
  }, at);
}

for (const locale of ['en', 'ar'] as const) {
  for (const size of SIZES) {
    test(`the floating Copilot covers nothing at ${size.width}x${size.height} (${locale})`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'the test sets its own desktop sizes');
      test.setTimeout(600_000);
      await page.setViewportSize(size);
      await signIn(page, locale);
      const problems: string[] = [];
      let shownSomewhere = false;
      for (const route of SCREENS) {
        const response = await page.goto(`${DASHBOARD_BASE_URL}/${locale}${route}`);
        expect(response?.status() ?? 0, route).toBeLessThan(400);
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => document.fonts.ready);
        for (const at of ['rest', 'end'] as const) {
          const result = await covered(page, at);
          shownSomewhere ||= result.shown;
          for (const item of result.under) problems.push(`${route} (${at}): covers ${item}`);
        }
      }
      // The button is there to be checked: AI is on in the seeded workspace.
      expect(shownSomewhere, 'the floating Copilot is shown somewhere').toBe(true);
      expect(problems, problems.join('\n')).toEqual([]);
    });
  }
}
