import { writeAuditEvent, type TenantScopedClient } from '@brandspace/database';
import { AppError, assertBrandInScope } from '@brandspace/shared';

/**
 * A BRAND'S PUBLISHING DEFAULTS (prototype v90 A8 / A10 / B2, Phase 2B-2).
 *
 * Settings → Publishing defaults, `brand.manage` (the caller's gate). Each
 * default PROPOSES and nothing more:
 *
 *   - default channels — the channels a new post starts with in the composer,
 *     when no template names its own;
 *   - default time — the local time the calendar and the Studio propose for a
 *     new post (tomorrow at this time, F2); never a past time;
 *   - hashtags in the first comment — on channels that take a first comment, a
 *     new post's hashtags are written into its first comment instead of kept
 *     with the caption (`hashtagsIntoFirstComment` in `@brandspace/content`).
 *
 * Link tracking is not here: it is deferred with its security review (Q15).
 * AI suggestions on/off lives in Settings → AI (owner answer D7).
 *
 * Inside the caller's `withWorkspace` transaction (RLS). BrandScope is checked
 * here before the brand is read; a channel the activated policy does not offer
 * is refused, never silently dropped.
 */
export const LOCAL_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export interface PublishingDefaultsInput {
  readonly brandId: string;
  readonly platformKeys: readonly string[];
  /** `HH:mm`, or '' for "no default". */
  readonly defaultPostTime: string;
  readonly hashtagsInFirstComment: boolean;
}

export async function savePublishingDefaults(
  db: TenantScopedClient,
  context: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly brandScope: readonly string[];
    /** The activated policy's channel keys. */
    readonly knownPlatformKeys: readonly string[];
  },
  input: PublishingDefaultsInput,
): Promise<void> {
  assertBrandInScope(context.brandScope, input.brandId);
  const platformKeys = [...new Set(input.platformKeys)];
  if (platformKeys.some((key) => !context.knownPlatformKeys.includes(key))) {
    throw new AppError('VALIDATION_FAILED', 'That publishing channel is not available.', {
      field: 'defaultPlatformKeys',
    });
  }
  const time = input.defaultPostTime.trim();
  if (time !== '' && !LOCAL_TIME.test(time)) {
    throw new AppError('VALIDATION_FAILED', 'Enter a time as HH:mm.', { field: 'defaultPostTime' });
  }

  const before = await db.brand.findFirst({
    where: { id: input.brandId, workspaceId: context.workspaceId, deletedAt: null },
    select: { defaultPlatformKeys: true, defaultPostTime: true, hashtagsInFirstComment: true },
  });
  if (!before) throw new AppError('NOT_FOUND', 'Brand not found.');

  const after = {
    defaultPlatformKeys: platformKeys,
    defaultPostTime: time === '' ? null : time,
    hashtagsInFirstComment: input.hashtagsInFirstComment,
  };
  const unchanged =
    before.defaultPostTime === after.defaultPostTime &&
    before.hashtagsInFirstComment === after.hashtagsInFirstComment &&
    [...before.defaultPlatformKeys].sort().join(',') === [...platformKeys].sort().join(',');
  if (unchanged) return;

  await db.brand.update({ where: { id: input.brandId }, data: after });
  await writeAuditEvent(db, context.workspaceId, {
    action: 'brand.publishing_defaults.updated',
    actorType: 'USER',
    actorId: context.actorUserId,
    resourceType: 'brand',
    resourceId: input.brandId,
    brandId: input.brandId,
    before,
    after,
  });
}

/**
 * SETTINGS → AI: whether Home shows the "Recommended by BrandSpace" card for
 * this brand (owner answer D7). Only that card: not the recurring-workflow
 * suggestions (D-296) and not the Studio's rewrite tools.
 */
export async function saveBrandAiSuggestions(
  db: TenantScopedClient,
  context: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly brandScope: readonly string[];
  },
  input: { readonly brandId: string; readonly enabled: boolean },
): Promise<void> {
  assertBrandInScope(context.brandScope, input.brandId);
  const before = await db.brand.findFirst({
    where: { id: input.brandId, workspaceId: context.workspaceId, deletedAt: null },
    select: { aiSuggestionsEnabled: true },
  });
  if (!before) throw new AppError('NOT_FOUND', 'Brand not found.');
  if (before.aiSuggestionsEnabled === input.enabled) return;
  await db.brand.update({
    where: { id: input.brandId },
    data: { aiSuggestionsEnabled: input.enabled },
  });
  await writeAuditEvent(db, context.workspaceId, {
    action: 'brand.ai_suggestions.changed',
    actorType: 'USER',
    actorId: context.actorUserId,
    resourceType: 'brand',
    resourceId: input.brandId,
    brandId: input.brandId,
    before,
    after: { aiSuggestionsEnabled: input.enabled },
  });
}
