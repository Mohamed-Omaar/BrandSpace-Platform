import type { TenantScopedClient } from '@brandspace/database';
import { brandIdQueryFilter } from '@brandspace/shared';

/**
 * F5 — HOW MANY POSTS WERE PUBLISHED, counted ONE way for every screen.
 *
 * Home's "Published" figure and Performance used to count different things:
 * Home counted publish JOBS — one per channel, so a post sent to Instagram and
 * TikTok counted twice — and neither left out a post that had since been
 * archived or had expired and been soft-deleted. This counts POSTS: a content
 * item with at least one successful publish in the window, still live (not
 * archived, not deleted), inside the reader's brand scope in the query itself.
 *
 * A published post cannot be archived today (the library refuses it), so the
 * ARCHIVED exclusion changes nothing yet; it is here so the two screens stay
 * one list the day that changes. Expired posts (`deletedAt`) do drop out now.
 */
export interface PublishedPostCountInput {
  readonly workspaceId: string;
  readonly brandId?: string | undefined;
  readonly brandScope: readonly string[];
  readonly contentItemId?: string | undefined;
  /** Published at or after `start` (when given) and at or before `end`. */
  readonly period: { readonly start?: Date | undefined; readonly end: Date };
}

export function livePublishedPostWhere(input: PublishedPostCountInput) {
  return {
    workspaceId: input.workspaceId,
    deletedAt: null,
    status: { not: 'ARCHIVED' as const },
    ...brandIdQueryFilter({ brandId: input.brandId, brandScope: input.brandScope }),
    ...(input.contentItemId ? { id: input.contentItemId } : {}),
    publishJobs: {
      some: {
        status: 'PUBLISHED' as const,
        publishedAt: {
          ...(input.period.start ? { gte: input.period.start } : {}),
          lte: input.period.end,
        },
      },
    },
  };
}

export function countPublishedPosts(
  db: TenantScopedClient,
  input: PublishedPostCountInput,
): Promise<number> {
  return db.contentItem.count({ where: livePublishedPostWhere(input) });
}
