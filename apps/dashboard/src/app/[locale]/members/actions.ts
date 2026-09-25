'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { AppError, createLogger, internalErrorFields } from '@brandspace/shared';
import {
  inWorkspace,
  membershipActor,
  requireWorkspaceAction,
} from '../../../server/customer-context';
import { actionErrorCode } from '../../../server/denial';
import { customerLink } from '../../../server/email-links';

const log = createLogger({ context: { component: 'dashboard.members' } });

/**
 * Member and invitation actions, inside a workspace.
 *
 * THE WORKSPACE IS NEVER TAKEN FROM THE FORM. `requireWorkspace()` reads it
 * from the session and re-verifies membership, so a crafted POST carrying
 * another tenant's id operates on the caller's own workspace — not the target's.
 * That is what makes cross-tenant mutation impossible here rather than merely
 * unlikely.
 *
 * Each action names the permission it needs; the service checks again.
 */

function membersUrl(locale: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params).toString();
  return `/${locale}/members${search ? `?${search}` : ''}`;
}

function failure(locale: string, error: unknown, action: string): string {
  const correlationId = randomUUID();
  log.warn('member action failed', { correlationId, action, ...internalErrorFields(error) });
  return membersUrl(locale, { error: actionErrorCode(error), ref: correlationId });
}

export async function inviteMemberAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;

  try {
    const session = await requireWorkspaceAction(locale, 'member.invite');
    // Inside the tenant context, so RLS applies to every statement the service
    // runs — the second, independent layer CLAUDE.md §2.1 requires.
    // The invitation AND its outbox row are written in ONE transaction. The
    // outbox row is workspace-scoped, so the policy requires this context to
    // accept it — and an invitation whose mail was never queued is worse than
    // no invitation at all.
    await inWorkspace(session.workspace.workspaceId, async ({ invitations, email }) => {
      const issued = await invitations.create({
        workspaceId: session.workspace.workspaceId,
        email: String(formData.get('email') ?? ''),
        roleId: String(formData.get('roleId') ?? ''),
        // P6-13 — the brands the invitee will see. Validated and bounded by the
        // inviter's own scope in the service; the form only proposes.
        brandScope: brandScopeFrom(formData),
        inviter: {
          kind: 'member',
          userId: session.customer.userId,
          // The role the inviter holds, so the service can apply the
          // role-assignment ladder. Taken from the resolved session, never
          // from the form.
          roleKey: session.workspace.roleKey,
          permissionKeys: session.workspace.permissionKeys,
          brandScope: session.workspace.brandScope,
        },
      });

      await email.send({
        to: issued.email,
        templateKey: 'workspace.invitation',
        locale: locale === 'ar' ? 'AR' : 'EN',
        workspaceId: session.workspace.workspaceId,
        variables: { expiresAt: issued.expiresAt.toISOString() },
        // Composed here, never persisted.
        link: customerLink(`/${locale}/invitations/${issued.token}`),
      });
    });

    destination = membersUrl(locale, { ok: 'MEMBER_INVITED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'invite');
  }
  revalidatePath(`/${locale}/members`);
  redirect(destination);
}

export async function resendInvitationAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;

  try {
    const session = await requireWorkspaceAction(locale, 'member.invite');
    await inWorkspace(session.workspace.workspaceId, async ({ invitations, email }) => {
      const issued = await invitations.resend(
        session.workspace.workspaceId,
        String(formData.get('invitationId') ?? ''),
        {
          kind: 'member',
          userId: session.customer.userId,
          roleKey: session.workspace.roleKey,
          permissionKeys: session.workspace.permissionKeys,
          brandScope: session.workspace.brandScope,
        },
      );
      await email.send({
        to: issued.email,
        templateKey: 'workspace.invitation.resent',
        locale: locale === 'ar' ? 'AR' : 'EN',
        workspaceId: session.workspace.workspaceId,
        link: customerLink(`/${locale}/invitations/${issued.token}`),
      });
    });
    destination = membersUrl(locale, { ok: 'INVITATION_RESENT' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'resend');
  }
  revalidatePath(`/${locale}/members`);
  redirect(destination);
}

export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;

  try {
    const session = await requireWorkspaceAction(locale, 'member.invite');
    await inWorkspace(session.workspace.workspaceId, async ({ invitations }) =>
      invitations.revoke(
        session.workspace.workspaceId,
        String(formData.get('invitationId') ?? ''),
        'Revoked by a workspace member',
        {
          kind: 'member',
          userId: session.customer.userId,
          roleKey: session.workspace.roleKey,
          permissionKeys: session.workspace.permissionKeys,
          brandScope: session.workspace.brandScope,
        },
      ),
    );
    destination = membersUrl(locale, { ok: 'INVITATION_REVOKED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'revoke_invitation');
  }
  revalidatePath(`/${locale}/members`);
  redirect(destination);
}

export async function changeRoleAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;

  try {
    const session = await requireWorkspaceAction(locale, 'member.assign_role');
    await inWorkspace(session.workspace.workspaceId, async ({ memberships }) =>
      memberships.changeRole(
        session.workspace.workspaceId,
        membershipActor(session),
        String(formData.get('membershipId') ?? ''),
        String(formData.get('roleId') ?? ''),
      ),
    );
    destination = membersUrl(locale, { ok: 'ROLE_CHANGED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'change_role');
  }
  revalidatePath(`/${locale}/members`);
  redirect(destination);
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;

  try {
    const session = await requireWorkspaceAction(locale, 'member.remove');
    await inWorkspace(session.workspace.workspaceId, async ({ memberships }) =>
      memberships.remove(
        session.workspace.workspaceId,
        membershipActor(session),
        String(formData.get('membershipId') ?? ''),
        String(formData.get('reason') ?? 'Removed by a workspace administrator'),
      ),
    );
    destination = membersUrl(locale, { ok: 'MEMBER_REMOVED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'remove_member');
  }
  revalidatePath(`/${locale}/members`);
  redirect(destination);
}

/**
 * The brand access a form proposes: "all" is the empty list (every brand), and
 * "selected" is the ticked brands. Nothing here decides anything — the service
 * validates every id against the workspace and bounds it by the actor's own
 * scope (`resolveGrantableBrandScope`).
 */
function brandScopeFrom(formData: FormData): string[] {
  if (String(formData.get('access') ?? 'all') === 'all') return [];
  const selected = formData.getAll('brandId').map((value) => String(value));
  // "Only these brands" with none ticked is NOT "all brands" — reading it as
  // the empty list would turn a narrowing into the widest grant there is.
  if (selected.length === 0) throw new AppError('VALIDATION_FAILED', 'Choose at least one brand.');
  return selected;
}

/**
 * Change which brands a member sees (P6-13). The same authority as a role
 * change — BrandScope is authorization — re-checked by the service.
 */
export async function changeBrandAccessAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;

  try {
    const session = await requireWorkspaceAction(locale, 'member.assign_role');
    const selected = brandScopeFrom(formData);
    await inWorkspace(session.workspace.workspaceId, async ({ memberships }) =>
      memberships.changeBrandAccess(
        session.workspace.workspaceId,
        { ...membershipActor(session), brandScope: session.workspace.brandScope },
        String(formData.get('membershipId') ?? ''),
        selected,
      ),
    );
    destination = membersUrl(locale, { ok: 'BRAND_ACCESS_CHANGED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'change_brand_access');
  }
  revalidatePath(`/${locale}/members`);
  redirect(destination);
}
