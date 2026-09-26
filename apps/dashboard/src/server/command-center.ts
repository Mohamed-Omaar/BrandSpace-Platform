import { brandIdScopeFilter, brandScopeFilter, systemClock } from '@brandspace/shared';
import type { TenantScopedClient } from '@brandspace/database';
import type { CustomerWorkspaceContext } from '@brandspace/auth';
import { NOTE_PERMISSION } from '@brandspace/collaboration';
import { EXPIRING_SOON_MS } from '@brandspace/social-connectors';

/**
 * WHAT NEEDS A PERSON, RIGHT NOW, IN THIS WORKSPACE (P6-04).
 *
 * The Overview already answered "how is the workspace doing" with real figures
 * and honest unavailable states. What it did not answer is the question anybody
 * opening it actually has — **what am I supposed to do next** — so a member
 * signed in, read four correct numbers, and still had to go looking.
 *
 * AN ATTENTION ITEM IS A PIECE OF WORK, NOT A STATISTIC. Every one is something
 * a person can act on, carries a deep link to the screen where they act, and
 * exists ONLY when it is genuinely true. There is no "0 items need attention"
 * row and no decorative placeholder: a Command Center with nothing on it is a
 * workspace with nothing waiting, and saying so in one line is the honest
 * finished state.
 *
 * NOTHING HERE IS INVENTED OR APPROXIMATED. Every count is a real query against
 * real tenant data, scoped by the caller's brand scope and gated by the same
 * permission its destination route requires. Where the product cannot yet
 * answer a question — assigned notes and mentions, which do not exist until
 * P6-05 — the source is ABSENT rather than stubbed with a zero. A zero that
 * means "not built" is the fabricated metric CLAUDE.md §2.2 forbids, wearing a
 * number.
 *
 * NO `server-only` MARKER, AND THAT IS DELIBERATE RATHER THAN AN OVERSIGHT.
 * This module opens no connection, reads no secret and constructs no client —
 * the tenant-scoped client is a PARAMETER, supplied by a caller that is already
 * inside `inWorkspace`. Bundling it for a browser would ship dead code needing
 * an argument a browser cannot produce, which is why `brand-selection.ts` and
 * `automation-form.ts` are written the same way: a rule module the isolation
 * suite can import directly and exercise against real PostgreSQL. The tenant
 * boundary is enforced by the caller's transaction and by the predicates below,
 * not by a bundler directive.
 *
 * THE SOURCES ARE SEPARATE AND INDEPENDENT. Each is its own function returning
 * zero or one item, and a source that throws or is not permitted contributes
 * nothing rather than failing the page: a broken analytics connection must not
 * be able to take the home screen down.
 */

/**
 * How loudly an item asks.
 *
 * `blocked` is reserved for work that CANNOT proceed until somebody acts — a
 * publish that failed, a connection that needs re-authorising. `waiting` is
 * work that is proceeding and needs a person's decision. `notice` is something
 * worth knowing before it becomes either.
 *
 * Three levels, not five: the point of the ranking is that the top of the list
 * is the right thing to do first, and a scale nobody can apply consistently
 * produces a list ordered by whoever wrote the last source.
 */
export type AttentionSeverity = 'blocked' | 'waiting' | 'notice';

export interface AttentionItem {
  /** Stable identity, for test ids and React keys. Never a user-facing string. */
  readonly kind: string;
  readonly severity: AttentionSeverity;
  /**
   * How many things this item covers.
   *
   * Always at least 1 — an item with a count of zero is not created at all.
   * Rendered next to the label so "3 posts failed to publish" is one row rather
   * than three.
   */
  readonly count: number;
  /** The path segment to act on, WITHOUT the locale prefix. */
  readonly href: string;
  /**
   * A value the caller substitutes into the translated sentence, when the
   * sentence needs one that is not the count — a date, a brand name.
   */
  readonly detail?: string | undefined;
  /**
   * A moment the sentence names — the day credits are projected to run out,
   * the day they renew. Carried as a `Date` rather than a pre-formatted string
   * so the page formats it in the READER's locale and calendar, exactly as it
   * formats every other date on the screen.
   */
  readonly date?: Date | undefined;
  /** A second moment, when the sentence compares two. */
  readonly secondDate?: Date | undefined;
}

const SEVERITY_ORDER: Record<AttentionSeverity, number> = {
  blocked: 0,
  waiting: 1,
  notice: 2,
};

/**
 * Publishing that FAILED or half-failed, and is sitting there.
 *
 * `FAILED` is no target succeeded; `PARTIALLY_PUBLISHED` is some did and some
 * did not, which is the worse of the two to leave unnoticed because the screen
 * elsewhere says "published". Both are counted together because the action is
 * the same — open the calendar and look at the slot.
 */
async function publishingFailures(
  db: TenantScopedClient,
  session: CustomerWorkspaceContext,
): Promise<AttentionItem | null> {
  const count = await db.calendarSlot.count({
    where: {
      workspaceId: session.workspaceId,
      status: { in: ['FAILED', 'PARTIALLY_PUBLISHED'] },
      ...brandIdScopeFilter(session.brandScope),
    },
  });
  return count === 0
    ? null
    : { kind: 'publishing-failed', severity: 'blocked', count, href: '/publishing?tab=failed' };
}

/**
 * Connections that can no longer publish until somebody re-authorises them.
 *
 * `NEEDS_REAUTH` is set when a token is rejected or a scope grant comes back
 * partial (see `packages/social-connectors/src/oauth.ts`), and it is the single
 * most expensive thing to not notice: everything downstream keeps scheduling
 * happily and nothing reaches an audience.
 *
 * REVOKED is deliberately NOT counted. A revoked connection was disconnected on
 * purpose, by somebody here or at the provider; it is a fact, not a task.
 */
async function connectionsNeedingReauth(
  db: TenantScopedClient,
  session: CustomerWorkspaceContext,
): Promise<AttentionItem | null> {
  const count = await db.socialConnection.count({
    where: {
      workspaceId: session.workspaceId,
      status: 'NEEDS_REAUTH',
      ...brandIdScopeFilter(session.brandScope),
    },
  });
  return count === 0
    ? null
    : { kind: 'connection-reauth', severity: 'blocked', count, href: '/publishing?tab=accounts' };
}

/**
 * Content sitting in review.
 *
 * The approvals queue count comes from the Approvals service on the page
 * itself, because that service applies its own scoping rules; this is the
 * simpler, complementary question — how much work is parked in `IN_REVIEW`,
 * whoever it is waiting on.
 */
async function contentInReview(
  db: TenantScopedClient,
  session: CustomerWorkspaceContext,
): Promise<AttentionItem | null> {
  const count = await db.contentItem.count({
    where: {
      workspaceId: session.workspaceId,
      deletedAt: null,
      status: 'IN_REVIEW',
      ...brandIdScopeFilter(session.brandScope),
    },
  });
  return count === 0
    ? null
    : { kind: 'content-in-review', severity: 'waiting', count, href: '/approvals' };
}

/**
 * Scheduled work whose moment has passed and which has not published.
 *
 * A slot still `SCHEDULED` after its time is a silent failure of a different
 * shape from `FAILED`: nothing errored, the work simply did not go. It is the
 * one overdue signal worth showing, because every other "late" is somebody's
 * plan rather than the system's.
 */
async function overdueSchedules(
  db: TenantScopedClient,
  session: CustomerWorkspaceContext,
): Promise<AttentionItem | null> {
  const count = await db.calendarSlot.count({
    where: {
      workspaceId: session.workspaceId,
      status: 'SCHEDULED',
      scheduledAtUtc: { lt: systemClock.now() },
      ...brandIdScopeFilter(session.brandScope),
    },
  });
  return count === 0
    ? null
    : { kind: 'schedule-overdue', severity: 'blocked', count, href: '/calendar' };
}

/**
 * A brand with no knowledge in it at all.
 *
 * Not a nag, and not a completeness score: the four-layer Brand Brain is what
 * every AI surface in this product reads from, so a brand with nothing in it
 * makes the Copilot, Strategy and Content Studio quietly worse in ways that are
 * hard to attribute. One row, once, with a link to fix it.
 *
 * DELIBERATELY NOT A PERCENTAGE. The brief is explicit that a readiness score
 * must be honestly derived or not shown, and "how complete is this brand's
 * knowledge" has no defensible denominator. Empty or not empty is a fact.
 */
async function brandsWithNoKnowledge(
  db: TenantScopedClient,
  session: CustomerWorkspaceContext,
): Promise<AttentionItem | null> {
  const brands = await db.brand.findMany({
    where: {
      workspaceId: session.workspaceId,
      deletedAt: null,
      /*
       * `brandScopeFilter` — BY `id` — BECAUSE THIS IS THE BRAND TABLE (P6-11).
       *
       * This used `brandIdScopeFilter`, which filters a CHILD row by `brandId`.
       * The brand table has no `brandId`, so for every brand-scoped member the
       * query failed validation — and because the sources are dispatched
       * together, the failure took EVERY other source with it: a member
       * restricted to one brand opened Home and was told nothing was waiting,
       * whatever was. Found by the P6-11 isolation suite, which is the first to
       * run the Command Center as a scoped member holding `brand_brain.read`.
       */
      ...brandScopeFilter(session.brandScope),
    },
    select: { id: true, name: true },
  });
  if (brands.length === 0) return null;

  const withKnowledge = await db.brandKnowledgeItem.groupBy({
    by: ['brandId'],
    where: {
      workspaceId: session.workspaceId,
      brandId: { in: brands.map((b) => b.id) },
    },
    _count: { _all: true },
  });
  const populated = new Set(withKnowledge.map((row) => row.brandId));
  const empty = brands.filter((brand) => !populated.has(brand.id));
  if (empty.length === 0) return null;

  return {
    kind: 'brand-brain-empty',
    severity: 'notice',
    count: empty.length,
    href: '/brand-brain',
    // Named when it is one brand, counted when it is several: "Northwind has no
    // brand knowledge yet" is actionable in a way that "1 brand" is not.
    ...(empty.length === 1 && empty[0] ? { detail: empty[0].name } : {}),
  };
}

/*
 * ---------------------------------------------------------------------------
 * P6-11 — PULSE.
 *
 * The sources above answer "what is broken or waiting". The ones below answer
 * the Learn and Improve half of the loop — what the workspace's own data has
 * noticed and is waiting on a person to decide about — under exactly the same
 * three rules:
 *
 *   1. an item exists only when the condition is TRUE, measured against real
 *      rows, never estimated into existence;
 *   2. every one is a link to where it is acted on, gated by that route's
 *      permission;
 *   3. nothing is a score, a percentage of an invented whole, or a confidence
 *      the data does not carry.
 *
 * PULSE IS THIS LIST, NOT A SECOND MECHANISM. A separate "insights feed" beside
 * the attention list would be two answers to "what should I do next" that can
 * disagree, and the brief asks for no banner spam: one ranked list, on Home,
 * with the same wording the notification inbox and the destination screen use.
 * ---------------------------------------------------------------------------
 */

/**
 * Proposed learnings and facts waiting in the Brand Brain review queue.
 *
 * THE HUMAN-REVIEW STEP OF THE LEARNING LOOP. An analytics inference and a
 * fact extracted from an uploaded document both land as a PENDING candidate,
 * and neither reaches Brand Brain until a person accepts, edits or dismisses
 * it (D-150). A queue nobody knows is there is how the loop silently stops at
 * "propose", so the count belongs on the screen everybody lands on.
 *
 * `brand_brain.review`, because that is who can clear it — somebody who can
 * only READ Brand Brain would be shown a task they cannot do.
 */
async function learningsPending(
  db: TenantScopedClient,
  session: CustomerWorkspaceContext,
): Promise<AttentionItem | null> {
  const count = await db.brandKnowledgeCandidate.count({
    where: {
      workspaceId: session.workspaceId,
      status: 'PENDING',
      ...brandIdScopeFilter(session.brandScope),
    },
  });
  return count === 0
    ? null
    : { kind: 'learnings-pending', severity: 'waiting', count, href: '/brand-brain' };
}

/** The insight types Marketing Intelligence presents — the page's own list. */
export const INTELLIGENCE_INSIGHT_TYPES = [
  'CONTENT_GAP',
  'OPPORTUNITY',
  'ANALYTICS_EXPLANATION',
  'ANOMALY',
  'RECOMMENDATION',
] as const;

/**
 * Findings nobody has looked at yet.
 *
 * `NEW` is the insight's own lifecycle state — generated, not yet seen,
 * accepted or dismissed — so this is a fact about the row, not a guess about
 * the reader. An expired insight is excluded: retention has already decided it
 * no longer matters, and pointing at it would send somebody to a finding the
 * next prune removes.
 *
 * STRATEGIES AND MONTHLY PLANS ARE NOT COUNTED. They are `/strategy`'s subject,
 * and the link here goes to `/intelligence`; counting rows the destination does
 * not list would be a number the reader cannot reconcile.
 */
async function insightsUnreviewed(
  db: TenantScopedClient,
  session: CustomerWorkspaceContext,
): Promise<AttentionItem | null> {
  const count = await db.insight.count({
    where: {
      workspaceId: session.workspaceId,
      status: 'NEW',
      type: { in: [...INTELLIGENCE_INSIGHT_TYPES] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: systemClock.now() } }],
      ...brandIdScopeFilter(session.brandScope),
    },
  });
  return count === 0
    ? null
    : { kind: 'insights-new', severity: 'notice', count, href: '/intelligence' };
}

/**
 * Connected accounts whose access expires within the refresh window — or
 * already has, while the connection still reads ACTIVE.
 *
 * NOTHING REFRESHES THESE AUTOMATICALLY. Refreshing is a manual action on
 * `/integrations`, so an expiring token is a genuine task, and the one that
 * turns into `publishing-failed` tomorrow if nobody does it today. The window
 * is the connector package's own `EXPIRING_SOON_MS`, so Home, the integrations
 * screen and the calendar's publish readiness cannot disagree about which
 * accounts are expiring.
 */
async function connectionsExpiring(
  db: TenantScopedClient,
  session: CustomerWorkspaceContext,
): Promise<AttentionItem | null> {
  const horizon = new Date(systemClock.now().getTime() + EXPIRING_SOON_MS);
  const count = await db.socialConnection.count({
    where: {
      workspaceId: session.workspaceId,
      status: 'ACTIVE',
      tokenExpiresAt: { not: null, lt: horizon },
      ...brandIdScopeFilter(session.brandScope),
    },
  });
  return count === 0
    ? null
    : { kind: 'connection-expiring', severity: 'waiting', count, href: '/publishing?tab=accounts' };
}

/**
 * Running campaigns with nothing in them.
 *
 * ACTIVE is the campaign's own status — somebody started it — and a campaign
 * that is running with no content attached is running in name only. An ended
 * campaign (its `endDate` has passed) is not counted even if its status was
 * never moved on: that is a tidy-up, not a gap.
 *
 * Named when there is one, so the link goes straight to it.
 */
async function campaignsWithoutContent(
  db: TenantScopedClient,
  session: CustomerWorkspaceContext,
): Promise<AttentionItem | null> {
  const today = startOfUtcDay(systemClock.now());
  const empty = await db.campaign.findMany({
    where: {
      workspaceId: session.workspaceId,
      deletedAt: null,
      status: 'ACTIVE',
      OR: [{ endDate: null }, { endDate: { gte: today } }],
      contentItems: { none: { deletedAt: null } },
      ...brandIdScopeFilter(session.brandScope),
    },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  if (empty.length === 0) return null;
  const only = empty.length === 1 ? empty[0] : undefined;
  return {
    kind: 'campaign-empty',
    severity: 'notice',
    count: empty.length,
    href: only ? `/campaigns/${only.id}` : '/campaigns',
    ...(only ? { detail: only.name } : {}),
  };
}

/**
 * How far ahead "nothing is scheduled" is judged.
 *
 * A PRESENTATION HORIZON, NOT A POLICY. It decides which question Home asks —
 * "is anything going out this coming week?" — in the same way the 28-day
 * engagement figure beside it decides which period Home summarises. It sets no
 * limit, charges nothing and changes no behaviour, which is what separates it
 * from the configuration CLAUDE.md §2.2 moves out of code.
 */
export const CALENDAR_GAP_HORIZON_DAYS = 7;

/**
 * Brands that can publish and have nothing going out in the coming week.
 *
 * "CAN PUBLISH" IS THE CONDITION THAT MAKES THIS A GAP rather than a fact about
 * a brand that has not connected anything yet — that brand's problem is
 * `/integrations`, not the calendar, and telling it "nothing is scheduled"
 * would be true and useless. So a brand counts only when it has at least one
 * ACTIVE connection and no live slot inside the horizon.
 *
 * A slot counts as "going out" in every state short of done or abandoned:
 * planned, scheduled or in flight.
 */
async function calendarGaps(
  db: TenantScopedClient,
  session: CustomerWorkspaceContext,
): Promise<AttentionItem | null> {
  const now = systemClock.now();
  const horizon = new Date(now.getTime() + CALENDAR_GAP_HORIZON_DAYS * 86_400_000);
  const brands = await db.brand.findMany({
    where: {
      workspaceId: session.workspaceId,
      deletedAt: null,
      socialConnections: { some: { status: 'ACTIVE' } },
      ...brandScopeFilter(session.brandScope),
    },
    select: { id: true, name: true },
    take: 200,
  });
  if (brands.length === 0) return null;

  const busy = await db.calendarSlot.groupBy({
    by: ['brandId'],
    where: {
      workspaceId: session.workspaceId,
      brandId: { in: brands.map((b) => b.id) },
      status: { in: ['PLANNED', 'SCHEDULED', 'PUBLISHING'] },
      scheduledAtUtc: { gte: now, lt: horizon },
    },
    _count: { _all: true },
  });
  const scheduled = new Set(busy.map((row) => row.brandId));
  const idle = brands.filter((brand) => !scheduled.has(brand.id));
  if (idle.length === 0) return null;
  return {
    kind: 'calendar-gap',
    severity: 'notice',
    count: idle.length,
    href: '/calendar',
    ...(idle.length === 1 && idle[0] ? { detail: idle[0].name } : {}),
  };
}

/** The trailing window a credit forecast is drawn from — Home's own period. */
export const CREDIT_FORECAST_WINDOW_DAYS = 28;

/**
 * Pure: when, at the recent pace, do spendable credits run out — and is that
 * before they renew?
 *
 * RETURNS NULL RATHER THAN GUESSING in every case the arithmetic cannot
 * honestly support:
 *
 *   - no renewal date: with nothing to compare the run-out against there is no
 *     claim to make, and "you have N days" alone invites a reader to plan on a
 *     number derived from a quiet month;
 *   - no consumption in the window: a zero pace has no run-out;
 *   - nothing spendable: that is not a forecast, it is the present, and the
 *     credits screen already says it;
 *   - a run-out on or after the renewal: the renewal arrives first, so there is
 *     nothing to act on.
 *
 * THE PACE IS DIVIDED BY THE WHOLE WINDOW, never by "days since the first
 * charge". A workspace that started yesterday would otherwise extrapolate one
 * busy afternoon into a monthly rate; dividing by the full window can only
 * UNDER-state the pace, so the item errs towards appearing later, not falsely.
 */
export function creditForecast(input: {
  readonly spendableMilliCredits: bigint;
  /** Net consumption over the window, in milli-credits. Positive means spent. */
  readonly consumedInWindowMilliCredits: bigint;
  readonly windowDays: number;
  readonly nextResetAt: Date | null;
  readonly now: Date;
}): { readonly daysLeft: number; readonly runOutAt: Date } | null {
  if (input.nextResetAt === null) return null;
  if (input.consumedInWindowMilliCredits <= 0n) return null;
  if (input.spendableMilliCredits <= 0n) return null;
  if (input.windowDays <= 0) return null;

  // Milli-credits per day, as a float only at the last step: the inputs are
  // exact integers from the ledger.
  const perDay = Number(input.consumedInWindowMilliCredits) / input.windowDays;
  const daysLeftExact = Number(input.spendableMilliCredits) / perDay;
  const runOutAt = new Date(input.now.getTime() + daysLeftExact * 86_400_000);
  if (runOutAt.getTime() >= input.nextResetAt.getTime()) return null;
  return { daysLeft: Math.max(1, Math.floor(daysLeftExact)), runOutAt };
}

/**
 * AI credits that will run out before they renew, at the recent pace.
 *
 * DERIVED FROM THE LEDGER, NOT THE BALANCE HISTORY. Net consumption is usage
 * charges less refunds over the window — the same rows `reconcile()` replays —
 * so the pace is what was actually spent, and a refunded failure (CLAUDE.md
 * §2.4: a failed provider request is never a deduction) does not inflate it.
 *
 * Needs BOTH `credits.read` (the balance is the input) and `billing.read` (the
 * link goes to `/plan`, which requires it).
 */
async function creditsRunningOut(
  db: TenantScopedClient,
  session: CustomerWorkspaceContext,
): Promise<AttentionItem | null> {
  const wallet = await db.creditWallet.findFirst({
    where: { workspaceId: session.workspaceId },
    select: {
      id: true,
      balanceMilliCredits: true,
      reservedMilliCredits: true,
      nextResetAt: true,
    },
  });
  if (!wallet) return null;
  const now = systemClock.now();
  const since = new Date(now.getTime() - CREDIT_FORECAST_WINDOW_DAYS * 86_400_000);
  const flows = await db.creditTransaction.groupBy({
    by: ['type'],
    where: {
      workspaceId: session.workspaceId,
      walletId: wallet.id,
      type: { in: ['USAGE_CHARGE', 'REFUND'] },
      occurredAt: { gte: since },
    },
    _sum: { amountMilliCredits: true },
  });
  // Charges are stored negative and refunds positive, so the NEGATED sum is
  // what was spent net of what was given back.
  const net = flows.reduce((total, row) => total + (row._sum.amountMilliCredits ?? 0n), 0n);
  const forecast = creditForecast({
    spendableMilliCredits: wallet.balanceMilliCredits - wallet.reservedMilliCredits,
    consumedInWindowMilliCredits: -net,
    windowDays: CREDIT_FORECAST_WINDOW_DAYS,
    nextResetAt: wallet.nextResetAt,
    now,
  });
  if (!forecast || !wallet.nextResetAt) return null;
  return {
    kind: 'credits-forecast',
    severity: 'notice',
    count: forecast.daysLeft,
    href: '/plan',
    date: forecast.runOutAt,
    secondDate: wallet.nextResetAt,
  };
}

/** Midnight UTC of the given instant — `@db.Date` columns compare against it. */
function startOfUtcDay(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
}

/**
 * Conversations waiting on this person, and mentions they have not read.
 *
 * THE SOURCE P6-04 DELIBERATELY LEFT ABSENT. Until P6-05 there were no notes,
 * so there was no source rather than a source returning zero — a zero meaning
 * "not built" is a fabricated metric wearing a number. Now that the capability
 * exists the source does too, and it is the only one here that is about the
 * READER specifically rather than about the workspace.
 *
 * Two separate items, because they are two different requests: somebody
 * ASSIGNED you a thread, which is a task; somebody NAMED you in one, which is a
 * conversation you are being invited into. Collapsing them into "3 things" would
 * lose which of the two it is, and they are answered differently.
 */
async function assignedThreads(
  db: TenantScopedClient,
  session: CustomerWorkspaceContext,
  userId: string,
): Promise<AttentionItem | null> {
  const count = await db.noteThread.count({
    where: {
      workspaceId: session.workspaceId,
      assignedToUserId: userId,
      status: 'OPEN',
      ...brandIdScopeFilter(session.brandScope),
    },
  });
  return count === 0
    ? null
    : // P6-16: the Notes surface exists now, and lists exactly these threads.
      { kind: 'notes-assigned', severity: 'waiting', count, href: '/notes' };
}

async function unreadMentions(
  db: TenantScopedClient,
  session: CustomerWorkspaceContext,
  userId: string,
): Promise<AttentionItem | null> {
  /*
   * NO BRAND SCOPE CLAUSE, AND THAT IS CORRECT RATHER THAN AN OMISSION. A
   * mention row carries no brand: it names a person in a note, and the note's
   * thread is what is brand-scoped. Somebody is either named or they are not,
   * and a mention they can see the notification for but not the thread would be
   * worse than either — so the count is of mentions in threads they can reach,
   * which the join below expresses directly.
   */
  const count = await db.noteMention.count({
    where: {
      workspaceId: session.workspaceId,
      mentionedUserId: userId,
      readAt: null,
      // P6-16: the SAME population `NotesService.unreadMentionCount` counts and
      // the Notes surface lists — a live note, in a reachable thread, about
      // work that still exists — so Home, the top-bar dot and /notes agree.
      note: {
        deletedAt: null,
        thread: {
          ...brandIdScopeFilter(session.brandScope),
          NOT: { contentItem: { is: { deletedAt: { not: null } } } },
        },
      },
    },
  });
  return count === 0
    ? null
    : { kind: 'notes-mentions', severity: 'waiting', count, href: '/notes' };
}

/**
 * Every source, in one place, with the permission each one needs.
 *
 * A SOURCE THE MEMBER MAY NOT SEE IS NOT RUN. The rail already hides links a
 * member cannot follow, and an attention item is a link — pointing somebody at
 * `/integrations` when the route will answer 404 is the dead navigation §20
 * forbids, delivered as a to-do.
 */
const SOURCES: readonly {
  /**
   * EVERY permission listed is required. A list rather than one key because
   * the credit forecast reads one thing (`credits.read`) and links to a route
   * that requires another (`billing.read`); holding either alone would show a
   * member a number they may not see or a link they cannot follow.
   */
  readonly permissions: readonly string[];
  readonly run: (
    db: TenantScopedClient,
    session: CustomerWorkspaceContext,
  ) => Promise<AttentionItem | null>;
}[] = [
  // Publishing (D-277 §33) is where failures and account health are acted on,
  // so its permission joins the source's own.
  { permissions: ['content.read', 'publishing.read'], run: publishingFailures },
  { permissions: ['content.read'], run: overdueSchedules },
  { permissions: ['integrations.read', 'publishing.read'], run: connectionsNeedingReauth },
  { permissions: ['content.read'], run: contentInReview },
  { permissions: ['brand_brain.read'], run: brandsWithNoKnowledge },
  // P6-11 — Pulse.
  { permissions: ['brand_brain.review'], run: learningsPending },
  { permissions: ['strategy.read'], run: insightsUnreviewed },
  { permissions: ['integrations.read', 'publishing.read'], run: connectionsExpiring },
  { permissions: ['campaigns.read'], run: campaignsWithoutContent },
  { permissions: ['content.read'], run: calendarGaps },
  // Q18 — the balance is shown to the people who spend it.
  { permissions: ['credits.read', 'billing.read', 'copilot.use'], run: creditsRunningOut },
];

/**
 * The sources that are about the READER rather than about the workspace.
 *
 * Separate because they need the acting user's id, which the workspace context
 * does not carry — and threading a user id through every source just so two of
 * them can use it would make the other five look as though they depended on it.
 */
const READER_SOURCES: readonly {
  readonly permission: string | null;
  readonly run: (
    db: TenantScopedClient,
    session: CustomerWorkspaceContext,
    userId: string,
  ) => Promise<AttentionItem | null>;
}[] = [
  { permission: NOTE_PERMISSION, run: assignedThreads },
  { permission: NOTE_PERMISSION, run: unreadMentions },
];

/**
 * What needs attention, most urgent first.
 *
 * ONE SOURCE FAILING MUST NOT TAKE THE HOME SCREEN DOWN. Each runs
 * independently and a rejection contributes nothing — the Command Center
 * showing four of five things is far better than a member being unable to sign
 * in to their workspace because one count threw.
 */
export async function attentionItems(
  db: TenantScopedClient,
  session: CustomerWorkspaceContext,
  /**
   * The acting member, for the two sources that are about THEM.
   *
   * Optional so that a caller with no user in hand still gets the workspace
   * items rather than nothing — and so that adding the reader did not change
   * every existing call site into a broken one.
   */
  userId?: string,
): Promise<readonly AttentionItem[]> {
  const permitted = SOURCES.filter((source) =>
    source.permissions.every((key) => session.permissionKeys.includes(key)),
  );
  const readerPermitted =
    userId === undefined
      ? []
      : READER_SOURCES.filter(
          (source) =>
            source.permission === null || session.permissionKeys.includes(source.permission),
        );
  const settled = await Promise.allSettled([
    ...permitted.map((source) => source.run(db, session)),
    ...readerPermitted.map((source) => source.run(db, session, userId as string)),
  ]);

  const items = settled
    .filter(
      (result): result is PromiseFulfilledResult<AttentionItem | null> =>
        result.status === 'fulfilled',
    )
    .map((result) => result.value)
    .filter((item): item is AttentionItem => item !== null);

  return rankAttention(items);
}

/**
 * Most urgent first. Stable, so items of equal severity keep their source
 * order — which is itself ordered by how much it costs to leave them.
 *
 * Exported so an item computed OUTSIDE this module — the performance shift,
 * which needs the analytics services rather than a bare client — joins the
 * same ranked list instead of being rendered as a second one.
 */
export function rankAttention(items: readonly AttentionItem[]): readonly AttentionItem[] {
  return [...items].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
