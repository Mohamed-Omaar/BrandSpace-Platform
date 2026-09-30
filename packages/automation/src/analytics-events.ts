import type { TenantScopedClient } from '@brandspace/database';
import { DUE_EVENT_DEFINITIONS } from './registry';

/**
 * PHASE 2B-3 PR 4 — THE ANALYTICS EVENTS' ARITHMETIC AND THEIR ONE READ PER BRAND.
 *
 * WEEKLY_ENGAGEMENT_DROPPED and POST_TOP_10_PERCENT are judged from stored
 * metric observations, exactly as report §30 defines them:
 *
 *   - ANALYTICS DAYS ARE UTC DAYS. Ingestion buckets DAY observations on UTC
 *     midnights, so the weeks are UTC weeks and are not converted to a
 *     workspace's local days — converting would split a stored day in two.
 *   - ONLY SETTLED DAYS. Platforms revise recent figures for
 *     `analytics.ingestion.refreshWindowDays`; the weeks end that many days
 *     before today, so a number is judged once it has stopped moving.
 *   - ONLY DAY, POST observations. Ingestion stores several granularities of
 *     the same metric; summing them together would count a day several times.
 *
 * THE BRAND'S NUMBERS ARE READ ONCE PER SWEEP, not once per rule: every rule of
 * a brand shares the parameters (they are global configuration), so the
 * scheduler hands every rule of the brand the same result (`SharedReads`). The
 * per-rule loop never issues an analytics query of its own.
 *
 * Integer arithmetic throughout: stored values are `bigint`, and a rate is
 * compared as a fraction by cross-multiplication, never as a float.
 */

const DAY_MS = 86_400_000;
export const ENGAGEMENTS_METRIC = 'engagements';
export const IMPRESSIONS_METRIC = 'impressions';

// ---------------------------------------------------------------------------
// WEEKLY_ENGAGEMENT_DROPPED
// ---------------------------------------------------------------------------

export interface UtcWindow {
  /** Inclusive. */
  readonly start: Date;
  /** Exclusive. */
  readonly end: Date;
}

export interface WeeklyWindows {
  /** The first UTC midnight NOT yet settled: the end of the current week. */
  readonly settledEnd: Date;
  readonly current: UtcWindow;
  readonly prior: UtcWindow;
}

/**
 * The two settled UTC weeks: `end = startOfUtcDay(now) − refreshWindowDays`,
 * current = [end − 7 d, end), prior = [end − 14 d, end − 7 d).
 */
export function weeklyEngagementWindows(now: Date, refreshWindowDays: number): WeeklyWindows {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = today - refreshWindowDays * DAY_MS;
  return {
    settledEnd: new Date(end),
    current: { start: new Date(end - 7 * DAY_MS), end: new Date(end) },
    prior: { start: new Date(end - 14 * DAY_MS), end: new Date(end - 7 * DAY_MS) },
  };
}

/**
 * Did engagement drop? `null` when the prior week is below the configured
 * baseline — too little to judge, so nothing is decided and the rule's memory
 * is left as it was. Otherwise dropped ⇔ current × 1000 ≤ prior × (1000 − 10 ×
 * percent), i.e. at least `weeklyDropPercent` below the week before.
 */
export function weeklyDropVerdict(input: {
  readonly prior: bigint;
  readonly current: bigint;
  readonly minBaseline: number;
}): boolean | null {
  if (input.prior < BigInt(input.minBaseline)) return null;
  const keptPerMille = BigInt(1000 - DUE_EVENT_DEFINITIONS.weeklyDropPercent * 10);
  return input.current * 1000n <= input.prior * keptPerMille;
}

/** One brand's DAY engagements on its POST subjects, summed over each week. */
export async function brandWeeklyEngagement(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly brandId: string;
    readonly windows: WeeklyWindows;
  },
): Promise<{ readonly prior: bigint; readonly current: bigint }> {
  const sum = async (window: UtcWindow): Promise<bigint> => {
    const result = await db.metricObservation.aggregate({
      where: {
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        metricKey: ENGAGEMENTS_METRIC,
        granularity: 'DAY',
        subjectType: 'POST',
        periodStart: { gte: window.start, lt: window.end },
      },
      _sum: { value: true },
    });
    return result._sum.value ?? 0n;
  };
  return { prior: await sum(input.windows.prior), current: await sum(input.windows.current) };
}

// ---------------------------------------------------------------------------
// POST_TOP_10_PERCENT
// ---------------------------------------------------------------------------

export interface RankedPost {
  readonly id: string;
  readonly engagements: bigint;
  readonly impressions: bigint;
  /** The post's EARLIEST publication — what "published after arming" is judged on. */
  readonly firstPublishedAt: Date;
}

/** a's rate compared with b's: positive when a's is higher. Exact, by cross-multiplication. */
function compareRate(
  a: Pick<RankedPost, 'engagements' | 'impressions'>,
  b: Pick<RankedPost, 'engagements' | 'impressions'>,
): number {
  const left = a.engagements * b.impressions;
  const right = b.engagements * a.impressions;
  return left === right ? 0 : left > right ? 1 : -1;
}

/**
 * The top `topPostSharePercent` by pooled engagement rate, nearest rank:
 * k = ceil(share × n / 100), and every post whose rate is at least the k-th
 * highest rate qualifies — ties at the cut-off are all in. Every post must
 * have impressions > 0 (the population's minimum guarantees it).
 */
export function topShareOf<T extends Pick<RankedPost, 'id' | 'engagements' | 'impressions'>>(
  posts: readonly T[],
): readonly T[] {
  if (posts.length === 0) return [];
  const k = Math.ceil((DUE_EVENT_DEFINITIONS.topPostSharePercent * posts.length) / 100);
  const ranked = [...posts].sort((a, b) => compareRate(b, a) || a.id.localeCompare(b.id));
  const cutoff = ranked[k - 1] as T;
  return ranked.filter((post) => compareRate(post, cutoff) >= 0);
}

/**
 * The ranked population of one brand: its posts first published in the last
 * `populationDays` days (their EARLIEST published job inside the window), not
 * deleted or archived, each with its DAY engagements and impressions summed
 * over every reading, kept when impressions reach `minImpressions`. `null` when
 * fewer than `minPopulation` remain — too few to call anything "the top".
 */
export async function brandTopPostPopulation(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly brandId: string;
    readonly since: Date;
    readonly minImpressions: number;
    readonly minPopulation: number;
  },
): Promise<readonly RankedPost[] | null> {
  const scope = { workspaceId: input.workspaceId, brandId: input.brandId };
  const recent = await db.publishJob.findMany({
    where: { ...scope, status: 'PUBLISHED', publishedAt: { gte: input.since } },
    select: { contentItemId: true, publishedAt: true },
  });
  const firstInWindow = new Map<string, Date>();
  for (const job of recent) {
    if (!job.publishedAt) continue;
    const seen = firstInWindow.get(job.contentItemId);
    if (!seen || job.publishedAt < seen) firstInWindow.set(job.contentItemId, job.publishedAt);
  }
  if (firstInWindow.size === 0) return null;

  // A post that was ALREADY published before the window is not a new post.
  const earlier = await db.publishJob.findMany({
    where: {
      ...scope,
      status: 'PUBLISHED',
      contentItemId: { in: [...firstInWindow.keys()] },
      publishedAt: { lt: input.since },
    },
    select: { contentItemId: true },
    distinct: ['contentItemId'],
  });
  for (const job of earlier) firstInWindow.delete(job.contentItemId);

  const live = await db.contentItem.findMany({
    where: {
      ...scope,
      id: { in: [...firstInWindow.keys()] },
      deletedAt: null,
      status: { not: 'ARCHIVED' },
    },
    select: { id: true },
  });
  const ids = live.map((item) => item.id);
  if (ids.length < input.minPopulation) return null;

  const sums = await db.metricObservation.groupBy({
    by: ['contentItemId', 'metricKey'],
    where: {
      ...scope,
      contentItemId: { in: ids },
      metricKey: { in: [ENGAGEMENTS_METRIC, IMPRESSIONS_METRIC] },
      granularity: 'DAY',
      subjectType: 'POST',
    },
    _sum: { value: true },
  });
  const totals = new Map<string, { engagements: bigint; impressions: bigint }>();
  for (const row of sums) {
    if (!row.contentItemId) continue;
    const entry = totals.get(row.contentItemId) ?? { engagements: 0n, impressions: 0n };
    const value = row._sum.value ?? 0n;
    if (row.metricKey === ENGAGEMENTS_METRIC) entry.engagements = value;
    else entry.impressions = value;
    totals.set(row.contentItemId, entry);
  }

  const minImpressions = BigInt(input.minImpressions);
  const population: RankedPost[] = [];
  for (const id of ids) {
    const total = totals.get(id);
    if (!total || total.impressions < minImpressions || total.impressions <= 0n) continue;
    population.push({ id, ...total, firstPublishedAt: firstInWindow.get(id) as Date });
  }
  return population.length < input.minPopulation ? null : population;
}

// ---------------------------------------------------------------------------
// One read per brand per sweep
// ---------------------------------------------------------------------------

/**
 * Results computed once in a sweep and handed to every rule that needs them.
 * Created by the scheduler for ONE sweep and dropped with it: a cache of what
 * this pass already read, never state carried between passes — correctness
 * still lives in the database (keys, cursors, compare-and-set).
 */
export type SharedReads = Map<string, Promise<unknown>>;

export function readOnce<T>(
  shared: SharedReads | undefined,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  if (!shared) return read();
  const existing = shared.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = read();
  shared.set(key, pending);
  // A read that failed is not remembered: the next rule tries again.
  pending.catch(() => shared.delete(key));
  return pending;
}
