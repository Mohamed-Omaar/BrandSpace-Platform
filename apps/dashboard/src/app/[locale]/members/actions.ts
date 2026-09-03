'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { inWorkspace, membershipActor, requireWorkspace } from '../../../server/customer-context';

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
  return membersUrl(locale, { error: toPublicErrorCode(error), ref: correlationId });
}

export async function inviteMemberAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const session = await requireWorkspace(locale, 'member.invite');
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
        inviter: {
          kind: 'member',
          userId: session.customer.userId,
          permissionKeys: session.workspace.permissionKeys,
        },
      });

      await email.send({
        to: issued.email,
        templateKey: 'workspace.invitation',
        locale: locale === 'ar' ? 'AR' : 'EN',
        workspaceId: session.workspace.workspaceId,
        variables: { expiresAt: issued.expiresAt.toISOString() },
        // Composed here, never persisted.
        link: `/${locale}/invitations/${issued.token}`,
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
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const session = await requireWorkspace(locale, 'member.invite');
    await inWorkspace(session.workspace.workspaceId, async ({ invitations, email }) => {
      const issued = await invitations.resend(
        session.workspace.workspaceId,
        String(formData.get('invitationId') ?? ''),
        {
          kind: 'member',
          userId: session.customer.userId,
          permissionKeys: session.workspace.permissionKeys,
        },
      );
      await email.send({
        to: issued.email,
        templateKey: 'workspace.invitation.resent',
        locale: locale === 'ar' ? 'AR' : 'EN',
        workspaceId: session.workspace.workspaceId,
        link: `/${locale}/invitations/${issued.token}`,
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
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const session = await requireWorkspace(locale, 'member.invite');
    await inWorkspace(session.workspace.workspaceId, async ({ invitations }) =>
      invitations.revoke(
        session.workspace.workspaceId,
        String(formData.get('invitationId') ?? ''),
        'Revoked by a workspace member',
        {
          kind: 'member',
          userId: session.customer.userId,
          permissionKeys: session.workspace.permissionKeys,
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
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const session = await requireWorkspace(locale, 'member.assign_role');
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
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const session = await requireWorkspace(locale, 'member.remove');
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
