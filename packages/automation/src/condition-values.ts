import type { TenantScopedClient } from '@brandspace/database';
import { brandInScope } from '@brandspace/shared';
import { CONDITION_FIELD_CONTRACTS, type AutomationCondition } from './registry';

/**
 * PHASE 2B-3 (PR 1) — THE VALUES A RULE NAMES MUST STILL RESOLVE FOR ITS BRAND.
 *
 * A condition on a brand, a campaign or a person stores an ID, and an id can go
 * stale: the campaign is deleted, the brand is archived, the person leaves or
 * their BrandScope stops covering the rule's brand. Compared as it stands, a
 * stale id quietly WIDENS a rule — "not in campaign X" matches every post once
 * X is gone, "not written by Sara" matches everything once Sara has left.
 *
 * SO A RUN WHOSE RULE NAMES A VALUE THAT NO LONGER RESOLVES DOES NOT EVALUATE.
 * It ends `SKIPPED` with `condition_value_unavailable`, and a person can see
 * why. The stored value is never dropped or rewritten; a rule whose value comes
 * back (a member re-admitted to the brand) matches again on the next run.
 *
 * ONE PREDICATE PER CATALOGUE, SHARED WITH THE AUTHORING SCREEN, so the list a
 * person picks from and the check a run applies cannot disagree:
 *
 *   brands    — a brand of this workspace, not deleted and not archived;
 *   campaigns — a campaign OF THE RULE'S BRAND, not deleted;
 *   members   — an ACTIVE member whose BrandScope admits the rule's brand
 *               (an empty scope admits every brand).
 *
 * `metricKeys` is a code catalogue, not tenant data, and is not checked here.
 */

export interface MemberChoice {
  readonly id: string;
  readonly name: string;
}

/**
 * The members a condition on THIS BRAND may name: ACTIVE, and admitted to the
 * brand by their BrandScope. The authoring screen offers exactly these.
 */
export async function memberCatalogueFor(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly brandId: string;
    /** The VIEWER'S BrandScope: a brand they cannot see has no member list. */
    readonly viewerBrandScope: readonly string[];
    readonly take?: number;
  },
): Promise<readonly MemberChoice[]> {
  /*
   * THE BRAND MUST BE THIS WORKSPACE'S AND THE VIEWER'S. Otherwise the members
   * with an unrestricted scope would be listed "for" a brand id from anywhere —
   * a list for a brand the caller has no business naming.
   */
  if (!UUID.test(input.brandId) || !brandInScope(input.viewerBrandScope, input.brandId)) return [];
  const brand = await db.brand.findFirst({
    where: { id: input.brandId, workspaceId: input.workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!brand) return [];

  const rows = await db.membership.findMany({
    where: {
      workspaceId: input.workspaceId,
      status: 'ACTIVE',
      OR: [{ brandScope: { isEmpty: true } }, { brandScope: { has: input.brandId } }],
    },
    select: { userId: true, user: { select: { name: true, email: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: Math.max(1, Math.min(input.take ?? 200, 200)),
  });
  return rows.map((row) => ({ id: row.userId, name: row.user.name ?? row.user.email }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every literal id a condition names, whatever its operator. */
function namedValues(condition: AutomationCondition): readonly string[] {
  const value = condition.value;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return [];
}

/**
 * DOES EVERY TENANT-DATA VALUE THIS RULE NAMES STILL RESOLVE FOR ITS BRAND?
 *
 * False as soon as one does not. A rule that names none (every rule without a
 * brand, campaign or person condition) is never asked the database anything.
 */
export async function conditionValuesResolve(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly brandId: string;
    readonly conditions: readonly AutomationCondition[];
  },
): Promise<boolean> {
  const wanted = {
    brands: new Set<string>(),
    campaigns: new Set<string>(),
    members: new Set<string>(),
  };
  for (const condition of input.conditions) {
    const catalogue = CONDITION_FIELD_CONTRACTS[condition.field]?.catalogue;
    if (catalogue === 'brands' || catalogue === 'campaigns' || catalogue === 'members') {
      for (const value of namedValues(condition)) wanted[catalogue].add(value);
    }
  }

  /*
   * AN ID THAT IS NOT A UUID RESOLVES TO NOTHING, and is never sent to the
   * database: comparing it to a `uuid` column is an error that would abort the
   * run's whole transaction rather than end one run.
   */
  const all = [...wanted.brands, ...wanted.campaigns, ...wanted.members];
  if (all.some((value) => !UUID.test(value))) return false;

  if (wanted.brands.size > 0) {
    const ids = [...wanted.brands];
    const found = await db.brand.count({
      where: {
        workspaceId: input.workspaceId,
        id: { in: ids },
        deletedAt: null,
        status: { not: 'ARCHIVED' },
      },
    });
    if (found !== ids.length) return false;
  }

  if (wanted.campaigns.size > 0) {
    const ids = [...wanted.campaigns];
    const found = await db.campaign.count({
      where: {
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        id: { in: ids },
        deletedAt: null,
      },
    });
    if (found !== ids.length) return false;
  }

  if (wanted.members.size > 0) {
    const ids = [...wanted.members];
    const found = await db.membership.count({
      where: {
        workspaceId: input.workspaceId,
        userId: { in: ids },
        status: 'ACTIVE',
        OR: [{ brandScope: { isEmpty: true } }, { brandScope: { has: input.brandId } }],
      },
    });
    if (found !== ids.length) return false;
  }

  return true;
}

/** The failure code a run records when a named value no longer resolves. */
export const CONDITION_VALUE_UNAVAILABLE = 'condition_value_unavailable';
