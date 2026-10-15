/**
 * THE PERFORMANCE SCREEN'S ARITHMETIC (review of #67, round 3, B8).
 *
 * The prototype's "Reach, day by day" draws one line per channel on its
 * 900×230 chart (`Main.dc.html` lines 686–699, `PF.series`), and its "Best time
 * to post" and "By strategy pillar" cards read the posts' own figures. These
 * are the pure parts of that — given the figures the analytics queries
 * returned, never invented ones. A day with no reading is a gap in its line,
 * never a zero.
 *
 * PURE, AND NOT `server-only`: the unit suite imports it directly.
 */

export interface DayValue {
  readonly label: string;
  readonly value: number | null;
}

export interface ChannelSeries {
  readonly key: string;
  readonly points: readonly DayValue[];
}

export interface ChannelChart {
  readonly grid: readonly { readonly y: number; readonly label: string }[];
  readonly xlabels: readonly { readonly x: number; readonly label: string }[];
  readonly lines: readonly {
    readonly key: string;
    readonly paths: readonly string[];
    readonly end: { readonly x: number; readonly y: number; readonly label: string } | null;
  }[];
}

/** "3.4k" — the prototype's axis and end labels. */
export function shortCount(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(Math.round(value));
}

/**
 * The prototype's chart geometry: `viewBox 0 0 900 230`, plot from x 48 to
 * 830, y 12 to 204, four grid lines, a label every 7th day (21st over 90).
 * Every channel shares one scale, so the lines can be compared.
 */
export function channelChart(series: readonly ChannelSeries[]): ChannelChart | null {
  const length = Math.max(0, ...series.map((entry) => entry.points.length));
  const values = series.flatMap((entry) =>
    entry.points.flatMap((point) => (point.value === null ? [] : [point.value])),
  );
  if (length === 0 || values.length === 0) return null;
  const CW = 900;
  const CH = 230;
  const PL = 48;
  const PR = 70;
  const PT = 12;
  const PB = 26;
  const pw = CW - PL - PR;
  const ph = CH - PT - PB;
  const max = Math.max(...values, 1);
  const step = niceStep(max / 4);
  const ymax = step * 4;
  const X = (i: number) => PL + (length === 1 ? pw / 2 : (i / (length - 1)) * pw);
  const Y = (v: number) => PT + ph - (v / ymax) * ph;
  const grid = [0, 1, 2, 3, 4].map((i) => ({ y: Y(step * i), label: shortCount(step * i) }));
  const every = length <= 28 ? 7 : 21;
  const reference = series.find((entry) => entry.points.length === length)?.points ?? [];
  const xlabels = reference
    .map((point, index) => ({ index, label: point.label }))
    .filter(({ index }) => index % every === 0)
    .map(({ index, label }) => ({ x: X(index), label }));
  // Final walk: a reading with no neighbour is drawn as a dot (a zero-length
  // stroke with the line's round cap), not as nothing.
  const closed = (path: string) => (path.includes('L') ? path : `${path}h0.01`);
  const lines = series.map((entry) => {
    const paths: string[] = [];
    let current = '';
    entry.points.forEach((point, index) => {
      if (point.value === null) {
        if (current) paths.push(closed(current));
        current = '';
        return;
      }
      current += `${current ? 'L' : 'M'}${X(index).toFixed(1)},${Y(point.value).toFixed(1)}`;
    });
    if (current) paths.push(closed(current));
    const lastIndex = entry.points.map((point) => point.value !== null).lastIndexOf(true);
    const last = lastIndex >= 0 ? entry.points[lastIndex] : undefined;
    return {
      key: entry.key,
      paths,
      end:
        last && last.value !== null
          ? { x: X(lastIndex) + 6, y: Y(last.value) + 4, label: shortCount(last.value) }
          : null,
    };
  });
  // Final walk: end values that would print on top of one another (the same
  // day, close readings) are spread apart, top to bottom, by one line height.
  const GAP = 12;
  const ends = lines
    .map((line) => line.end)
    .filter((end): end is { x: number; y: number; label: string } => end !== null)
    .sort((a, b) => a.y - b.y);
  ends.forEach((end, index) => {
    const above = ends[index - 1];
    if (above && Math.abs(end.x - above.x) < 40 && end.y - above.y < GAP) end.y = above.y + GAP;
  });
  return { grid, xlabels, lines };
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice =
    fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/**
 * "Best time to post": the average engagements of the posts published in each
 * local hour, best first — only hours that had a post, and at most `limit`.
 */
export function bestPostingHours(
  posts: readonly { readonly publishedAt: Date | null; readonly value: number }[],
  timeZone: string,
  limit = 3,
): readonly { readonly hour: number; readonly average: number; readonly posts: number }[] {
  const byHour = new Map<number, { total: number; count: number }>();
  const hourOf = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hourCycle: 'h23',
    timeZone,
  });
  for (const post of posts) {
    if (!post.publishedAt) continue;
    const hour = Number(hourOf.format(post.publishedAt)) % 24;
    const entry = byHour.get(hour) ?? { total: 0, count: 0 };
    entry.total += post.value;
    entry.count += 1;
    byHour.set(hour, entry);
  }
  return [...byHour.entries()]
    .map(([hour, entry]) => ({ hour, average: entry.total / entry.count, posts: entry.count }))
    .sort((a, b) => b.average - a.average || a.hour - b.hour)
    .slice(0, limit);
}

/** "By strategy pillar": engagements summed per pillar, largest first; posts with none left out. */
export function pillarTotals(
  posts: readonly { readonly pillar: string | null; readonly value: number }[],
): readonly { readonly pillar: string; readonly total: number }[] {
  const totals = new Map<string, number>();
  for (const post of posts) {
    const pillar = post.pillar?.trim();
    if (!pillar) continue;
    totals.set(pillar, (totals.get(pillar) ?? 0) + post.value);
  }
  return [...totals.entries()]
    .map(([pillar, total]) => ({ pillar, total }))
    .sort((a, b) => b.total - a.total || a.pillar.localeCompare(b.pillar));
}

/**
 * PR D (Strategy 7) — "How it's going": AVERAGE engagements per post, per
 * pillar, largest first (Main line 1131, "Average engagement per pillar").
 * Posts without a pillar are left out; no posts, no rows.
 */
export function pillarAverages(
  posts: readonly { readonly pillar: string | null; readonly value: number }[],
): readonly { readonly pillar: string; readonly average: number; readonly posts: number }[] {
  const byPillar = new Map<string, { total: number; count: number }>();
  for (const post of posts) {
    const pillar = post.pillar?.trim();
    if (!pillar) continue;
    const entry = byPillar.get(pillar) ?? { total: 0, count: 0 };
    entry.total += post.value;
    entry.count += 1;
    byPillar.set(pillar, entry);
  }
  return [...byPillar.entries()]
    .map(([pillar, entry]) => ({ pillar, average: entry.total / entry.count, posts: entry.count }))
    .sort((a, b) => b.average - a.average || a.pillar.localeCompare(b.pillar));
}
