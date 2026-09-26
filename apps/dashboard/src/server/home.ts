/**
 * HOME — the pure half (Phase 6 final, D-277 §7).
 *
 * PURE, AND NOT `server-only`: the unit suite imports it directly. Everything
 * here decides how something the page already read is PRESENTED — a greeting,
 * a relative time, a day group, which verb an attention row offers. None of it
 * reads data, so none of it can invent any.
 */

/** Morning before noon, afternoon before six, evening otherwise. */
export type GreetingPeriod = 'morning' | 'afternoon' | 'evening';

export function greetingPeriod(hour: number): GreetingPeriod {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

/**
 * The hour on the reader's workspace clock. A timezone that is not a valid IANA
 * zone falls back to UTC rather than throwing — a greeting is not worth a 500.
 */
export function hourIn(now: Date, timeZone: string | null | undefined): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: timeZone || 'UTC',
    }).formatToParts(now);
    return Number(parts.find((part) => part.type === 'hour')?.value ?? now.getUTCHours());
  } catch {
    return now.getUTCHours();
  }
}

/** The name a greeting uses: the person's first name, or nothing. */
export function greetingName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] ?? null;
}

/**
 * "3 minutes ago", "yesterday", "in 2 days" — in the reader's language, from
 * `Intl.RelativeTimeFormat`, so Arabic gets Arabic grammar rather than a
 * translated template.
 */
export function relativeTime(date: Date, now: Date, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale === 'ar' ? 'ar' : 'en', { numeric: 'auto' });
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, 'second');
  if (abs < 3_600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return format.format(Math.round(seconds / 3_600), 'hour');
  if (abs < 7 * 86_400) return format.format(Math.round(seconds / 86_400), 'day');
  return format.format(Math.round(seconds / (7 * 86_400)), 'week');
}

/**
 * THE ONE ACTION EACH ATTENTION ROW OFFERS (§7 A: "one clear action").
 *
 * A verb, not a destination: the row's link already carries WHERE. Every kind
 * the Command Center can raise has one, and the unit suite fails when a new
 * kind is added without deciding what a reader does about it.
 */
export const ATTENTION_ACTIONS: Readonly<Record<string, string>> = {
  'publishing-failed': 'fix',
  'schedule-overdue': 'fix',
  'connection-reauth': 'reconnect',
  'connection-expiring': 'reconnect',
  'content-in-review': 'review',
  'brand-brain-empty': 'teach',
  'learnings-pending': 'review',
  'insights-new': 'open',
  'campaign-empty': 'plan',
  'calendar-gap': 'plan',
  'credits-forecast': 'open',
  'notes-assigned': 'open',
  'notes-mentions': 'open',
  'performance-above': 'open',
  'performance-below': 'open',
};

export function attentionAction(kind: string): string {
  return ATTENTION_ACTIONS[kind] ?? 'open';
}

/** How many recommendations Home shows at most (§7 B: "only 2–3"). */
export const HOME_RECOMMENDATIONS = 3;

/** How many conversations Home previews (§7 C). */
export const HOME_NOTES = 3;

/** Home's "Coming up" horizon (§7 D: "compact 7-day"). */
export const HOME_UPCOMING_DAYS = 7;

/**
 * Insight types that are RECOMMENDATIONS — something to do — as opposed to an
 * explanation of a number, a strategy or a monthly plan, which live on their
 * own screens and would crowd out the two or three things worth acting on.
 */
export const RECOMMENDATION_INSIGHT_TYPES = [
  'RECOMMENDATION',
  'OPPORTUNITY',
  'CONTENT_GAP',
] as const;

/**
 * Group dated rows by the calendar day they fall on in the workspace's zone,
 * in order. The key is `YYYY-MM-DD` in that zone, so two slots at 23:30 and
 * 00:30 local land on different days even when UTC says otherwise.
 */
export function groupByDay<T>(
  rows: readonly T[],
  at: (row: T) => Date,
  timeZone: string | null | undefined,
): readonly { readonly day: string; readonly first: Date; readonly rows: readonly T[] }[] {
  const zone = safeZone(timeZone);
  const key = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: zone,
  });
  const groups = new Map<string, { day: string; first: Date; rows: T[] }>();
  for (const row of rows) {
    const date = at(row);
    const day = key.format(date);
    const group = groups.get(day) ?? { day, first: date, rows: [] };
    group.rows.push(row);
    groups.set(day, group);
  }
  return [...groups.values()];
}

/** A zone `Intl` accepts, or UTC. */
export function safeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/**
 * WHETHER HOME INVITES THE READER BACK INTO SETUP.
 *
 * §6 says "do not continue setup forever", so Home asks only in the two cases
 * where the product is genuinely not usable yet or where setup was abandoned
 * right after it began: no brand at all, or a brand with NOTHING done after
 * it — no document, no connection, no goal. Once any of those exists, the
 * reader has engaged with setup and Home stops asking.
 */
export function shouldInviteSetup(input: {
  readonly hasBrand: boolean;
  readonly sources: number;
  readonly connections: number;
  readonly hasGoal: boolean;
}): boolean {
  if (!input.hasBrand) return true;
  return input.sources === 0 && input.connections === 0 && !input.hasGoal;
}

/** How many rows each role section on Home lists at most (A6). */
export const HOME_ROLE_ROWS = 5;

/**
 * THE HOME SECTIONS A MEMBER'S ROLE CALLS FOR (A6, E7, Q12).
 *
 * Chosen from PERMISSIONS, never from the role's name, so a role is its grant
 * set here as everywhere else, and a custom role gets the sections its keys
 * earn. Each section is a question the member actually has:
 *
 *   reviewQueue  "what is waiting for my review?"   `content.approve`
 *   myWork       "where are my drafts, what did I    `content.create` or
 *                 send, what of mine is scheduled?"  `content.submit`
 *   topPosts     "what is working?"                  `analytics.read`
 *   feedback     "what may I comment on?" — a member who reads content and
 *                can neither create, submit nor approve it: the read-only
 *                Viewer once it holds `content.read`. It links to the
 *                calendar (E7).
 *
 * A section is a view of rows the member could already open; nothing here
 * grants anything.
 */
export interface HomeSections {
  readonly reviewQueue: boolean;
  readonly myWork: boolean;
  readonly topPosts: boolean;
  readonly feedback: boolean;
}

export function homeSectionsFor(permissionKeys: readonly string[]): HomeSections {
  const may = (key: string) => permissionKeys.includes(key);
  const reads = may('content.read');
  const authors = may('content.create') || may('content.submit');
  const approves = may('content.approve');
  return {
    reviewQueue: reads && approves,
    myWork: reads && authors,
    topPosts: may('analytics.read'),
    feedback: reads && !authors && !approves,
  };
}
