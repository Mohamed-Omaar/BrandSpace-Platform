/**
 * BATCH 7 PR C — "BEST TIME AUTOMATICALLY" AND "WHEN YOUR AUDIENCE IS ACTIVE".
 *
 * The Studio's publish-time popover (`Main.dc.html` lines 343–349) offers a
 * best time and three good hours. The owner's rule: they come from the
 * brand's OWN measured engagement by posting hour, per channel, from real
 * platform insights — and while there is not enough of it they are not drawn
 * at all. No placeholder hours, no hours from configuration, no "coming soon".
 *
 * WHAT COUNTS AS REAL. A `MetricObservation` whose `sourceKind` is `PROVIDER`:
 * a real provider API answered. `MOCK` observations (the development
 * connectors, never reachable in PRODUCTION) never count, so a development
 * or staging workspace full of mock publishing still shows nothing.
 *
 * THE MINIMUM, PER CHANNEL OF THE POST. Every channel the post goes to must
 * have, in the last {@link BEST_TIME_WINDOW_DAYS} days:
 *   - at least {@link BEST_TIME_MIN_POSTS} posts published on it that have
 *     real engagement figures, and
 *   - at least {@link BEST_TIME_MIN_HOURS} distinct posting hours that each
 *     carry at least {@link BEST_TIME_MIN_POSTS_PER_HOUR} of those posts.
 * One channel short and nothing is shown: an hour that is good on Instagram
 * says nothing about LinkedIn.
 *
 * THE RANKING. Each post's engagements are divided by its channel's average,
 * so a large channel does not drown a small one, then averaged per local
 * posting hour across the post's channels. The three best hours that carry at
 * least two posts are the chips (drawn in clock order, the best one marked);
 * the best of them, at its next occurrence after the calendar's lead time and
 * within its horizon, is "Best time automatically".
 *
 * NOT BUILT, DOCUMENTED (D-489): an AI suggestion for a brand with no
 * history, through the AI Gateway. Until then such a brand sees two choices.
 *
 * The pure part is exported for the unit suite; `readBestTimes` is the query.
 */

import type { SocialProvider, TenantScopedClient } from '@brandspace/database';
import { formatLocalTime, resolveZonedTime } from '@brandspace/content';

export const BEST_TIME_WINDOW_DAYS = 90;
export const BEST_TIME_MIN_POSTS = 12;
export const BEST_TIME_MIN_HOURS = 3;
export const BEST_TIME_MIN_POSTS_PER_HOUR = 2;
const CHIPS = 3;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface PublishedPostFigure {
  readonly provider: SocialProvider;
  readonly contentItemId: string;
  readonly publishedAt: Date;
  /** Total engagements a real provider reported for this post on this channel. */
  readonly engagements: number;
}

export type DayPart = 'morning' | 'lunch' | 'afternoon' | 'evening' | 'night';

export interface BestTimeSlot {
  /** `HH:00`, the workspace's wall clock. */
  readonly time: string;
  readonly part: DayPart;
  /** The best of the three. */
  readonly top: boolean;
}

export interface BestTimes {
  /** Clock order. */
  readonly slots: readonly BestTimeSlot[];
  /** `YYYY-MM-DDTHH:mm` — the best hour's next usable occurrence. */
  readonly bestLocalTime: string;
}

export function dayPartOf(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 15) return 'lunch';
  if (hour >= 15 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'night';
}

/** The pure decision: the chips and the best time, or null when there is not enough. */
export function bestTimes(input: {
  readonly channels: readonly SocialProvider[];
  readonly posts: readonly PublishedPostFigure[];
  readonly timeZone: string;
  readonly now: Date;
  readonly minLeadMinutes: number;
  readonly maxDaysAhead: number;
}): BestTimes | null {
  const channels = [...new Set(input.channels)];
  if (channels.length === 0) return null;
  const since = input.now.getTime() - BEST_TIME_WINDOW_DAYS * DAY_MS;
  const hourOf = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hourCycle: 'h23',
    timeZone: input.timeZone,
  });

  const scored: { hour: number; score: number }[] = [];
  for (const channel of channels) {
    const posts = input.posts.filter(
      (post) =>
        post.provider === channel &&
        post.publishedAt.getTime() >= since &&
        post.publishedAt.getTime() <= input.now.getTime(),
    );
    if (posts.length < BEST_TIME_MIN_POSTS) return null;
    const perHour = new Map<number, number>();
    for (const post of posts) {
      const hour = Number(hourOf.format(post.publishedAt)) % 24;
      perHour.set(hour, (perHour.get(hour) ?? 0) + 1);
    }
    const backed = [...perHour.values()].filter((n) => n >= BEST_TIME_MIN_POSTS_PER_HOUR).length;
    if (backed < BEST_TIME_MIN_HOURS) return null;
    const mean = posts.reduce((sum, post) => sum + post.engagements, 0) / posts.length;
    for (const post of posts) {
      scored.push({
        hour: Number(hourOf.format(post.publishedAt)) % 24,
        score: mean > 0 ? post.engagements / mean : 0,
      });
    }
  }

  const byHour = new Map<number, { total: number; count: number }>();
  for (const { hour, score } of scored) {
    const entry = byHour.get(hour) ?? { total: 0, count: 0 };
    entry.total += score;
    entry.count += 1;
    byHour.set(hour, entry);
  }
  const ranked = [...byHour.entries()]
    .filter(([, entry]) => entry.count >= BEST_TIME_MIN_POSTS_PER_HOUR)
    .map(([hour, entry]) => ({ hour, average: entry.total / entry.count }))
    .sort((a, b) => b.average - a.average || a.hour - b.hour)
    .slice(0, CHIPS);
  const best = ranked[0];
  if (ranked.length < CHIPS || !best) return null;

  const bestLocalTime = nextOccurrence(best.hour, input);
  if (!bestLocalTime) return null;
  return {
    slots: [...ranked]
      .sort((a, b) => a.hour - b.hour)
      .map(({ hour }) => ({
        time: `${String(hour).padStart(2, '0')}:00`,
        part: dayPartOf(hour),
        top: hour === best.hour,
      })),
    bestLocalTime,
  };
}

/** The first `HH:00` at or after now plus the lead, inside the horizon. */
function nextOccurrence(
  hour: number,
  input: {
    readonly timeZone: string;
    readonly now: Date;
    readonly minLeadMinutes: number;
    readonly maxDaysAhead: number;
  },
): string | null {
  const earliest = input.now.getTime() + input.minLeadMinutes * 60_000;
  const horizon = input.now.getTime() + input.maxDaysAhead * DAY_MS;
  const today = formatLocalTime(input.now, input.timeZone).slice(0, 10);
  const time = `${String(hour).padStart(2, '0')}:00`;
  for (let step = 0; step <= 2; step += 1) {
    const day = new Date(`${today}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + step);
    const local = `${day.toISOString().slice(0, 10)}T${time}`;
    const resolved = resolveZonedTime(local, input.timeZone);
    if (!resolved) continue;
    const at = resolved.instant.getTime();
    if (at >= earliest && at <= horizon) return local;
  }
  return null;
}

/**
 * The brand's real per-post engagement on the given channels, published in
 * the window. Under the caller's RLS-scoped client and its workspace; the
 * caller has already resolved the brand inside the member's brand scope.
 */
export async function readPublishedFigures(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly brandId: string;
    readonly channels: readonly SocialProvider[];
    readonly now: Date;
  },
): Promise<readonly PublishedPostFigure[]> {
  if (input.channels.length === 0) return [];
  const since = new Date(input.now.getTime() - BEST_TIME_WINDOW_DAYS * DAY_MS);
  const jobs = await db.publishJob.findMany({
    where: {
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      provider: { in: [...input.channels] },
      status: 'PUBLISHED',
      publishedAt: { gte: since, lte: input.now },
    },
    select: { contentItemId: true, provider: true, publishedAt: true },
  });
  if (jobs.length === 0) return [];
  const sums = await db.metricObservation.groupBy({
    by: ['contentItemId', 'provider'],
    where: {
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      provider: { in: [...input.channels] },
      subjectType: 'POST',
      metricKey: 'engagements',
      sourceKind: 'PROVIDER',
      contentItemId: { in: [...new Set(jobs.map((job) => job.contentItemId))] },
    },
    _sum: { value: true },
  });
  const engagements = new Map(
    sums.map((row) => [`${row.contentItemId}:${row.provider}`, Number(row._sum.value ?? 0n)]),
  );
  // One figure per post and channel: its first publication there.
  const first = new Map<string, PublishedPostFigure>();
  for (const job of jobs) {
    if (!job.publishedAt) continue;
    const key = `${job.contentItemId}:${job.provider}`;
    const value = engagements.get(key);
    if (value === undefined) continue;
    const seen = first.get(key);
    if (seen && seen.publishedAt <= job.publishedAt) continue;
    first.set(key, {
      provider: job.provider,
      contentItemId: job.contentItemId,
      publishedAt: job.publishedAt,
      engagements: value,
    });
  }
  return [...first.values()];
}
