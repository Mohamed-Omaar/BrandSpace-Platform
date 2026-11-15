import { appendFileSync } from 'node:fs';
import { test, type Browser, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from '../e2e/apps';
import { signIn } from '../e2e/own-workspace';

/**
 * B2 (owner, 2026-11-14) — BEFORE / AFTER, MEASURED THE SAME WAY ON BOTH BUILDS.
 *
 *   BRANDSPACE_PERF=1 PERF_OUT=<file> npx playwright test --project=perf --grep B2
 *
 * One JSON line per measurement in PERF_OUT. Opt-in, never in CI.
 */

const OUT = process.env['PERF_OUT'] ?? 'b2-perf.jsonl';
const record = (name: string, data: Record<string, unknown>) =>
  appendFileSync(OUT, `${JSON.stringify({ name, at: new Date().toISOString(), ...data })}\n`);

const PAGES = ['overview', 'assets', 'brand-brain', 'copilot', 'content'] as const;

/** Script bytes a page downloads with an empty cache (a fresh browser context). */
async function scriptBytes(browser: Browser, locale: 'en' | 'ar', path: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, locale);
  // A second fresh context, carrying the signed-in cookies, so its cache is empty.
  const cookies = await context.cookies();
  await context.close();
  const cold = await browser.newContext();
  await cold.addCookies(cookies);
  const fresh = await cold.newPage();
  await fresh.goto(`${DASHBOARD_BASE_URL}/${locale}/${path}`);
  await fresh.waitForLoadState('networkidle');
  const bytes = await fresh.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((entry) => (entry as PerformanceResourceTiming).initiatorType === 'script')
      .reduce(
        (sum, entry) => {
          const timing = entry as PerformanceResourceTiming;
          return {
            transfer: sum.transfer + timing.transferSize,
            decoded: sum.decoded + timing.decodedBodySize,
          };
        },
        { transfer: 0, decoded: 0 },
      ),
  );
  await cold.close();
  return bytes;
}

async function layoutShift(page: Page, path: string): Promise<number> {
  await page.goto(`${DASHBOARD_BASE_URL}${path}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2_000);
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let total = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as (PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
          })[]) {
            if (!entry.hadRecentInput) total += entry.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => resolve(Number(total.toFixed(4))), 250);
      }),
  );
}

test.setTimeout(15 * 60_000);

test('B2: script downloaded per page, empty cache', async ({ browser }) => {
  for (const locale of ['en', 'ar'] as const) {
    for (const path of PAGES) {
      record(`js:${locale}:${path}`, await scriptBytes(browser, locale, path));
    }
  }
});

test('B2: a click to another page — first visible answer, and the page', async ({ page }) => {
  await signIn(page, 'en');
  const runs: { firstAnswerMs: number; pageMs: number }[] = [];
  for (let round = 0; round < 5; round += 1) {
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await page.waitForLoadState('networkidle');
    const timing = await page.evaluate(
      () =>
        new Promise<{ firstAnswerMs: number; pageMs: number }>((resolve) => {
          const before = document.querySelector('[data-testid="heading"]')?.textContent;
          const start = performance.now();
          let first = 0;
          const check = () => {
            const now = performance.now() - start;
            const loading = document.querySelector('[data-testid="page-loading"]');
            const heading = document.querySelector('[data-testid="heading"]')?.textContent;
            const arrived = heading !== undefined && heading !== before && !loading;
            if (!first && (loading || arrived)) first = now;
            if (arrived) {
              resolve({ firstAnswerMs: Math.round(first), pageMs: Math.round(now) });
              return;
            }
            requestAnimationFrame(check);
          };
          (document.querySelector('[data-testid="nav-assets"]') as HTMLElement).click();
          requestAnimationFrame(check);
        }),
    );
    runs.push(timing);
  }
  const median = (key: 'firstAnswerMs' | 'pageMs') =>
    [...runs.map((run) => run[key])].sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  record('click:overview->assets', {
    firstAnswerMsMedian: median('firstAnswerMs'),
    pageMsMedian: median('pageMs'),
    runs,
  });
});

test('B2: layout shift per page, pictures 1.5 s late', async ({ page }) => {
  await page.route('**/assets/file/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  for (const locale of ['en', 'ar'] as const) {
    await signIn(page, locale);
    const shifts: Record<string, number> = {};
    for (const path of [...PAGES, 'calendar', 'analytics', 'approvals', 'publishing']) {
      shifts[path] = await layoutShift(page, `/${locale}/${path}`);
    }
    record(`cls:${locale}`, shifts);
  }
});

test('B2: the home hero, paints per second', async ({ page }) => {
  await page.addInitScript(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    (window as unknown as { __paints: number }).__paints = 0;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      (window as unknown as { __paints: number }).__paints += 1;
      return clear.apply(this, args);
    };
  });
  await signIn(page, 'en');
  await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
  await page.waitForLoadState('networkidle');
  const paints = () => page.evaluate(() => (window as unknown as { __paints: number }).__paints);
  const per = async (ms: number) => {
    const before = await paints();
    await page.waitForTimeout(ms);
    return Math.round(((await paints()) - before) / (ms / 1_000));
  };
  const onScreen = await per(3_000);
  await page.getByTestId('overview-hero').evaluate((element) => {
    const spacer = document.createElement('div');
    spacer.style.blockSize = '400vh';
    element.parentElement?.append(spacer);
    let box: HTMLElement | null = element.parentElement;
    while (
      box &&
      !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))
    ) {
      box = box.parentElement;
    }
    (box ?? document.scrollingElement ?? document.documentElement).scrollTop = 1e6;
    window.scrollTo(0, 1e6);
  });
  await page.waitForTimeout(300);
  const offScreen = await per(3_000);
  record('hero', { paintsPerSecondOnScreen: onScreen, paintsPerSecondOffScreen: offScreen });
});
