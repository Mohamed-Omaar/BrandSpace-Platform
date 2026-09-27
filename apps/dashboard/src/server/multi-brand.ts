import { MULTI_BRAND_FEATURE } from '@brandspace/entitlements';
import { AppError, brandScopeFilter } from '@brandspace/shared';
import type { AccessibleBrand } from './brand-selection';

/**
 * MULTI-BRAND OFF: ONE WORKSPACE, ONE BRAND (Q2b, D-327).
 *
 * The two rules the flag decides, kept out of `server-only` modules so the
 * isolation suite runs them against PostgreSQL with a real entitlements
 * engine rather than trusting a source-text match:
 *
 *   - `assertMayCreateAnotherBrand` — the SERVER refuses a second live brand
 *     while the flag is off, whatever a screen offered;
 *   - `readAccessibleBrands` — brand switching is hidden while the flag is off:
 *     the member acts on the workspace's OLDEST brand they may see, so every
 *     screen resolves to it and the rail shows a card, not a selector.
 *
 * Nothing is deleted or rewritten: a workspace that already had several
 * brands keeps them all, and they come back the moment the flag is on.
 */

/** The slice of `EntitlementService` these rules ask. */
export interface FeatureGate {
  can(workspaceId: string, featureKey: string): Promise<boolean>;
}

/** The slice of the scoped client these rules use. Structural, for testing. */
export interface BrandRulesClient {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  brand: {
    count(args: unknown): Promise<number>;
    findMany(args: unknown): Promise<AccessibleBrand[]>;
  };
}

export async function multiBrandEnabled(gate: FeatureGate, workspaceId: string): Promise<boolean> {
  return gate.can(workspaceId, MULTI_BRAND_FEATURE);
}

/**
 * Refuse a SECOND live brand while multi-brand is off.
 *
 * Runs inside the caller's transaction. The workspace row is locked first, so
 * two different first brands submitted at once cannot both see "none yet".
 */
export async function assertMayCreateAnotherBrand(
  db: BrandRulesClient,
  gate: FeatureGate,
  workspaceId: string,
): Promise<void> {
  if (await multiBrandEnabled(gate, workspaceId)) return;
  await db.$queryRaw`SELECT "id" FROM "workspace" WHERE "id" = ${workspaceId}::uuid FOR UPDATE`;
  const live = await db.brand.count({ where: { workspaceId, deletedAt: null } });
  if (live > 0) {
    throw new AppError(
      'FORBIDDEN',
      'This workspace already has its brand. Several brands in one workspace are not available.',
      { reason: 'MULTI_BRAND_OFF' },
    );
  }
}

/**
 * The brands this member may act on, under the flag.
 *
 * `brandScopeFilter` goes INTO the query (D-132), so a brand outside the
 * member's scope is never read.
 */
export async function readAccessibleBrands(
  db: BrandRulesClient,
  gate: FeatureGate,
  workspaceId: string,
  brandScope: readonly string[],
): Promise<AccessibleBrand[]> {
  const where = {
    deletedAt: null,
    status: { in: ['ACTIVE', 'DRAFT'] },
    ...brandScopeFilter(brandScope),
  };
  const select = { id: true, name: true, slug: true, status: true };
  if (!(await multiBrandEnabled(gate, workspaceId))) {
    return db.brand.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 1,
      select,
    });
  }
  return db.brand.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], select });
}
