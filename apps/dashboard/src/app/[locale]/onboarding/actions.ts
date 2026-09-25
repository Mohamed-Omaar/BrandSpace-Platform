'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { writeAuditEvent } from '@brandspace/database';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { type WorkspaceSession, requireWorkspaceAction } from '../../../server/customer-context';
import { actionErrorCode } from '../../../server/denial';
import { inBrandBrain, assertBrandInScope } from '../../../server/brand-brain-context';
import { createBrandFor } from '../../../server/brand-creation';
import { rememberBrand } from '../../../server/brand-cookie';
import { uploadIntoLibrary } from '../../../server/asset-upload';
import { setupBrandFrom } from '../../../server/setup-brand-form';
import {
  GOAL_ITEM_KEY,
  goalKnowledge,
  setupGoalFrom,
  type SetupView,
} from '../../../server/setup-wizard-state';

const log = createLogger({ context: { component: 'dashboard.setup-wizard' } });

/**
 * THE FIRST-RUN SETUP WIZARD'S OWN ACTIONS (Phase 6 final, D-277 §6).
 *
 * Only two, because only two things in the wizard have no home elsewhere:
 * creating the brand with the few profile fields step 2 asks for, and saving
 * the first goal. Uploading documents, reviewing what was extracted and
 * connecting an account are the Brand Brain's and Connections' own actions,
 * called with a closed-set `returnTo` — a second copy of any of them is a
 * second place for its rules to drift.
 *
 * THE WORKSPACE COMES FROM THE SESSION, the brand from the form — and the brand
 * is checked against the member's BrandScope before anything is written.
 */

function pageUrl(locale: string, step: SetupView, params: Record<string, string> = {}): string {
  const search = new URLSearchParams({ step, ...params }).toString();
  return `/${locale}/onboarding?${search}`;
}

function failure(locale: string, step: SetupView, error: unknown, action: string): string {
  const correlationId = randomUUID();
  // The correlation id is the ONLY thing joining this screen to the server log,
  // and the log is redacted. No brand name and no file name are written.
  log.warn('setup wizard action failed', { correlationId, action, ...internalErrorFields(error) });
  return pageUrl(locale, step, { error: actionErrorCode(error), ref: correlationId });
}

/**
 * STEP 2 — ADD THE BRAND.
 *
 * `createBrandFor` is the product's one creation path: idempotent on the
 * name, counted against the plan's brand quota, audited. The new brand is
 * then REMEMBERED as the member's selection, so every later step is about the
 * brand they just made rather than asking them to choose it.
 *
 * THE LOGO IS OPTIONAL AND GOES THROUGH THE ONE ASSET PIPELINE — the same
 * permission, signature check, quota and malware scan as any upload. It
 * becomes the brand's logo only once it is READY and CLEAN: an unscanned file
 * is never the face of a brand. Where scanning runs in the background, the
 * file waits in the Asset Library and the reader is told so, rather than
 * shown a logo that is not there yet.
 */
export async function createSetupBrandAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand.manage');
    const input = setupBrandFrom(formData);
    const { brandId } = await createBrandFor(session, input);
    await rememberBrand(session.workspace.workspaceId, brandId);

    /*
     * THE BRAND EXISTS NOW, WHATEVER HAPPENS TO THE LOGO. A refused file (a
     * type the plan does not allow, a signature that disagrees with its name,
     * a full storage quota) is reported against the logo alone, and the
     * reader moves on with the brand they made rather than being sent back to
     * a form that would create it again.
     */
    const logo = formData.get('logo');
    let outcome = 'BRAND_CREATED';
    if (
      logo instanceof File &&
      logo.size > 0 &&
      session.workspace.permissionKeys.includes('assets.upload')
    ) {
      try {
        if (!(await attachLogo(session, brandId, logo))) outcome = 'BRAND_CREATED_LOGO_PENDING';
      } catch (error: unknown) {
        log.warn('setup wizard logo refused', {
          action: 'attach-logo',
          ...internalErrorFields(error),
        });
        outcome = 'BRAND_CREATED_LOGO_REFUSED';
      }
    }

    destination = pageUrl(locale, 'learn', { ok: outcome });
  } catch (error: unknown) {
    destination = failure(locale, 'brand', error, 'create-brand');
  }
  revalidatePath(`/${locale}/onboarding`);
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

/** Upload the logo; true when it is already the brand's logo. */
async function attachLogo(
  session: WorkspaceSession,
  brandId: string,
  file: File,
): Promise<boolean> {
  const workspaceId = session.workspace.workspaceId;
  const { assetId } = await uploadIntoLibrary({
    workspaceId,
    actor: {
      userId: session.customer.userId,
      permissionKeys: session.workspace.permissionKeys,
      brandScope: session.workspace.brandScope,
    },
    file,
    bytes: new Uint8Array(await file.arrayBuffer()),
    brandId,
    folderId: null,
  });

  return inBrandBrain(workspaceId, async ({ db }) => {
    const usable = await db.asset.findFirst({
      where: {
        id: assetId,
        brandId,
        deletedAt: null,
        status: 'READY',
        scanStatus: 'CLEAN',
        kind: 'IMAGE',
      },
      select: { id: true },
    });
    if (!usable) return false;

    const before = await db.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: { primaryLogoAssetId: true },
    });
    // A brand that already has a logo keeps it: the wizard never replaces one.
    if (!before || before.primaryLogoAssetId !== null) return before !== null;

    await db.brand.update({ where: { id: brandId }, data: { primaryLogoAssetId: usable.id } });
    await writeAuditEvent(db, workspaceId, {
      action: 'brand.profile.updated',
      actorType: 'USER',
      actorId: session.customer.userId,
      resourceType: 'brand',
      resourceId: brandId,
      brandId,
      severity: 'NOTICE',
      before,
      after: { primaryLogoAssetId: usable.id },
    });
    return true;
  });
}

/**
 * STEP 6 — THE FIRST GOAL, IN THE BRAND'S STRATEGY MEMORY.
 *
 * NOT AN ONBOARDING-ONLY FIELD (§6: "DO NOT store this as an onboarding-only
 * duplicate truth"). The goal is a HUMAN knowledge item in the brand's
 * STRATEGY area under `goal.primary`, written through `BrandKnowledgeService`
 * — versioned, audited, visible and editable in Brand Brain, and part of the
 * grounded context the strategy and Copilot read. Choosing again edits the
 * same item (a new version), never a second goal.
 *
 * "I'M NOT SURE" WRITES NOTHING and moves on: the truth is that there is no
 * goal yet, and a stored guess would be read as one.
 */
export async function saveFirstGoalAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand_brain.edit');
    const goal = setupGoalFrom(formData.get('goal'));
    if (goal === null) throw new Error('unknown goal');

    if (goal !== 'unsure') {
      const brandId = String(formData.get('brandId') ?? '');
      // BEFORE the read (docs/SECURITY.md §4.2). Out of scope is a 404.
      assertBrandInScope(session.workspace.brandScope, brandId);

      const { title, body } = goalKnowledge(goal);
      const actor = {
        userId: session.customer.userId,
        permissionKeys: session.workspace.permissionKeys,
        brandScope: session.workspace.brandScope,
      };

      await inBrandBrain(session.workspace.workspaceId, async ({ db, knowledge, policy }) => {
        const staleness = (await policy()).staleness;
        const existing = await db.brandKnowledgeItem.findFirst({
          where: {
            brandId,
            area: 'STRATEGY',
            itemKey: GOAL_ITEM_KEY,
            status: { in: ['ACTIVE', 'STALE'] },
          },
          select: { id: true },
        });
        if (existing) {
          await knowledge.updateItem({
            itemId: existing.id,
            title,
            body,
            changeReason: 'First goal chosen in setup',
            actor,
            policy: staleness,
          });
        } else {
          await knowledge.createItem({
            brandId,
            area: 'STRATEGY',
            itemKey: GOAL_ITEM_KEY,
            title,
            body,
            actor,
            policy: staleness,
          });
        }
      });
    }
    destination = pageUrl(locale, 'done', goal === 'unsure' ? {} : { ok: 'GOAL_SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, 'goal', error, 'save-goal');
  }
  revalidatePath(`/${locale}/onboarding`);
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}
