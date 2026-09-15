import type { Clock } from '@brandspace/shared';
import { systemClock } from '@brandspace/shared';
import type { TenantScopedClient } from '@brandspace/database';

/**
 * D-116 / D-117 retention purge.
 *
 * WHAT IT CLEARS AND WHAT IT LEAVES, which is the whole decision:
 *
 *   - It nulls the variant BODY — the customer's words — and stamps
 *     `bodyPurgedAt`, exactly as the Brand Brain chat purge does. The ROW
 *     survives, so the shape of the work, its provenance and its link to the
 *     `AiRequest` that produced it remain inspectable.
 *   - It soft-deletes the ITEM, so the library stops listing it.
 *   - IT TOUCHES NOTHING ELSE. No audit event, no credit transaction, no
 *     `ai_request`, no ledger row, no invoice. The owner's decision is explicit
 *     that a content-retention control must not reach records with their own
 *     statutory or operational retention, and the way to guarantee that is for
 *     this function to name only two tables and for a test to hold it to that.
 *
 * Bounded and idempotent, like every other sweep in the platform: a second run
 * over the same rows finds nothing left to do.
 */
export interface ContentPurgeResult {
  readonly variantsPurged: number;
  readonly itemsExpired: number;
}

export async function purgeExpiredContent(input: {
  db: TenantScopedClient;
  clock?: Clock;
  limit?: number;
}): Promise<ContentPurgeResult> {
  const clock = input.clock ?? systemClock;
  const limit = input.limit ?? 500;
  const now = clock.now();

  const expired = await input.db.contentVariant.findMany({
    where: { expiresAt: { lte: now }, bodyPurgedAt: null, body: { not: null } },
    select: { id: true },
    take: limit,
  });

  let variantsPurged = 0;
  if (expired.length > 0) {
    const result = await input.db.contentVariant.updateMany({
      where: { id: { in: expired.map((v) => v.id) } },
      // The words go; the row, its accounting links and its provenance stay.
      data: { body: null, bodyPurgedAt: now },
    });
    variantsPurged = result.count;
  }

  const items = await input.db.contentItem.findMany({
    where: { expiresAt: { lte: now }, deletedAt: null },
    select: { id: true },
    take: limit,
  });

  let itemsExpired = 0;
  if (items.length > 0) {
    const result = await input.db.contentItem.updateMany({
      where: { id: { in: items.map((i) => i.id) } },
      data: { deletedAt: now },
    });
    itemsExpired = result.count;
  }

  return { variantsPurged, itemsExpired };
}
