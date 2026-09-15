import { assertBrandInScope, AppError, type PermissionScope } from '@brandspace/shared';

/**
 * Who is acting, and what they may do.
 *
 * THE AUTHORISATION BOUNDARY IS THE SERVICE, NOT THE CALLER. F-74 is the
 * cautionary case: Phase 5A introduced brand-scoped resources and no code path
 * consulted `Membership.brandScope`, so a member could name any brandId in
 * their own workspace and reach it. It was not exploitable at the time — the
 * field is empty for every membership in existence — and it is exactly the gap
 * that becomes a privilege escalation on the day a scope-setting screen ships,
 * with nothing failing to announce it.
 *
 * So every field below is REQUIRED, and every service method takes an actor
 * rather than a user id. An optional `brandScope` would default to unrestricted
 * and a call site that forgot it would silently admit every brand; a required
 * one makes that a type error at the call site instead. The same reasoning
 * applies to `permissionKeys`: a service that trusts its caller to have checked
 * is a service with no authorisation at all, because a server action is a
 * public HTTP endpoint.
 */
export interface AssetActor {
  readonly userId: string;
  /**
   * The actor's RESOLVED permissions. REQUIRED: this package is the
   * authorisation boundary, and a check that lives only in a page or a server
   * action is not a check.
   */
  readonly permissionKeys: readonly string[];
  /**
   * The member's brand scope — docs/SECURITY.md §4.2, F-74.
   *
   * REQUIRED. Empty means unrestricted, which is what the schema says ("null =
   * all brands in the workspace; a non-empty array restricts the member") and
   * what every membership carries today. Restriction is opt-in and explicit.
   */
  readonly brandScope: readonly string[];
}

/** The scope every Asset Library permission is granted at. */
export const ASSET_PERMISSION_SCOPE: PermissionScope = 'workspace';

export function hasPermission(actor: AssetActor, key: string): boolean {
  return actor.permissionKeys.includes(key);
}

/**
 * Refuse an actor without the permission.
 *
 * FORBIDDEN, not NOT_FOUND, and the distinction is deliberate rather than an
 * inconsistency with `assertBrandInScope` below. A permission failure discloses
 * nothing about what EXISTS: the caller is already inside their own workspace
 * and already knows the Asset Library is a feature. Telling them they lack
 * `assets.delete` is actionable — they can ask an admin — whereas a 404 would
 * send them hunting for a missing asset that is sitting in front of them.
 *
 * The brand-scope check is the opposite case and gets the opposite answer,
 * because there the existence of the brand is the secret.
 */
export function assertPermission(actor: AssetActor, key: string): void {
  if (hasPermission(actor, key)) return;
  throw new AppError('FORBIDDEN', 'You do not have permission to do that.');
}

/**
 * Refuse an out-of-scope brand the way a missing one is refused.
 *
 * A 404 with the same shape and the same code as a genuine miss (CLAUDE.md
 * §2.1). "Forbidden" would confirm the brand exists, which tells a member
 * restricted to one brand exactly how many others their colleagues have.
 *
 * A NULL BRAND IS ALWAYS IN SCOPE, and that is not a hole. A workspace-level
 * asset belongs to the workspace rather than to any brand, so there is no brand
 * for a brand restriction to be about; `brandScope` restricts which BRANDS a
 * member may act on, and a member restricted to brand X is still a member of
 * the workspace. Withholding workspace-level assets from them would hide the
 * shared logo pack and the contract templates from everyone with a scope set,
 * which is the opposite of what the field is for.
 */
export function assertAssetBrandInScope(actor: AssetActor, brandId: string | null): void {
  if (brandId === null) return;
  assertBrandInScope(actor.brandScope, brandId);
}

/**
 * The SAME rule as a query PREDICATE (D-132).
 *
 * `assertAssetBrandInScope` above is the right check in the wrong place when
 * the brand it is given came out of a row that was just fetched by id: the row
 * is read, and only then rejected. D-132 says the authorization belongs in the
 * `where`, so an out-of-scope row is never retrieved at all — and, just as
 * importantly, an out-of-scope id becomes indistinguishable from an id that
 * never existed, instead of failing a little later with a different message.
 *
 * IT CARRIES THE NULL-BRAND RULE WITH IT, and it has to. A workspace-level
 * asset or folder has no brand, and `brandId IN (…)` is never true of NULL —
 * so a bare scope filter would hide the shared logo pack from every member who
 * has a scope set. The `OR` is what keeps this equivalent to the assertion it
 * replaces rather than quietly stricter.
 *
 * An EMPTY scope is UNRESTRICTED, the platform rule since Phase 2B, and
 * produces no predicate at all.
 */
export function assetBrandScopeFilter(actor: AssetActor): {
  OR?: ({ brandId: null } | { brandId: { in: string[] } })[];
} {
  if (actor.brandScope.length === 0) return {};
  return { OR: [{ brandId: null }, { brandId: { in: [...actor.brandScope] } }] };
}
