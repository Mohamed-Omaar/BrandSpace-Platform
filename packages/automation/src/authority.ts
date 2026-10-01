import type { TenantScopedClient } from '@brandspace/database';
import type { AutomationActor } from './engine';

/**
 * THE CURRENT AUTHORITY OF A WORKSPACE MEMBER, OR NULL WHEN THEY HAVE NONE.
 *
 * ONE DEFINITION, THREE CALLERS (Phase 2B-3 PR 5). The worker asks it for the
 * rule's creator on every run; the engine asks it again for the same creator
 * when a person approves an asks-first request (owner decision D1), because a
 * request proposed under authority the creator has since lost must not be
 * carried out on their behalf. It lived in the worker, so the approval path
 * could not reach it without a second copy.
 *
 * An ACTIVE membership in THIS workspace, its role's permission keys and its
 * BrandScope, read through the tenant-scoped client — a membership in another
 * workspace is invisible rather than filtered.
 */
export async function memberAuthority(
  db: TenantScopedClient,
  workspaceId: string,
  userId: string,
): Promise<AutomationActor | null> {
  const membership = await db.membership.findFirst({
    where: { workspaceId, userId, status: 'ACTIVE' },
    select: {
      brandScope: true,
      role: {
        select: { key: true, permissions: { select: { permission: { select: { key: true } } } } },
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

/** `memberAuthority` bound to one workspace, as `AutomationEngine.deliver` takes it. */
export function memberAuthorityResolver(
  db: TenantScopedClient,
  workspaceId: string,
): (userId: string) => Promise<AutomationActor | null> {
  return (userId) => memberAuthority(db, workspaceId, userId);
}
