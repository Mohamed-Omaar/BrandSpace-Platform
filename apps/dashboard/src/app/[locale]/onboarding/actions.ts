'use server';

import { revalidatePath } from 'next/cache';
import { redirect, unstable_rethrow } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { writeAuditEvent } from '@brandspace/database';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { type WorkspaceSession, requireWorkspaceAction } from '../../../server/customer-context';
import { actionErrorCode } from '../../../server/denial';
import { inBrandBrain, assertBrandInScope } from '../../../server/brand-brain-context';
import { createBrandFor } from '../../../server/brand-creation';
import { rememberBrand } from '../../../server/brand-cookie';
import { uploadIntoLibrary } from '../../../server/asset-upload';
import { uploadReasonOf } from '../../../server/upload-rules';
import { setupBrandFrom } from '../../../server/setup-brand-form';
import { saveSetupGoal } from '../../../server/setup-goal';
import {
  applyCandidateReview,
  reviewCandidateInputFrom,
  setupReviewInProgress,
} from '../../../server/candidate-review';
import { setupGoalFrom, type SetupView } from '../../../server/setup-wizard-state';

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
 * brand step shows the file being checked and makes it the logo when it
 * passes (batch 7, A3 — `settleLogo` below).
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
     * a full storage quota, a failed scan) is reported against the logo alone,
     * in its own place on the brand step, and the brand is not created twice.
     */
    const logo = formData.get('logo');
    destination = pageUrl(locale, 'learn', { ok: 'BRAND_CREATED' });
    if (
      logo instanceof File &&
      logo.size > 0 &&
      session.workspace.permissionKeys.includes('assets.upload')
    ) {
      const outcome = await uploadLogo(session, brandId, logo);
      destination = logoDestination(locale, outcome, {
        attached: 'BRAND_CREATED',
        checking: 'BRAND_CREATED_LOGO_PENDING',
        refused: 'BRAND_CREATED_LOGO_REFUSED',
      });
    }
  } catch (error: unknown) {
    destination = failure(locale, 'brand', error, 'create-brand');
  }
  revalidatePath(`/${locale}/onboarding`);
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

/*
 * BATCH 7 (A3) — THE LOGO IS NEVER SILENT. Reported: a small PNG chosen as the
 * logo did nothing at all — no preview, no success, no error, the tile still
 * the initial. Two causes. The control showed nothing for a chosen file until
 * Continue. And where scanning runs in the background (staging's worker), the
 * file was uploaded but checked AFTER the request had looked for it, so it was
 * never made the logo, and the reader was sent to Brand Profile to do it by
 * hand. Now the request waits a few seconds for the scan; a file that passes
 * is the logo at once, one that fails says why on the brand step, and one
 * still being checked is shown there being checked until it passes and is
 * attached — by the step itself, never by a trip to another page.
 */
const LOGO_WAIT_MS = 6_000;
const LOGO_POLL_MS = 400;

type LogoOutcome =
  | { readonly state: 'attached' }
  | { readonly state: 'checking'; readonly assetId: string }
  | { readonly state: 'refused'; readonly reason: string };

function logoDestination(
  locale: string,
  outcome: LogoOutcome,
  notes: { readonly attached: string; readonly checking: string; readonly refused: string },
): string {
  if (outcome.state === 'attached') {
    return notes.attached === 'BRAND_CREATED'
      ? pageUrl(locale, 'learn', { ok: notes.attached })
      : pageUrl(locale, 'brand', { ok: notes.attached });
  }
  if (outcome.state === 'checking') {
    return pageUrl(locale, 'brand', { ok: notes.checking, logo: outcome.assetId });
  }
  return pageUrl(locale, 'brand', { ok: notes.refused, logoReason: outcome.reason });
}

/** Upload the logo into the library, then settle it. */
async function uploadLogo(
  session: WorkspaceSession,
  brandId: string,
  file: File,
): Promise<LogoOutcome> {
  let assetId: string;
  try {
    ({ assetId } = await uploadIntoLibrary({
      workspaceId: session.workspace.workspaceId,
      actor: {
        userId: session.customer.userId,
        permissionKeys: session.workspace.permissionKeys,
        brandScope: session.workspace.brandScope,
      },
      file,
      bytes: new Uint8Array(await file.arrayBuffer()),
      brandId,
      folderId: null,
    }));
  } catch (error: unknown) {
    unstable_rethrow(error);
    log.warn('setup wizard logo refused', { action: 'attach-logo', ...internalErrorFields(error) });
    return { state: 'refused', reason: uploadReasonOf(error) ?? 'upload_failed' };
  }
  return settleLogo(session, brandId, assetId, LOGO_WAIT_MS);
}

/**
 * Wait up to `waitMs` for the file's scan, then: attach it when it is READY
 * and CLEAN (and the brand has no logo yet — the wizard never replaces one),
 * report the reason when it failed, or say it is still being checked.
 */
async function settleLogo(
  session: WorkspaceSession,
  brandId: string,
  assetId: string,
  waitMs: number,
): Promise<LogoOutcome> {
  const workspaceId = session.workspace.workspaceId;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const asset = await inBrandBrain(workspaceId, ({ db }) =>
      db.asset.findFirst({
        where: { id: assetId, brandId, deletedAt: null },
        select: { status: true, scanStatus: true, kind: true, failureReason: true },
      }),
    );
    if (!asset) return { state: 'refused', reason: 'object_missing' };
    if (asset.status === 'READY' && asset.scanStatus === 'CLEAN') {
      if (asset.kind !== 'IMAGE') return { state: 'refused', reason: 'unsupported_type' };
      await attachLogo(session, brandId, assetId);
      return { state: 'attached' };
    }
    if (
      asset.status === 'PROCESSING_FAILED' ||
      asset.status === 'QUARANTINED' ||
      asset.scanStatus === 'INFECTED'
    ) {
      return {
        state: 'refused',
        reason:
          asset.failureReason ?? (asset.scanStatus === 'INFECTED' ? 'infected' : 'scan_failed'),
      };
    }
    if (Date.now() >= deadline) return { state: 'checking', assetId };
    await new Promise((resolve) => setTimeout(resolve, LOGO_POLL_MS));
  }
}

/** Make a READY, CLEAN image the brand's logo, unless the brand already has one. */
async function attachLogo(
  session: WorkspaceSession,
  brandId: string,
  assetId: string,
): Promise<void> {
  const workspaceId = session.workspace.workspaceId;
  await inBrandBrain(workspaceId, async ({ db }) => {
    const before = await db.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: { primaryLogoAssetId: true },
    });
    // A brand that already has a logo keeps it: the wizard never replaces one.
    if (!before || before.primaryLogoAssetId !== null) return;

    await db.brand.update({ where: { id: brandId }, data: { primaryLogoAssetId: assetId } });
    await writeAuditEvent(db, workspaceId, {
      action: 'brand.profile.updated',
      actorType: 'USER',
      actorId: session.customer.userId,
      resourceType: 'brand',
      resourceId: brandId,
      brandId,
      severity: 'NOTICE',
      before,
      after: { primaryLogoAssetId: assetId },
    });
  });
}

/** The brand step's own logo upload, once the brand exists (no trip to Brand Profile). */
export async function uploadSetupLogoAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand.manage');
    const brandId = String(formData.get('brandId') ?? '');
    assertBrandInScope(session.workspace.brandScope, brandId);
    const logo = formData.get('logo');
    if (!(logo instanceof File) || logo.size === 0) throw new Error('no file');
    const outcome = session.workspace.permissionKeys.includes('assets.upload')
      ? await uploadLogo(session, brandId, logo)
      : ({ state: 'refused', reason: 'upload_failed' } as const);
    destination = logoDestination(locale, outcome, {
      attached: 'BRAND_LOGO_SAVED',
      checking: 'SETUP_LOGO_CHECKING',
      refused: 'SETUP_LOGO_REFUSED',
    });
  } catch (error: unknown) {
    destination = failure(locale, 'brand', error, 'upload-logo');
  }
  revalidatePath(`/${locale}/onboarding`);
  redirect(destination);
}

/** A logo that was still being checked has passed: make it the brand's logo now. */
export async function attachSetupLogoAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand.manage');
    const brandId = String(formData.get('brandId') ?? '');
    const assetId = String(formData.get('assetId') ?? '');
    assertBrandInScope(session.workspace.brandScope, brandId);
    const outcome = await settleLogo(session, brandId, assetId, 0);
    destination = logoDestination(locale, outcome, {
      attached: 'BRAND_LOGO_SAVED',
      checking: 'SETUP_LOGO_CHECKING',
      refused: 'SETUP_LOGO_REFUSED',
    });
  } catch (error: unknown) {
    destination = failure(locale, 'brand', error, 'attach-logo');
  }
  revalidatePath(`/${locale}/onboarding`);
  redirect(destination);
}

/**
 * STEP 6 — THE FIRST GOAL, IN THE BRAND'S STRATEGY MEMORY.
 *
 * NOT AN ONBOARDING-ONLY FIELD (§6: "DO NOT store this as an onboarding-only
 * duplicate truth"). The goal is a knowledge item in the brand's STRATEGY
 * area under `goal.primary`, origin SETUP (D-335), written through
 * `BrandKnowledgeService` — versioned, audited, visible and editable in Brand
 * Brain, and part of the grounded context the strategy and Copilot read.
 * Choosing again edits the same item (a new version), never a second goal. The
 * brand also carries the goal's KEY, so it is shown in the reader's language
 * (`server/setup-goal.ts`).
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

      const actor = {
        userId: session.customer.userId,
        permissionKeys: session.workspace.permissionKeys,
        brandScope: session.workspace.brandScope,
      };

      await inBrandBrain(session.workspace.workspaceId, async ({ db, knowledge, policy }) =>
        saveSetupGoal(db, knowledge, {
          workspaceId: session.workspace.workspaceId,
          brandId,
          goal,
          actor,
          staleness: (await policy()).staleness,
        }),
      );
    }
    destination = pageUrl(locale, 'done', goal === 'unsure' ? {} : { ok: 'GOAL_SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, 'goal', error, 'save-goal');
  }
  revalidatePath(`/${locale}/onboarding`);
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

/**
 * STEP 4 — REVIEW WHAT BRANDSPACE LEARNED (review item 15, D-335).
 *
 * The wizard's OWN review action, so the origin of what it accepts is decided
 * HERE, on the server, and never read from the request: SETUP only while this
 * brand's setup is still in progress (it has no first goal yet), DOCUMENT
 * otherwise — exactly what Brand Brain's review records. The decision, the
 * candidate and the permission (`brand_brain.review`) are checked as Brand
 * Brain checks them, through the same shared decoder and service call.
 */
export async function reviewSetupCandidateAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand_brain.review');
    const parsed = reviewCandidateInputFrom(formData);
    const actor = {
      userId: session.customer.userId,
      permissionKeys: session.workspace.permissionKeys,
      brandScope: session.workspace.brandScope,
    };
    await inBrandBrain(session.workspace.workspaceId, async ({ db, knowledge, policy }) =>
      applyCandidateReview(
        knowledge,
        parsed,
        actor,
        (await policy()).staleness,
        await setupReviewInProgress(db, parsed.candidateId, actor.brandScope),
      ),
    );
    destination = pageUrl(locale, 'review', {
      ok: parsed.decision === 'reject' ? 'CANDIDATE_REJECTED' : 'CANDIDATE_ACCEPTED',
    });
  } catch (error: unknown) {
    unstable_rethrow(error);
    destination = failure(locale, 'review', error, 'review-candidate');
  }
  revalidatePath(`/${locale}/onboarding`);
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

/**
 * ROUND 4 (4.3) — "ACCEPT ALL", THE PROTOTYPE'S BUTTON OVER THE FACTS.
 *
 * Not a new acceptance model: it is the per-fact "Accept" above, applied to
 * each fact on screen in turn — the same permission (`brand_brain.review`),
 * the same `applyCandidateReview`, the same setup rule and the same audit,
 * one review per fact. Each is its own transaction, so a fact somebody else
 * already decided stops the run with that fact's own refusal and leaves the
 * ones before it accepted, exactly as pressing them one by one would.
 */
export async function acceptAllSetupCandidatesAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand_brain.review');
    const ids = [...new Set(formData.getAll('candidateId').map(String))].slice(0, 100);
    const actor = {
      userId: session.customer.userId,
      permissionKeys: session.workspace.permissionKeys,
      brandScope: session.workspace.brandScope,
    };
    for (const candidateId of ids) {
      const one = new FormData();
      one.set('candidateId', candidateId);
      one.set('decision', 'accept');
      const parsed = reviewCandidateInputFrom(one);
      await inBrandBrain(session.workspace.workspaceId, async ({ db, knowledge, policy }) =>
        applyCandidateReview(
          knowledge,
          parsed,
          actor,
          (await policy()).staleness,
          await setupReviewInProgress(db, parsed.candidateId, actor.brandScope),
        ),
      );
    }
    destination = pageUrl(locale, 'review', { ok: 'CANDIDATE_ACCEPTED' });
  } catch (error: unknown) {
    unstable_rethrow(error);
    destination = failure(locale, 'review', error, 'review-candidate');
  }
  revalidatePath(`/${locale}/onboarding`);
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}
