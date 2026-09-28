'use server';

import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { getPrisma, withWorkspace } from '@brandspace/database';
import { assertBrandInScope, createLogger, internalErrorFields } from '@brandspace/shared';
import { requireWorkspaceAction } from '../../../../server/customer-context';
import { actionErrorCode } from '../../../../server/denial';
import { brandProfileFrom, profilePatchFrom } from '../../../../server/brand-profile';
import { saveBrandProfile } from '../../../../server/brand-profile-save';

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

    /*
     * THE ONE SAVE (server/brand-profile-save.ts), shared with Look & voice: the
     * same brand row, the same `brand.profile.updated` audit event, the logo
     * check (owner decision D) — and NO typography: the patch carries none, so
     * the four v2 slots are left exactly as they are (owner decision E).
     */
    const saved = await withWorkspace(
      session.workspace.workspaceId,
      (db) =>
        saveBrandProfile(db, {
          workspaceId: session.workspace.workspaceId,
          actorUserId: session.customer.userId,
          brandId,
          patch: profilePatchFrom(input),
        }),
      { prisma: getPrisma() },
    );
    // A brand that is not there, and one this member may not see, produce the
    // same answer — the scope check above already made them the same.
    if (saved === 'not_found') notFound();

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
