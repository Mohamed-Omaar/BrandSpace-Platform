import { writeAuditEvent, type TenantScopedClient } from '@brandspace/database';
import { AppError, assertBrandInScope } from '@brandspace/shared';

/**
 * THE BRAND'S AI WRITING LANGUAGE (G3, prototype v94 Phase 2B-1, D-331 —
 * amends D-277).
 *
 * It is `Brand.defaultLocale`: the language new drafts are written in, which
 * the composer starts from and any single post can still change. There is no
 * second language field.
 *
 * WHERE IT STARTS. A new brand takes the language its creator is using the
 * interface in at that moment, unless the form chose one; after that it stays
 * until someone changes it in Settings → AI. The interface language never
 * changes it later — D-277's separation of the two still holds after creation.
 */
export function brandLocaleAtCreation(explicit: string, interfaceLocale: string): 'AR' | 'EN' {
  if (explicit === 'AR' || explicit === 'EN') return explicit;
  return interfaceLocale === 'ar' ? 'AR' : 'EN';
}

/**
 * Settings → AI. Inside the caller's `withWorkspace` transaction (RLS);
 * `brand.manage` is the caller's gate, BrandScope is checked here before the
 * brand is read. The supported languages always include the default one, as
 * the brand profile's own rule has it.
 */
export async function saveBrandAiLanguage(
  db: TenantScopedClient,
  context: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly brandScope: readonly string[];
  },
  input: { readonly brandId: string; readonly defaultLocale: string },
): Promise<void> {
  const { brandId } = input;
  assertBrandInScope(context.brandScope, brandId);
  if (input.defaultLocale !== 'AR' && input.defaultLocale !== 'EN') {
    throw new AppError('VALIDATION_FAILED', 'Unsupported language.');
  }
  const defaultLocale: 'AR' | 'EN' = input.defaultLocale;
  const before = await db.brand.findFirst({
    where: { id: brandId, deletedAt: null },
    select: { defaultLocale: true, supportedLocales: true },
  });
  if (!before) throw new AppError('NOT_FOUND', 'Brand not found.');
  if (before.defaultLocale === defaultLocale) return;
  const supportedLocales = [...new Set([...before.supportedLocales, defaultLocale])];
  await db.brand.update({ where: { id: brandId }, data: { defaultLocale, supportedLocales } });
  await writeAuditEvent(db, context.workspaceId, {
    action: 'brand.profile.updated',
    actorType: 'USER',
    actorId: context.actorUserId,
    resourceType: 'brand',
    resourceId: brandId,
    brandId,
    severity: 'NOTICE',
    before,
    after: { defaultLocale, supportedLocales },
  });
}
