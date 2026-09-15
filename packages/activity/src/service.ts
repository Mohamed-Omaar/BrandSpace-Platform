import type { AuditEvent, TenantScopedClient } from '@brandspace/database';
import { resolveActivityScope, type ActivityScope } from './scope';

/**
 * The customer's Activity Log — docs/PRODUCT.md §5 module 17, AC-15.2 and
 * AC-15.3.
 *
 * IT IS A READ MODEL OVER `audit_event`, AND IT ADDS NO TABLE. That is the
 * central decision. A customer-facing event table beside the audit trail would
 * be two records of the same facts, drifting apart at the first code path that
 * wrote one and forgot the other — and a MUTABLE one, which is exactly what
 * AC-15.7 and the append-only trigger exist to prevent. So the screen reads the
 * record the platform already keeps, and the guarantee is untouched.
 *
 * FOUR THINGS THIS SERVICE NEVER DOES:
 *
 *   1. It never writes. There is no create, update or delete on this class, and
 *      the application role has had UPDATE and DELETE revoked on the table
 *      since the RLS migration besides.
 *
 *   2. It never returns `before`/`after`. Those diffs are written redacted, but
 *      "redacted" is a property of the writer and the customer screen does not
 *      need to depend on every past and future writer having got it right. The
 *      log renders WHAT happened to WHICH thing by WHOM — the platform audit
 *      surface (AC-15.4) is where diffs are read.
 *
 *   3. It never returns events from outside the workspace. RLS makes that true
 *      at the database; the `workspaceId` predicate here makes it true twice,
 *      which is what CLAUDE.md §2.1 asks for (AC-15.3).
 *
 *   4. It never widens a scope. A reader graded "own" gets an `actorId`
 *      predicate IN THE QUERY, not a filter applied to a workspace-wide result
 *      — a count or a page boundary computed over rows they may not see is
 *      itself a disclosure.
 *
 * A CALLER'S FILTER CAN ONLY NARROW, NEVER REPLACE. This is the part that was
 * wrong, and it was wrong in the most dangerous possible way: the first version
 * spread `filter.brandId` and `filter.actorId` into the same object literal as
 * the authorization predicate, AFTER it. In JavaScript the later key wins, so
 * `?brandId=<another brand>` overwrote a brand-graded reader's own brand
 * predicate and `?actorId=<a colleague>` overwrote an own-graded reader's
 * `actorId = me` — turning the query string into a privilege escalation. Every
 * predicate is now composed with AND, so a filter can only ever intersect what
 * authorization already allows, and a filter naming something outside the scope
 * returns nothing rather than reaching past it.
 */

/** One row as the customer screen sees it. Deliberately narrow. */
export interface ActivityEntry {
  id: string;
  occurredAt: Date;
  action: string;
  actorType: AuditEvent['actorType'];
  actorId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  brandId: string | null;
  outcome: AuditEvent['outcome'];
  severity: AuditEvent['severity'];
}

export interface ActivityPage {
  entries: ActivityEntry[];
  /** `occurredAt` + `id` of the last row, for keyset paging. */
  nextCursor: string | null;
  scope: ActivityScope['kind'];
}

export interface ActivityFilter {
  /** Restrict to one brand. Intersected with the scope, never unioned. */
  brandId?: string;
  /** Restrict to one action key, e.g. `content.approved`. */
  action?: string;
  /** Restrict to one actor. Intersected with the scope. */
  actorId?: string;
  since?: Date;
  until?: Date;
}

export interface ActivityOptions {
  db: TenantScopedClient;
  workspaceId: string;
}

const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export class ActivityLogService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;

  constructor(options: ActivityOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
  }

  /**
   * A page of activity the reader is entitled to, newest first.
   *
   * KEYSET PAGED on `(occurredAt, id)` rather than by offset. Audit rows arrive
   * continuously, and an OFFSET page re-reads a shifting window — a reader
   * paging through a busy workspace would see rows twice and miss others.
   */
  async page(input: {
    viewer: { userId: string; permissionKeys: readonly string[]; brandScope: readonly string[] };
    filter?: ActivityFilter;
    cursor?: string | null;
    take?: number;
  }): Promise<ActivityPage> {
    const scope = resolveActivityScope({
      permissionKeys: input.viewer.permissionKeys,
      userId: input.viewer.userId,
      brandScope: input.viewer.brandScope,
    });
    if (scope.kind === 'none') return { entries: [], nextCursor: null, scope: 'none' };

    const take = Math.min(Math.max(input.take ?? PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const filter = input.filter ?? {};

    const rows = await this.#db.auditEvent.findMany({
      where: {
        workspaceId: this.#workspaceId,
        /*
         * AND, NOT SPREAD. Authorization and the caller's filter are separate
         * clauses that must BOTH hold; spreading them into one object let the
         * later key silently replace the earlier one. See the note above.
         */
        AND: [scopeWhere(scope), filterWhere(filter), parseCursor(input.cursor)],
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      select: {
        id: true,
        occurredAt: true,
        action: true,
        actorType: true,
        actorId: true,
        resourceType: true,
        resourceId: true,
        brandId: true,
        outcome: true,
        severity: true,
      },
    });

    const hasMore = rows.length > take;
    const entries = (hasMore ? rows.slice(0, take) : rows) as ActivityEntry[];
    const last = entries.at(-1);
    return {
      entries,
      nextCursor: hasMore && last ? `${last.occurredAt.toISOString()}|${last.id}` : null,
      scope: scope.kind,
    };
  }

  /**
   * The most recent entries, for the Command Center's activity panel.
   *
   * The same scoping as `page()` because it is the same query — a dashboard
   * widget that reached past the reader's grade would be the leak, and widgets
   * are exactly where such a thing hides.
   */
  async recent(input: {
    viewer: { userId: string; permissionKeys: readonly string[]; brandScope: readonly string[] };
    take?: number;
  }): Promise<ActivityEntry[]> {
    const { entries } = await this.page({ viewer: input.viewer, take: input.take ?? 6 });
    return entries;
  }

  /** The distinct action keys present, so a filter offers only real options. */
  async actions(input: {
    viewer: { userId: string; permissionKeys: readonly string[]; brandScope: readonly string[] };
  }): Promise<string[]> {
    const scope = resolveActivityScope({
      permissionKeys: input.viewer.permissionKeys,
      userId: input.viewer.userId,
      brandScope: input.viewer.brandScope,
    });
    if (scope.kind === 'none') return [];
    const rows = await this.#db.auditEvent.findMany({
      // The SAME scope predicate the page uses. A filter's options must not be
      // drawn from a wider set than the rows the reader may actually see, or
      // the dropdown becomes a way to enumerate what happened elsewhere.
      where: { workspaceId: this.#workspaceId, AND: [scopeWhere(scope)] },
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' },
      take: 200,
    });
    return rows.map((r) => r.action);
  }
}

/**
 * A cursor is data from the client, so it is PARSED rather than trusted. An
 * unparseable one starts from the top instead of throwing: a stale link in a
 * bookmark should show the newest activity, not an error page.
 */
function parseCursor(cursor: string | null | undefined): Record<string, unknown> {
  if (!cursor) return {};
  const [iso, id] = cursor.split('|');
  if (!iso || !id) return {};
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return {};
  return {
    OR: [{ occurredAt: { lt: at } }, { occurredAt: at, id: { lt: id } }],
  };
}

/**
 * The AUTHORIZATION predicate. Nothing a caller sends can relax it.
 *
 * `brandIds: null` is an UNRESTRICTED membership (the platform rule — see
 * `scope.ts`), so it contributes no brand clause, exactly as
 * `brandScopeFilter()` does for every other list in the product. A restricted
 * membership contributes `brandId IN (...)`, and a membership restricted to an
 * empty set cannot occur — `resolveActivityScope` maps that to `null`.
 */
function scopeWhere(scope: ActivityScope): Record<string, unknown> {
  if (scope.kind === 'brand') {
    return scope.brandIds === null ? {} : { brandId: { in: [...scope.brandIds] } };
  }
  if (scope.kind === 'own') return { actorId: scope.userId };
  return {};
}

/** The caller's filter. Only ever narrowing, because it is ANDed with the above. */
function filterWhere(filter: ActivityFilter): Record<string, unknown> {
  return {
    ...(filter.brandId ? { brandId: filter.brandId } : {}),
    ...(filter.action ? { action: filter.action } : {}),
    ...(filter.actorId ? { actorId: filter.actorId } : {}),
    ...(filter.since || filter.until
      ? {
          occurredAt: {
            ...(filter.since ? { gte: filter.since } : {}),
            ...(filter.until ? { lte: filter.until } : {}),
          },
        }
      : {}),
  };
}
