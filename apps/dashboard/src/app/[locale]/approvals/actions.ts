'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import type { ApprovalVerdict } from '@brandspace/content';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { requireWorkspace, type WorkspaceSession } from '../../../server/customer-context';
import { inContentStudio } from '../../../server/content-context';

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
  const locale = String(formData.get('locale') ?? 'ar');
  const approvalId = String(formData.get('approvalId') ?? '');
  const verdict = VERDICTS[String(formData.get('verdict') ?? '')];
  const note = String(formData.get('note') ?? '');

  let destination: string;
  try {
    if (!verdict) throw new Error('unsupported verdict');
    /*
     * `content.read` HERE, NOT `content.approve`. D-121 lets a BRAND grant
     * approval to `client_viewer`, which holds neither — so gating the endpoint
     * on the permission would make the brand setting unreachable. The authority
     * check that matters is `mayApproveForBrand` inside the service, which reads
     * the brand's own policy. This one only keeps the endpoint off the open
     * internet.
     */
    const session = await requireWorkspace(locale, 'content.read');
    await inContentStudio(session.workspace.workspaceId, async ({ approvals }) =>
      (await approvals()).decide({ approvalId, verdict, actor: actorOf(session), note }),
    );
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
  const locale = String(formData.get('locale') ?? 'ar');
  const approvalId = String(formData.get('approvalId') ?? '');

  let destination: string;
  try {
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
  const locale = String(formData.get('locale') ?? 'ar');
  const brandId = String(formData.get('brandId') ?? '');

  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'approvals.policy.manage');
    // An unchecked HTML checkbox posts nothing at all, so presence IS the value.
    const patch = {
      requireApprovalBeforeScheduling: formData.get('requireApproval') !== null,
      allowSelfApproval: formData.get('allowSelfApproval') !== null,
      clientApprovalEnabled: formData.get('clientApproval') !== null,
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
