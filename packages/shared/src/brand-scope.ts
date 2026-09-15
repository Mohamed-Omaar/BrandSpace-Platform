import { AppError } from './errors';

/**
 * Brand-scope resolution — docs/SECURITY.md §4.2.
 *
 * "Brand | `brand.content.create` | membership role **and** brand in
 * `brandScope`." Phase 5A introduced the first brand-scoped resources and no
 * code path consulted the field: a member could name any `brandId` in their own
 * workspace and reach it (F-74). Not exploitable at the time — nothing sets
 * `brandScope`, so it is empty for every membership in existence — and exactly
 * the kind of gap that becomes a real privilege escalation on the day a
 * scope-setting screen ships, with nothing failing to announce it.
 *
 * ONE PLACE, DELIBERATELY. Every surface that accepts a `brandId` calls the same
 * two functions, so the rule cannot be implemented four times and forgotten on
 * the fifth. Each is small enough to read in one sitting, which is the property
 * an authorization rule most needs.
 *
 * WHAT EMPTY MEANS. Unrestricted. The schema says so — "null = all brands in
 * the workspace; a non-empty array restricts the member" — and it matters that
 * the default is permissive rather than denying: the field is empty for every
 * membership that exists today, so a deny-by-default reading would lock every
 * customer out of their own brands. Restriction is opt-in and explicit.
 *
 * WHY IT LIVES IN `shared`. Every layer needs it — the services in
 * `brand-brain`, the server actions in the dashboard, the route in the API —
 * and the module boundary matrix does not let a domain package import `auth`.
 * `shared` is already where the permission catalogue and the role definitions
 * live, which makes it the right home rather than merely the reachable one.
 *
 * THIS IS NOT TENANT ISOLATION. RLS already makes another workspace's brands
 * invisible, and that is the boundary the database enforces. This is the finer
 * grain INSIDE one workspace, where every row is legitimately visible to the
 * tenant and the question is which of them this particular member may act on.
 */

/** Whether a member restricted to `brandScope` may act on `brandId`. */
export function brandInScope(
  brandScope: readonly string[] | null | undefined,
  brandId: string,
): boolean {
  if (!brandScope || brandScope.length === 0) return true;
  return brandScope.includes(brandId);
}

/**
 * Refuse an out-of-scope brand the way a missing one is refused.
 *
 * A 404 with the same shape and the same code as a genuine miss (CLAUDE.md
 * §2.1). "Forbidden" would confirm that the brand exists, which tells a member
 * restricted to one brand exactly how many others their colleagues have — an
 * inference the isolation rule closes for other tenants and that there is no
 * reason to leave open here.
 */
export function assertBrandInScope(
  brandScope: readonly string[] | null | undefined,
  brandId: string,
): void {
  if (brandInScope(brandScope, brandId)) return;
  throw new AppError('NOT_FOUND', 'Brand not found');
}

/**
 * A Prisma `where` fragment restricting a brand query to the member's scope.
 *
 * For LISTS and for "the workspace's first brand", where refusing after the
 * fact would still have read rows the member may not see. An empty scope
 * contributes no filter, so the query is exactly what it was.
 */
export function brandScopeFilter(brandScope: readonly string[] | null | undefined): {
  id?: { in: string[] };
} {
  if (!brandScope || brandScope.length === 0) return {};
  return { id: { in: [...brandScope] } };
}

/**
 * A Prisma `where` fragment restricting a BRAND-SCOPED CHILD row to the
 * member's scope — `calendar_slot`, `approval`, `content_item`, `audit_event`.
 *
 * The sibling of `brandScopeFilter()`, which filters the `brand` table itself
 * by `id`; this one filters anything that REFERENCES a brand, by `brandId`.
 * Both read an empty or absent scope as UNRESTRICTED and contribute no clause,
 * which is the platform rule `brandInScope()` has carried since Phase 2B.
 *
 * IT EXISTS BECAUSE THE RULE WAS RE-IMPLEMENTED THREE TIMES and got a different
 * answer each time: the approvals queue read an empty scope as "no brands" and
 * returned nothing, the activity log did the same, and two dashboard pages
 * compensated by expanding an empty scope into "every brand id" before calling
 * them. One helper, one answer.
 */
export function brandIdScopeFilter(brandScope: readonly string[] | null | undefined): {
  brandId?: { in: string[] };
} {
  if (!brandScope || brandScope.length === 0) return {};
  return { brandId: { in: [...brandScope] } };
}

/**
 * THE ONE WAY TO COMBINE A CALLER'S BRAND FILTER WITH THEIR AUTHORIZATION
 * SCOPE. Returns an `AND` so the two INTERSECT and neither can replace the
 * other.
 *
 * WHY THIS EXISTS RATHER THAN TWO SPREADS. The obvious composition is wrong in
 * a way that reads as correct:
 *
 *     ...(input.brandId ? { brandId: input.brandId } : {}),
 *     ...brandIdScopeFilter(input.brandScope),
 *
 * Both fragments set the SAME key, and in an object literal the later one
 * WINS — so a non-empty scope silently REPLACED the caller's explicit brand
 * rather than narrowing it. That is the identical "later key wins" defect the
 * Activity Log was corrected for, reintroduced one milestone later by the very
 * change that was meant to make scope a query predicate. A helper that can only
 * produce an `AND` is the way it stops recurring.
 *
 * THE SEMANTICS, stated so the tests can assert them directly:
 *
 *   | `brandId` | `brandScope` | result                                |
 *   | --------- | ------------ | ------------------------------------- |
 *   | —         | `[]`         | unrestricted within the workspace     |
 *   | —         | `[A]`        | only A                                |
 *   | B         | `[]`         | only B                                |
 *   | A         | `[A, B]`     | only A                                |
 *   | C         | `[A, B]`     | nothing — C is outside the scope      |
 *
 * The last row matters: an out-of-scope `brandId` yields an empty result rather
 * than an error, which is the masked-empty behaviour §2.1 asks for — a member
 * learns nothing about whether brand C exists.
 */
export function brandIdQueryFilter(input: {
  brandId?: string | undefined;
  brandScope?: readonly string[] | null | undefined;
}): { AND: { brandId?: string | { in: string[] } }[] } {
  const clauses: { brandId?: string | { in: string[] } }[] = [];
  if (input.brandId) clauses.push({ brandId: input.brandId });
  const scope = brandIdScopeFilter(input.brandScope);
  if (scope.brandId) clauses.push(scope);
  return { AND: clauses };
}
