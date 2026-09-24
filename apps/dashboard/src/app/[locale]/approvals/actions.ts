'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import type { ApprovalVerdict } from '@brandspace/content';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { requireWorkspace, type WorkspaceSession } from '../../../server/customer-context';
import { inContentStudio } from '../../../server/content-context';
import { inNotes } from '../../../server/notes-context';
import { noteForChangesRequested } from '../../../server/approval-notes';

const log = createLogger({ context: { component: 'dashboard.approvals' } });

/**
 * Approvals actions — Phase 5B-3.
 *
 * EVERY ONE OF THESE IS A PUBLIC HTTP ENDPOINT. The screen hides controls the
 * reader may not use, and that is a courtesy; the permission check here and the
 * second one inside `ContentApprovalService` are the control. Neither trusts a
 * field from the form: the workspace, the role key and the permission keys all
 * come from the verified session.
 *
 * THE VERDICT IS THE ONLY THING THE FORM DECIDES, and it is parsed against a
 * closed set before it reaches the service.
 */

function approvalsUrl(locale: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params).toString();
  return `/${locale}/approvals${search ? `?${search}` : ''}`;
}

function failure(locale: string, error: unknown, action: string): string {
  const correlationId = randomUUID();
  // No note text and no caption either side of this line: a review note is
  // routinely candid, and the address bar, the browser history and the access
  // log are all places it must not appear (docs/SECURITY.md §11).
  log.warn('approvals action failed', { correlationId, action, ...internalErrorFields(error) });
  return approvalsUrl(locale, { error: toPublicErrorCode(error), ref: correlationId });
}

function actorOf(session: WorkspaceSession) {
  return {
    userId: session.customer.userId,
    roleKey: session.workspace.roleKey,
    permissionKeys: session.workspace.permissionKeys,
    brandScope: session.workspace.brandScope,
  };
}

const VERDICTS: Record<string, ApprovalVerdict> = {
  APPROVE: 'APPROVE',
  REQUEST_CHANGES: 'REQUEST_CHANGES',
  REJECT: 'REJECT',
};

/** Approve, request changes, or reject. */
export async function decideApprovalAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const approvalId = String(formData.get('approvalId') ?? '');
  const verdict = VERDICTS[String(formData.get('verdict') ?? '')];
  const note = String(formData.get('note') ?? '');

  let destination: string;
  try {
    if (!verdict) throw new Error('unsupported verdict');
    /*
     * `content.read` AT THE DOOR, and the real check inside the service.
     *
     * This briefly required only membership, so that D-121's per-brand grant
     * could admit a Viewer holding `workspace.read` and nothing else. D-62
     * supersedes D-121: the MVP Viewer is strictly read-only, so the door is
     * closed to them again and the endpoint is not reachable at all.
     *
     * THE PERMISSION HERE IS NOT THE AUTHORITY, and must not be mistaken for
     * it. `content.read` only establishes that this session belongs in the
     * content surfaces; the authority to decide is `content.approve`, checked
     * by `mayApproveForBrand` inside `ContentApprovalService.decide()`, which
     * also re-checks the brand scope, the assignment and the cycle's snapshot.
     * A member with `content.read` alone reaches this action and is refused.
     */
    const session = await requireWorkspace(locale, 'content.read');
    const approval = await inContentStudio(session.workspace.workspaceId, async ({ approvals }) =>
      (await approvals()).decide({ approvalId, verdict, actor: actorOf(session), note }),
    );

    /*
     * "NEEDS WORK" LEAVES A CONVERSATION BEHIND (P6-06).
     *
     * The approval is and remains the source of truth: this runs AFTER the
     * decision has committed, changes nothing about it, and the verdict stands
     * whatever happens here.
     *
     * WHY A NOTE AT ALL. `REQUEST_CHANGES` puts the item back in the author's
     * hands with a `decisionNote` attached to a CLOSED approval cycle. The
     * author opens the draft, and the reason they were asked to change it is on
     * a different screen, in a record that is finished. Every team answers that
     * the same way — by repeating the reviewer's note somewhere they can reply
     * to it — and doing it by hand is how the reason and the work drift apart.
     * A thread on the content item puts the request where the work is, and the
     * author can answer it.
     *
     * ONLY FOR `REQUEST_CHANGES`. An approval needs no conversation, and a
     * rejection ends the cycle rather than asking for something — inventing a
     * thread for either would be the product talking to itself.
     *
     * THE AUTHOR IS MENTIONED, so it reaches their Command Center rather than
     * waiting to be found. `startThread` only names members of this workspace
     * and drops anything else, so a requester who has since left produces a
     * note with no mention rather than a failure.
     *
     * A FAILURE HERE NEVER UNDOES THE VERDICT. The decision is committed and
     * audited; a note that could not be written is a missing convenience, not a
     * reason to tell a reviewer their decision failed and have them make it
     * twice. It is logged and swallowed deliberately.
     */
    try {
      await inNotes(locale, async ({ service, actor }) =>
        noteForChangesRequested({
          service,
          actor,
          verdict,
          contentItemId: approval.contentItemId,
          requestedByUserId: approval.requestedByUserId,
          decisionNote: note,
        }),
      );
    } catch (noteFailure: unknown) {
      log.warn('changes-requested note could not be written', {
        approvalId,
        ...internalErrorFields(noteFailure),
      });
    }

    destination = approvalsUrl(locale, { ok: 'SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'decideApproval');
  }
  revalidatePath(`/${locale}/approvals`);
  revalidatePath(`/${locale}/content`);
  revalidatePath(`/${locale}/overview`);
  redirect(destination);
}

/** Withdraw a request from the queue screen. */
export async function withdrawApprovalAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const approvalId = String(formData.get('approvalId') ?? '');

  let destination: string;
  try {
    // `content.read` at the door as above; the service then requires the caller
    // to be the requester or somebody who holds `content.approve`.
    const session = await requireWorkspace(locale, 'content.read');
    await inContentStudio(session.workspace.workspaceId, async ({ approvals }) =>
      (await approvals()).cancel({ approvalId, actor: actorOf(session) }),
    );
    destination = approvalsUrl(locale, { ok: 'SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'withdrawApproval');
  }
  revalidatePath(`/${locale}/approvals`);
  revalidatePath(`/${locale}/content`);
  redirect(destination);
}

/**
 * Change one brand's approval policy.
 *
 * GATED ON `approvals.policy.manage`, WHICH ONLY THE OWNER AND ADMIN HOLD — and
 * deliberately not the Marketing Manager, who can approve. This switch can
 * enable self-approval, so a role that can approve must not also be able to
 * grant itself the right to approve its own work.
 */
export async function saveApprovalPolicyAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const brandId = String(formData.get('brandId') ?? '');

  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'approvals.policy.manage');
    /*
     * An unchecked HTML checkbox posts nothing at all, so presence IS the value.
     *
     * `clientApproval` IS NOT READ, and a forged field carrying it cannot do
     * anything: `setPolicyForBrand`'s patch type excludes it (D-62), so this
     * would not compile if it were reintroduced here by accident.
     */
    const patch = {
      requireApprovalBeforeScheduling: formData.get('requireApproval') !== null,
      allowSelfApproval: formData.get('allowSelfApproval') !== null,
    };
    await inContentStudio(session.workspace.workspaceId, async ({ approvals }) =>
      (await approvals()).setPolicyForBrand({
        brandId,
        actorUserId: session.customer.userId,
        actorBrandScope: session.workspace.brandScope,
        patch,
      }),
    );
    destination = approvalsUrl(locale, { ok: 'SAVED', brand: brandId });
  } catch (error: unknown) {
    destination = failure(locale, error, 'saveApprovalPolicy');
  }
  revalidatePath(`/${locale}/approvals`);
  revalidatePath(`/${locale}/calendar`);
  redirect(destination);
}
