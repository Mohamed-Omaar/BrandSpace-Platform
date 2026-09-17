import type { TenantScopedClient } from '@brandspace/database';

/**
 * WHO IS TOLD — a permission question AND a BrandScope question (P7-R10).
 *
 * WHY IT LIVES HERE RATHER THAN IN A WORKER FILE. It was a Prisma query inlined
 * in `apps/worker`, so nothing could test it and nothing could share it. The
 * rule it encodes — "the people who may act on this, for THIS brand" — is a
 * platform rule, not a worker detail, and the next surface that needs to notify
 * somebody should reach this rather than write a fourth version of it.
 *
 * THE DEFECT IT FIXES. The worker selected every active member whose role
 * carries the permission and stopped there. So a member restricted to Brand A
 * was told that Brand B's automation wanted to publish — a notification naming a
 * brand they may not see, pointing at a run they may not confirm, and one they
 * would have to ask a colleague about to understand. BrandScope is a boundary
 * INSIDE the tenant, and it governs who is TOLD as much as who may act.
 *
 * THREE PREDICATES, ALL IN THE QUERY (D-132):
 *
 *   - the membership is ACTIVE in this workspace;
 *   - its role carries the permission;
 *   - its BrandScope admits this brand.
 *
 * EMPTY MEANS UNRESTRICTED, and that arm is written explicitly rather than left
 * to a missing clause. An empty `brandScope` is "all brands in the workspace"
 * (the Phase 2B rule) and every membership in existence today is empty, so a
 * deny-by-default reading here would silence every notification in the product.
 *
 * THE CAP IS A CAP, NOT A PAGE. A notification fan-out is bounded so one event
 * cannot write ten thousand rows; a workspace larger than the cap is a product
 * conversation, not something to page through here.
 */
export async function resolveRecipients(input: {
  db: TenantScopedClient;
  workspaceId: string;
  permissionKey: string;
  /** The brand the event is about. Null for a workspace-level event. */
  brandId: string | null;
  limit?: number | undefined;
}): Promise<readonly string[]> {
  const memberships = await input.db.membership.findMany({
    where: {
      workspaceId: input.workspaceId,
      status: 'ACTIVE',
      role: { permissions: { some: { permission: { key: input.permissionKey } } } },
      ...(input.brandId
        ? {
            OR: [{ brandScope: { isEmpty: true } }, { brandScope: { has: input.brandId } }],
          }
        : {}),
    },
    select: { userId: true },
    take: Math.max(1, Math.min(input.limit ?? 50, 200)),
  });
  return memberships.map((membership) => membership.userId);
}
