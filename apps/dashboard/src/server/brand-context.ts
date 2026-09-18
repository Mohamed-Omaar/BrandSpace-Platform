import 'server-only';
import { cookies } from 'next/headers';
import { brandScopeFilter } from '@brandspace/shared';
import { inWorkspace } from './customer-context';
// A TYPE-ONLY EDGE BACK: `route-scope` imports only `BrandScopeKind` from
// `brand-selection`, and types are erased, so there is no runtime cycle.
import { scopeForPath } from './route-scope';
import {
  BRAND_COOKIE,
  parseBrandCookie,
  resolveSelection,
  type AccessibleBrand,
  type BrandContext,
  type BrandContextSource,
  type BrandScopeKind,
} from './brand-selection';

/**
 * THE SERVER HALF OF THE GLOBAL BRAND CONTEXT (D-190, D-191, D-192).
 *
 * This module does the two things that need a request: reading the brands a
 * member may act on, and reading the cookie carrying their selection. Every
 * RULE it applies to what it reads lives in `brand-selection.ts`, which is not
 * `server-only` and is therefore asserted directly by the unit suite rather
 * than assumed.
 */

/*
 * RE-EXPORTED, so a page imports one module and the split stays an
 * implementation detail of this file rather than something every call site has
 * to know about.
 */
export {
  ALL_BRANDS,
  BRAND_COOKIE,
  brandCookieValue,
  brandFilterFor,
  defaultBrandFor,
  parseBrandCookie,
  requiredBrand,
  resolveSelection,
  safeReturnPath,
} from './brand-selection';
export type {
  AccessibleBrand,
  BrandContext,
  BrandContextSource,
  BrandResolution,
  BrandScopeKind,
} from './brand-selection';

/**
 * The brands this member may act on.
 *
 * `brandScopeFilter` goes INTO the query (D-132). An empty scope means
 * unrestricted within the workspace and contributes no clause; a set scope
 * restricts the rows the database returns, so a brand outside it is never read
 * and therefore cannot be leaked by a later mistake.
 *
 * DRAFT BRANDS COUNT. A brand being set up is one somebody is working on, and
 * excluding it would make the first brand in a new workspace invisible until
 * somebody activated it.
 */
export async function listAccessibleBrands(
  source: BrandContextSource,
): Promise<readonly AccessibleBrand[]> {
  return inWorkspace(source.workspaceId, async ({ db }) =>
    db.brand.findMany({
      where: {
        deletedAt: null,
        status: { in: ['ACTIVE', 'DRAFT'] },
        ...brandScopeFilter(source.brandScope),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, slug: true, status: true },
    }),
  );
}

/**
 * Resolve the brand context for one request.
 *
 * `requested` is the route's own `?brand=` value when it reads one. `null` and
 * `''` are treated as "the URL is silent" so a cleared query string falls back
 * to the stored selection rather than wiping it.
 */
export async function resolveBrandContext(
  source: BrandContextSource,
  options: {
    readonly scope: BrandScopeKind;
    readonly requested?: string | null | undefined;
    /** Supplied when the caller has already listed them, to avoid a second query. */
    readonly brands?: readonly AccessibleBrand[] | undefined;
  },
): Promise<BrandContext> {
  const brands = options.brands ?? (await listAccessibleBrands(source));
  const store = await cookies();
  return resolveSelection(brands, {
    scope: options.scope,
    requested: options.requested,
    stored: parseBrandCookie(store.get(BRAND_COOKIE)?.value, source.workspaceId),
  });
}

/**
 * The brand context for one page, by its path.
 *
 * THE ONE CALL A PAGE MAKES. It reads the route's declared scope from the table
 * (D-192) rather than taking the caller's word for it, so a page cannot quietly
 * grant itself an aggregate the table says it does not have — and a route that
 * was never declared reads no brand at all rather than guessing.
 */
export async function brandContextFor(
  source: BrandContextSource,
  path: string,
  requested?: string | null | undefined,
): Promise<BrandContext> {
  return resolveBrandContext(source, { scope: scopeForPath(path), requested });
}
