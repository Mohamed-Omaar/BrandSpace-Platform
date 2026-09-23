import { brandIdScopeFilter, systemClock } from '@brandspace/shared';
import type { TenantScopedClient } from '@brandspace/database';
import type { CustomerWorkspaceContext } from '@brandspace/auth';
import { NOTE_PERMISSION } from '@brandspace/collaboration';

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
    : { kind: 'publishing-failed', severity: 'blocked', count, href: '/calendar' };
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
    : { kind: 'connection-reauth', severity: 'blocked', count, href: '/integrations' };
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
      ...brandIdScopeFilter(session.brandScope),
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
    : { kind: 'notes-assigned', severity: 'waiting', count, href: '/overview' };
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
      note: { thread: { ...brandIdScopeFilter(session.brandScope) } },
    },
  });
  return count === 0
    ? null
    : { kind: 'notes-mentions', severity: 'waiting', count, href: '/overview' };
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
  readonly permission: string | null;
  readonly run: (
    db: TenantScopedClient,
    session: CustomerWorkspaceContext,
  ) => Promise<AttentionItem | null>;
}[] = [
  { permission: 'content.read', run: publishingFailures },
  { permission: 'content.read', run: overdueSchedules },
  { permission: 'integrations.read', run: connectionsNeedingReauth },
  { permission: 'content.read', run: contentInReview },
  { permission: 'brand_brain.read', run: brandsWithNoKnowledge },
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
  const permitted = SOURCES.filter(
    (source) => source.permission === null || session.permissionKeys.includes(source.permission),
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

  return [...items].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
