import { CreativeGenerationJobs } from '@brandspace/creative';
import type { ImageJobPort } from '@brandspace/copilot';
import type { TenantScopedClient } from '@brandspace/database';
import { AppError, brandIdQueryFilter } from '@brandspace/shared';

/** PR A (D-604) — the #119 job on a draft's first variant, for the loop and the plan card. */
export function imageJobs(db: TenantScopedClient, workspaceId: string): ImageJobPort {
  return {
    async generate(input) {
      const item = await db.contentItem.findFirst({
        where: {
          id: input.contentItemId,
          workspaceId,
          deletedAt: null,
          ...brandIdQueryFilter({ brandId: input.brandId, brandScope: input.actor.brandScope }),
        },
        select: {
          id: true,
          variants: { orderBy: { createdAt: 'asc' }, take: 1, select: { id: true } },
        },
      });
      const variant = item?.variants[0];
      if (!item || !variant) throw new AppError('NOT_FOUND', 'That post no longer exists.');
      const queued = await new CreativeGenerationJobs({ db, workspaceId }).enqueue({
        brandId: input.brandId,
        brandScope: input.actor.brandScope,
        requestedByUserId: input.actor.userId,
        idempotencyKey: input.idempotencyKey,
        brief: input.brief,
        formatKey: input.formatKey,
        quality: input.quality,
        contentVariantId: variant.id,
      });
      return { jobId: queued.job.id, contentVariantId: variant.id };
    },
  };
}
