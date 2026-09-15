/**
 * WHO MAY SEE WHICH ACTIVITY — docs/SECURITY.md §4.3, "View activity log".
 *
 * The matrix grades this capability four ways rather than two, and the grading
 * is the interesting part:
 *
 *   Workspace Owner, Workspace Admin        ✅  the whole workspace
 *   Marketing Manager, Analyst              🟡  their brands
 *   Content Creator, Copywriter, Designer,
 *   Approver                                🟡  their own actions
 *   Viewer (read-only)                      ➖  nothing
 *
 * IT GRADES `audit.read`, IT DOES NOT REPLACE IT. That permission has existed
 * since Phase 1 and already carries the two wider rows; Phase 5B-3 adds
 * `audit.read_workspace` above it and `audit.read_own` below it, rather than a
 * parallel `activity.*` family that would have been a second permission for the
 * same capability.
 *
 * IT IS RESOLVED FROM PERMISSIONS, NOT FROM THE ROLE KEY. A role in this
 * platform IS its permission set; a capability that secretly consulted the role
 * name instead could not be reasoned about, could not be overridden, and would
 * silently mis-grade any role added later. Most privileged wins, so a role
 * holding two keys gets the wider view rather than an arbitrary one.
 *
 * AN EMPTY `brandScope` MEANS UNRESTRICTED — the platform rule, not a local
 * one. `brandInScope()` and `brandScopeFilter()` have said so since Phase 2B: a
 * membership with no brands listed is scoped to ALL the workspace's brands, and
 * a membership listing brands is scoped to those. The first version of this
 * file read an empty list as "no brands", which inverted the rule and would
 * have shown a brand-graded member with an unrestricted membership NOTHING —
 * failing closed, but wrongly, and disagreeing with every other reader of the
 * same field. `kind: 'brand'` with `brandIds: null` is that case, stated in the
 * type so a consumer cannot forget it.
 */

export type ActivityScope =
  | { kind: 'workspace' }
  /** `brandIds: null` is UNRESTRICTED — an empty membership scope, per the platform rule. */
  | { kind: 'brand'; brandIds: readonly string[] | null }
  | { kind: 'own'; userId: string }
  | { kind: 'none' };

export function resolveActivityScope(input: {
  permissionKeys: readonly string[];
  userId: string;
  brandScope: readonly string[] | null | undefined;
}): ActivityScope {
  if (input.permissionKeys.includes('audit.read_workspace')) return { kind: 'workspace' };
  if (input.permissionKeys.includes('audit.read')) {
    const scope = input.brandScope;
    return { kind: 'brand', brandIds: !scope || scope.length === 0 ? null : [...scope] };
  }
  if (input.permissionKeys.includes('audit.read_own')) {
    return { kind: 'own', userId: input.userId };
  }
  return { kind: 'none' };
}
