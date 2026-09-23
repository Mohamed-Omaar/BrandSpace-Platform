import type { PrismaClient } from '@brandspace/database';
import { AppError } from '@brandspace/shared';

/**
 * WHICH BRANDS A PERSON MAY BE GIVEN — one rule for both grant paths (P6-13).
 *
 * BrandScope is authorization inside the tenant: empty means every brand in the
 * workspace, and a list means those brands only. Two paths hand it to a person —
 * an invitation, and a change to an existing member — and until now neither
 * checked what it was handed:
 *
 *   - `InvitationService.create` stored `brandScope` unvalidated, and the Team
 *     screen never sent one, so EVERY invitation granted every brand — including
 *     one issued by a member who could see a single brand. A restricted inviter
 *     could mint an unrestricted colleague.
 *   - nothing could change a member's scope at all.
 *
 * THE RULE, applied identically on both paths:
 *
 *   1. every requested brand must be a live brand of THIS workspace — an id from
 *      another workspace, or one that never existed, is refused, and refused the
 *      same way (no oracle);
 *   2. an actor who is themselves RESTRICTED may grant only a non-empty subset of
 *      their own brands — never "all brands", which is the one value a restricted
 *      actor cannot hold and therefore cannot give.
 *
 * `actorBrandScope: null` is a platform operator acting through the Control
 * Center, who holds no BrandScope inside the tenant and is not ranked by it —
 * the same reason the role ladder does not rank a platform inviter.
 */
export const MAX_BRAND_SCOPE_ENTRIES = 200;

export async function resolveGrantableBrandScope(
  db: Pick<PrismaClient, 'brand'>,
  input: {
    readonly workspaceId: string;
    readonly actorBrandScope: readonly string[] | null;
    readonly requested: readonly string[];
  },
): Promise<string[]> {
  const requested = [...new Set(input.requested.map((id) => id.trim()).filter(Boolean))];
  if (requested.length > MAX_BRAND_SCOPE_ENTRIES) {
    throw new AppError('VALIDATION_FAILED', 'Too many brands.');
  }

  if (requested.length > 0) {
    const found = await db.brand.findMany({
      where: { workspaceId: input.workspaceId, id: { in: requested }, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== requested.length) {
      throw new AppError('VALIDATION_FAILED', 'Unknown brand.');
    }
  }

  const actorScope = input.actorBrandScope;
  if (actorScope !== null && actorScope.length > 0) {
    if (requested.length === 0) {
      throw new AppError(
        'FORBIDDEN',
        'A brand-restricted member cannot grant access to all brands.',
      );
    }
    const allowed = new Set(actorScope);
    if (!requested.every((id) => allowed.has(id))) {
      throw new AppError('FORBIDDEN', 'A member can only grant brands they can access.');
    }
  }

  return requested;
}
