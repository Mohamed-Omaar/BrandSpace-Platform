import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { expect, test, type Page, type Request } from '@playwright/test';
import { DASHBOARD_BASE_URL } from '../e2e/apps';
import { signIn } from '../e2e/own-workspace';
import { E2E_CREDENTIALS_FILE } from '../e2e/env';
import { withPlatformPrisma } from '../e2e/platform-prisma';

/**
 * B1 — WHAT A PAGE COSTS WHILE IT SITS THERE.
 *
 *   - requests in 60 s: an idle page; Media with one file still being checked;
 *     the composer after typing a few words;
 *   - server time of each request the page makes on its own;
 *   - SQL statements for one Media render and for its hover prefetch
 *     (`pg_stat_statements`, local database only);
 *   - web vitals: LCP, CLS and long tasks.
 *
 * Each result is one JSON line appended to $PERF_OUT.
 */

const OUT = process.env['PERF_OUT'] ?? '/tmp/perf.jsonl';
const record = (name: string, data: Record<string, unknown>) =>
  appendFileSync(OUT, `${JSON.stringify({ name, at: new Date().toISOString(), ...data })}\n`);

function kind(request: Request): string {
  const url = new URL(request.url());
  const headers = request.headers();
  if (url.pathname.startsWith('/_next/static')) return 'static';
  if (headers['next-action']) return 'server-action';
  if (headers['next-router-prefetch']) return 'prefetch';
  if (headers['rsc'] === '1' || url.searchParams.has('_rsc')) return 'rsc-refresh';
  if (url.pathname.includes('/assets/file/')) return 'image';
  if (url.pathname.startsWith('/api/')) return `api:${url.pathname}`;
  return `${request.resourceType()}:${request.method()} ${url.pathname}`;
}

async function watch(page: Page, ms: number) {
  const seen: { kind: string; ms: number | null }[] = [];
  const onDone = (request: Request) => {
    const timing = request.timing();
    seen.push({
      kind: kind(request),
      ms: timing.responseEnd > 0 ? Math.round(timing.responseEnd - timing.requestStart) : null,
    });
  };
  page.on('requestfinished', onDone);
  await page.waitForTimeout(ms);
  page.off('requestfinished', onDone);
  const byKind: Record<string, { count: number; medianMs: number | null }> = {};
  for (const entry of seen) {
    const bucket = (byKind[entry.kind] ??= { count: 0, medianMs: null });
    bucket.count += 1;
  }
  for (const [name, bucket] of Object.entries(byKind)) {
    const times = seen
      .filter((entry) => entry.kind === name && entry.ms !== null)
      .map((entry) => entry.ms!)
      .sort((a, b) => a - b);
    bucket.medianMs = times.length > 0 ? times[Math.floor(times.length / 2)]! : null;
  }
  return { total: seen.filter((entry) => entry.kind !== 'static').length, byKind };
}

/** Statements the app ran, from a reset to now (local database only). */
const sql = (query: string) =>
  execFileSync('su', ['postgres', '-c', `psql -h /tmp -d brandspace_test -Atc "${query}"`], {
    encoding: 'utf8',
  }).trim();
const OURS =
  "join pg_roles r on r.oid = s.userid where r.rolname in ('brandspace_app','brandspace_platform') and s.dbid = (select oid from pg_database where datname = current_database())";
function statements(): number {
  return Number(sql(`select coalesce(sum(calls),0) from pg_stat_statements s ${OURS}`));
}
/** The busiest statements since the last reset (to find where noise comes from). */
function busiest(): string {
  return sql(
    `select calls || ' ' || left(regexp_replace(query, '\\s+', ' ', 'g'), 120) from pg_stat_statements s ${OURS} order by calls desc limit 8`,
  );
}
function resetStatements(): void {
  execFileSync('su', [
    'postgres',
    '-c',
    'psql -h /tmp -d brandspace_test -Atc "select pg_stat_statements_reset()"',
  ]);
}

async function vitals(page: Page) {
  return page.evaluate(
    () =>
      new Promise<Record<string, number>>((resolve) => {
        let lcp = 0;
        let cls = 0;
        let longTasks = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) lcp = entry.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as {
            value: number;
            hadRecentInput: boolean;
          }[]) {
            if (!entry.hadRecentInput) cls += entry.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks += entry.duration;
        }).observe({ type: 'longtask', buffered: true });
        setTimeout(
          () =>
            resolve({
              lcpMs: Math.round(lcp),
              cls: Number(cls.toFixed(3)),
              longTaskMs: Math.round(longTasks),
            }),
          3_000,
        );
      }),
  );
}

test.setTimeout(10 * 60_000);

test('idle pages: requests in 60 s', async ({ page }) => {
  await signIn(page);
  for (const path of ['overview', 'assets', 'brand-brain']) {
    await page.goto(`${DASHBOARD_BASE_URL}/en/${path}`);
    await page.waitForLoadState('networkidle');
    const idle = await watch(page, 60_000);
    // Web vitals vary by ±100 ms from load to load: three more fresh loads,
    // and the median is reported beside the first.
    const loads: Record<string, number>[] = [await vitals(page)];
    for (let i = 0; i < 3; i += 1) {
      await page.goto(`${DASHBOARD_BASE_URL}/en/${path}`);
      await page.waitForLoadState('networkidle');
      loads.push(await vitals(page));
    }
    const median = (key: string) =>
      [...loads.map((load) => load[key] ?? 0)].sort((a, b) => a - b)[Math.floor(loads.length / 2)];
    record(`idle:${path}`, {
      ...idle,
      vitals: loads[0],
      vitalsMedianOf4: {
        lcpMs: median('lcpMs'),
        cls: median('cls'),
        longTaskMs: median('longTaskMs'),
      },
      lcpAll: loads.map((load) => load['lcpMs']),
    });
  }
});

test('Media with one file still being checked: requests in 60 s', async ({ page }) => {
  await signIn(page);
  const { customer } = JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as {
    customer: { workspaceId: string };
  };
  const asset = await withPlatformPrisma((prisma) =>
    prisma.asset.findFirstOrThrow({
      // The signed-in person's own workspace, the newest image: the first card.
      where: { workspaceId: customer.workspaceId, status: 'READY', deletedAt: null, kind: 'IMAGE' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, scanStatus: true },
    }),
  );
  await withPlatformPrisma((prisma) =>
    prisma.asset.update({
      where: { id: asset.id },
      data: { status: 'PROCESSING', scanStatus: 'PENDING' },
    }),
  );
  try {
    await page.goto(`${DASHBOARD_BASE_URL}/en/assets`);
    await page.waitForLoadState('networkidle');
    record('pending:assets', await watch(page, 60_000));
    // The same page, hidden: what a forgotten tab costs.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    record('pending:assets:hidden', await watch(page, 30_000));
  } finally {
    await withPlatformPrisma((prisma) =>
      prisma.asset.update({
        where: { id: asset.id },
        data: { status: asset.status, scanStatus: asset.scanStatus },
      }),
    );
  }
});

test('composer: typing a few words, then 60 s', async ({ page }) => {
  await signIn(page);
  await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose`);
  await page.waitForLoadState('networkidle');
  const { customer } = JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as {
    customer: { workspaceId: string };
  };
  // A draft of the signed-in person's own that saves itself as typed: the one
  // an earlier run already typed into, or else the newest. The run FAILS
  // below unless the words reach the database, so a draft that does not
  // autosave can never pass for a measurement.
  const draft = await withPlatformPrisma(async (prisma) => {
    const where = { workspaceId: customer.workspaceId, status: 'DRAFT' as const, deletedAt: null };
    return (
      (await prisma.contentItem.findFirst({
        where: { ...where, variants: { some: { body: { contains: 'Autumn blend' } } } },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      })) ??
      (await prisma.contentItem.findFirstOrThrow({
        where,
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      }))
    );
  });
  await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${draft.id}`);
  await page.waitForLoadState('networkidle');
  // The caption of the version on screen: the field autosave follows.
  const box = page.locator('textarea[name="body"]:visible').first();
  await box.waitFor();
  const watching = watch(page, 60_000);
  for (const word of ['Autumn', 'blend', 'is', 'back', 'this', 'week']) {
    await box.press('End');
    await box.type(` ${word}`, { delay: 60 });
    await page.waitForTimeout(1_500);
  }
  const result = await watching;
  const marker = `perf ${Date.now()}`;
  // The last words must be SAVED, or this measured nothing.
  await box.press('End');
  await box.type(` ${marker}`, { delay: 30 });
  await expect
    .poll(
      () =>
        withPlatformPrisma((prisma) =>
          prisma.contentVariant.count({
            where: { contentItemId: draft.id, body: { contains: marker } },
          }),
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  record('composer:typing', { ...result, draftId: draft.id, saved: true });
});

test('Media: SQL statements for a render and for its prefetch', async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page);
  /*
   * Other processes share the database (the API's scheduler sweeps automation
   * rules and analytics every few seconds, and pausing it hangs the page), so
   * each step is measured ROUNDS times: the MINIMUM is the page's own cost
   * (noise only adds), the median is shown beside it, and `idle2s` is the
   * noise itself.
   */
  const ROUNDS = 5;
  const runs: Record<string, number[]> = {
    idle2s: [],
    prefetch: [],
    render: [],
    repeat: [],
    oneImage: [],
  };
  let imageRequests = 0;
  let repeatImages = 0;
  const imageStatuses: number[] = [];
  let loaded: Record<string, number> = {};
  for (let round = 0; round < ROUNDS; round += 1) {
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await page.waitForLoadState('networkidle');
    resetStatements();
    await page.waitForTimeout(2_000);
    runs['idle2s']!.push(statements());
    if (process.env['PERF_DEBUG'] === '1') record(`idle-busiest:${round}`, { top: busiest() });
    resetStatements();
    await page.locator(`a[href$="/en/assets"]`).first().hover();
    await page.waitForTimeout(2_000);
    runs['prefetch']!.push(statements());
    resetStatements();
    await page.goto(`${DASHBOARD_BASE_URL}/en/assets`);
    await page.waitForLoadState('networkidle');
    runs['render']!.push(statements());
    imageRequests = await page.evaluate(
      () =>
        performance
          .getEntriesByType('resource')
          .filter((entry) => entry.name.includes('/assets/file/')).length,
    );
    loaded = await page.evaluate(() => {
      const images = [...document.querySelectorAll<HTMLImageElement>('img[src*="/assets/file/"]')];
      return {
        total: images.length,
        loaded: images.filter((img) => img.complete && img.naturalWidth > 0).length,
        lazyNotYet: images.filter((img) => !img.complete).length,
      };
    });
    const firstImage = await page
      .locator('img[src*="/assets/file/"]')
      .first()
      .getAttribute('src')
      .catch(() => null);
    resetStatements();
    await page.reload();
    await page.waitForLoadState('networkidle');
    runs['repeat']!.push(statements());
    repeatImages = await page.evaluate(
      () =>
        performance
          .getEntriesByType('resource')
          .filter(
            (entry) =>
              entry.name.includes('/assets/file/') &&
              (entry as PerformanceResourceTiming).transferSize > 0,
          ).length,
    );
    if (firstImage) {
      // The image route's own cost: the same picture fetched 5 times,
      // statements per fetch.
      const url = new URL(firstImage, page.url()).toString();
      resetStatements();
      const statuses: number[] = [];
      // From inside the page, as the browser asks for it (its session cookie
      // included), bypassing the cache.
      for (let i = 0; i < 5; i += 1) {
        statuses.push(
          await page.evaluate(
            async (address) => (await fetch(address, { cache: 'no-store' })).status,
            url,
          ),
        );
      }
      runs['oneImage']!.push(Math.round(statements() / 5));
      imageStatuses.push(...statuses);
    }
  }
  const summary = Object.fromEntries(
    Object.entries(runs).map(([key, values]) => {
      const sorted = [...values].sort((x, y) => x - y);
      return [
        key,
        {
          min: sorted[0] ?? null,
          median: sorted[Math.floor(sorted.length / 2)] ?? null,
          all: values,
        },
      ];
    }),
  );
  record('assets:sql', {
    statements: summary,
    imageRequestsFirstVisit: imageRequests,
    imageRequestsFromNetworkOnRepeat: repeatImages,
    imageStatuses: [...new Set(imageStatuses)],
    imagesOnPage: loaded,
  });
});
