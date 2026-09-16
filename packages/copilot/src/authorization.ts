import type { TenantScopedClient } from '@brandspace/database';

/**
 * WHO THIS PERSON IS, RIGHT NOW — resolved from the database at the moment a
 * tool runs, not carried forward from when the plan was shown.
 *
 * THIS FILE EXISTS BECAUSE A PREVIEW IS NOT AUTHORIZATION.
 *
 * The sequence a Copilot plan goes through is: the model proposes, the customer
 * reads a preview, the customer confirms, the steps execute. Minutes can pass
 * between the second and the fourth, and in those minutes an administrator can
 * change the person's role, narrow their BrandScope, or remove them from the
 * workspace entirely. A design that resolved permissions once, at preview, and
 * trusted them at execution would let a plan built by a Marketing Manager
 * execute after that person became a Viewer — with the plan itself as the only
 * evidence they ever had the authority.
 *
 * So permissions and brand scope are RE-READ from the live membership on every
 * execution, from the role the membership actually points at now. The HTTP layer
 * has already resolved a session; this is deliberately a SECOND, independent
 * resolution against the same tables, and it is the one the tools obey.
 *
 * IT READS THROUGH THE TENANT-SCOPED CLIENT, so RLS applies: a membership row
 * for another workspace is not merely filtered out, it is invisible.
 */

export interface LiveAuthorization {
  readonly userId: string;
  readonly roleKey: string;
  readonly permissionKeys: readonly string[];
  /** Empty or absent means UNRESTRICTED — the platform rule since Phase 2B. */
  readonly brandScope: readonly string[];
}

/**
 * Resolve the caller's current authority, or null when they no longer have any.
 *
 * NULL IS THE IMPORTANT RETURN, and every caller treats it as a refusal rather
 * than as an empty permission list: a removed member and a member with no
 * permissions are different situations, and only the first should stop a plan
 * with "you are no longer a member of this workspace".
 */
export async function resolveLiveAuthorization(
  db: TenantScopedClient,
  workspaceId: string,
  userId: string,
): Promise<LiveAuthorization | null> {
  const membership = await db.membership.findFirst({
    where: { workspaceId, userId, status: 'ACTIVE' },
    select: {
      brandScope: true,
      role: {
        select: {
          key: true,
          permissions: { select: { permission: { select: { key: true } } } },
        },
      },
    },
  });
  if (!membership) return null;

  return {
    userId,
    roleKey: membership.role.key,
    permissionKeys: membership.role.permissions.map((row) => row.permission.key),
    brandScope: membership.brandScope,
  };
}

/**
 * Does this authorization admit this permission?
 *
 * A function rather than an inline `includes` at ten call sites, so "how do we
 * decide?" has one answer. It is also where a future refinement — a
 * brand-conditional permission, say — would land once rather than ten times.
 */
export function holds(authorization: LiveAuthorization, permissionKey: string): boolean {
  return authorization.permissionKeys.includes(permissionKey);
}
