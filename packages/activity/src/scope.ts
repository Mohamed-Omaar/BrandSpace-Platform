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
 */

export type ActivityScope =
  | { kind: 'workspace' }
  | { kind: 'brand'; brandIds: readonly string[] }
  | { kind: 'own'; userId: string }
  | { kind: 'none' };

export function resolveActivityScope(input: {
  permissionKeys: readonly string[];
  userId: string;
  brandScope: readonly string[];
}): ActivityScope {
  if (input.permissionKeys.includes('audit.read_workspace')) return { kind: 'workspace' };
  if (input.permissionKeys.includes('audit.read')) {
    return { kind: 'brand', brandIds: input.brandScope };
  }
  if (input.permissionKeys.includes('audit.read_own')) {
    return { kind: 'own', userId: input.userId };
  }
  return { kind: 'none' };
}
