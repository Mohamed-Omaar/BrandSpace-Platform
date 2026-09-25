'use server';

import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { getPrisma, withWorkspace, writeAuditEvent } from '@brandspace/database';
import { assertBrandInScope, createLogger, internalErrorFields } from '@brandspace/shared';
import { requireWorkspaceAction } from '../../../../server/customer-context';
import { actionErrorCode } from '../../../../server/denial';
import { brandProfileFrom } from '../../../../server/brand-profile';

const log = createLogger({ context: { component: 'dashboard.brand-profile' } });

/**
 * Save a brand's canonical identity (D-193).
 *
 * THREE INDEPENDENT REFUSALS, none of which relies on the others:
 *
 *   1. `brand.manage`, checked by `requireWorkspace`, which answers 404 rather
 *      than 403 so a role cannot learn which screens exist but are shut to it.
 *   2. THE MEMBER'S BrandScope, checked BEFORE the brand is read at all — a
 *      brand outside it must be indistinguishable from one that does not exist,
 *      and a read that happened is a read that happened.
 *   3. THE DATABASE. Everything runs inside `withWorkspace`, so RLS applies to
 *      every statement; the canonical logo columns carry a composite
 *      workspace-scoped foreign key, so another workspace's asset has nowhere
 *      to point; and the `brand_canonical_asset_scope` trigger refuses another
 *      BRAND's asset, which no key can express.
 *
 * The third is the one that matters most, because it is the only one that is
 * still true when somebody edits this file.
 */
export async function saveBrandProfileAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const brandId = String(formData.get('brandId') ?? '');
  let destination: string;

  try {
    const session = await requireWorkspaceAction(locale, 'brand.manage');
    // BEFORE the read, not after (docs/SECURITY.md §4.2).
    assertBrandInScope(session.workspace.brandScope, brandId);

    const input = brandProfileFrom(formData);

    await withWorkspace(
      session.workspace.workspaceId,
      async (db) => {
        const before = await db.brand.findFirst({
          where: { id: brandId, deletedAt: null },
          select: {
            name: true,
            industry: true,
            description: true,
            websiteUrl: true,
            defaultLocale: true,
            supportedLocales: true,
            colorPalette: true,
            typography: true,
            primaryLogoAssetId: true,
            secondaryLogoAssetId: true,
          },
        });
        // A brand that is not there, and one this member may not see, produce
        // the same answer — the scope check above already made them the same.
        if (!before) notFound();

        await db.brand.update({
          where: { id: brandId },
          data: {
            name: input.name,
            industry: input.industry,
            description: input.description,
            websiteUrl: input.websiteUrl,
            defaultLocale: input.defaultLocale,
            supportedLocales: [...input.supportedLocales],
            colorPalette: [...input.colorPalette],
            typography: { ...input.typography },
            primaryLogoAssetId: input.primaryLogoAssetId,
            secondaryLogoAssetId: input.secondaryLogoAssetId,
          },
        });

        // EVERY STATE CHANGE IS AUDITED (CLAUDE.md §5). The before/after are
        // profile fields — a brand's own description of itself — and carry no
        // secret, no token and nothing about another tenant.
        await writeAuditEvent(db, session.workspace.workspaceId, {
          action: 'brand.profile.updated',
          actorType: 'USER',
          actorId: session.customer.userId,
          resourceType: 'brand',
          resourceId: brandId,
          brandId,
          severity: 'NOTICE',
          before,
          after: { ...input, supportedLocales: [...input.supportedLocales] },
        });
      },
      { prisma: getPrisma() },
    );

    destination = `/${locale}/settings/brand?brand=${brandId}&ok=BRAND_PROFILE_SAVED`;
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('brand profile save failed', { correlationId, ...internalErrorFields(error) });
    destination = `/${locale}/settings/brand?brand=${brandId}&error=${actionErrorCode(error)}&ref=${correlationId}`;
  }
  revalidatePath(`/${locale}/settings/brand`);
  redirect(destination);
}

/** Next.js signals `notFound()` and `redirect()` by throwing; this is that. */
function isRedirectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest?: unknown }).digest === 'string' &&
    ((error as { digest: string }).digest.startsWith('NEXT_REDIRECT') ||
      (error as { digest: string }).digest === 'NEXT_HTTP_ERROR_FALLBACK;404')
  );
}
