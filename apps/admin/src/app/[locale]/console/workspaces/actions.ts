'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { withSpan } from '@brandspace/observability';
import {
  currentEnvironment,
  getBetaCohortService,
  getConfigService,
  getCreditService,
  getEmailProvider,
  getEntitlementService,
  getInvitationService,
  getWorkspaceService,
  requirePlatformActor,
  serviceActor,
} from '../../../../server/platform-context';

const log = createLogger({ context: { component: 'admin.workspaces' } });

/**
 * Customer and workspace server actions.
 *
 * Every action re-checks authorisation server-side, and every one of them then
 * calls a SERVICE that checks again. A server action is a public HTTP endpoint:
 * being reachable only from an authorised page is not a control.
 *
 * Failures never carry an error message across to the browser. They carry a
 * code from the closed allowlist plus an opaque correlation id, and the real
 * error is logged once, redacted, against that id (R-05).
 */

function listUrl(locale: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params).toString();
  return `/${locale}/console/workspaces${search ? `?${search}` : ''}`;
}

function detailUrl(
  locale: string,
  workspaceId: string,
  params: Record<string, string> = {},
): string {
  const search = new URLSearchParams(params).toString();
  return `/${locale}/console/workspaces/${workspaceId}${search ? `?${search}` : ''}`;
}

function failure(
  destination: (params: Record<string, string>) => string,
  error: unknown,
  context: Record<string, unknown>,
): string {
  const correlationId = randomUUID();
  log.error('workspace action failed', {
    correlationId,
    ...context,
    ...internalErrorFields(error),
  });
  return destination({ error: toPublicErrorCode(error), ref: correlationId });
}

export async function createWorkspaceAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.workspace.create');
    const result = await withSpan('workspace.create', {}, async () =>
      getWorkspaceService().create(serviceActor(actor), {
        name: String(formData.get('name') ?? ''),
        slug: String(formData.get('slug') ?? ''),
        ownerEmail: String(formData.get('ownerEmail') ?? ''),
        ownerName: String(formData.get('ownerName') ?? '') || undefined,
        type: String(formData.get('type') ?? '') || undefined,
        country: String(formData.get('country') ?? '') || undefined,
        defaultLocale: (String(formData.get('defaultLocale') ?? 'AR') as 'AR' | 'EN') || undefined,
        timezone: String(formData.get('timezone') ?? '') || undefined,
        currency: String(formData.get('currency') ?? '') || undefined,
        planKey: String(formData.get('planKey') ?? '') || undefined,
        trialDays: Number(formData.get('trialDays') ?? 0) || undefined,
      }),
    );
    destination = detailUrl(locale, result.workspaceId, { ok: 'WORKSPACE_CREATED' });
  } catch (error: unknown) {
    destination = failure((p) => listUrl(locale, { ...p, view: 'new' }), error, {
      action: 'create',
    });
  }
  revalidatePath(`/${locale}/console/workspaces`);
  redirect(destination);
}

export async function updateWorkspaceAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const workspaceId = String(formData.get('workspaceId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.workspace.update');
    await withSpan('workspace.update', {}, async () =>
      getWorkspaceService().update(serviceActor(actor), workspaceId, {
        name: String(formData.get('name') ?? ''),
        slug: String(formData.get('slug') ?? ''),
        defaultLocale: String(formData.get('defaultLocale') ?? 'AR') as 'AR' | 'EN',
        timezone: String(formData.get('timezone') ?? ''),
        country: String(formData.get('country') ?? ''),
        currency: String(formData.get('currency') ?? ''),
        lockVersion: Number(formData.get('lockVersion') ?? -1),
      }),
    );
    destination = detailUrl(locale, workspaceId, { ok: 'WORKSPACE_UPDATED' });
  } catch (error: unknown) {
    destination = failure((p) => detailUrl(locale, workspaceId, p), error, { action: 'update' });
  }
  revalidatePath(`/${locale}/console/workspaces/${workspaceId}`);
  redirect(destination);
}

export async function changeStatusAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const workspaceId = String(formData.get('workspaceId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.workspace.suspend');
    await withSpan('workspace.change_status', {}, async () =>
      getWorkspaceService().changeStatus(
        serviceActor(actor),
        workspaceId,
        String(formData.get('nextStatus') ?? ''),
        String(formData.get('reason') ?? ''),
        Number(formData.get('lockVersion') ?? -1),
      ),
    );
    destination = detailUrl(locale, workspaceId, { ok: 'STATUS_CHANGED' });
  } catch (error: unknown) {
    destination = failure((p) => detailUrl(locale, workspaceId, p), error, {
      action: 'change_status',
    });
  }
  revalidatePath(`/${locale}/console/workspaces/${workspaceId}`);
  redirect(destination);
}

export async function assignPlanAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const workspaceId = String(formData.get('workspaceId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.plan.assign');
    const planKey = String(formData.get('planKey') ?? '');
    await withSpan('workspace.assign_plan', {}, async () =>
      getEntitlementService().assignPlan(
        serviceActor(actor),
        workspaceId,
        planKey === '' ? null : planKey,
        String(formData.get('reason') ?? 'Plan assigned from the Control Center'),
      ),
    );
    destination = detailUrl(locale, workspaceId, { ok: 'PLAN_ASSIGNED' });
  } catch (error: unknown) {
    destination = failure((p) => detailUrl(locale, workspaceId, p), error, {
      action: 'assign_plan',
    });
  }
  revalidatePath(`/${locale}/console/workspaces/${workspaceId}`);
  redirect(destination);
}

export async function setOverrideAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const workspaceId = String(formData.get('workspaceId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.entitlement.override');
    const rawLimit = String(formData.get('limitValue') ?? '').trim();
    await withSpan('workspace.set_override', {}, async () =>
      getEntitlementService().setOverride(
        serviceActor(actor),
        workspaceId,
        String(formData.get('featureKey') ?? ''),
        String(formData.get('enabled') ?? 'false') === 'true',
        rawLimit === '' ? null : Number(rawLimit),
        String(formData.get('reason') ?? ''),
      ),
    );
    destination = detailUrl(locale, workspaceId, { ok: 'OVERRIDE_SET' });
  } catch (error: unknown) {
    destination = failure((p) => detailUrl(locale, workspaceId, p), error, {
      action: 'set_override',
    });
  }
  revalidatePath(`/${locale}/console/workspaces/${workspaceId}`);
  redirect(destination);
}

export async function revokeOverrideAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const workspaceId = String(formData.get('workspaceId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.entitlement.override');
    await getEntitlementService().revokeOverride(
      serviceActor(actor),
      workspaceId,
      String(formData.get('featureKey') ?? ''),
    );
    destination = detailUrl(locale, workspaceId, { ok: 'OVERRIDE_REVOKED' });
  } catch (error: unknown) {
    destination = failure((p) => detailUrl(locale, workspaceId, p), error, {
      action: 'revoke_override',
    });
  }
  revalidatePath(`/${locale}/console/workspaces/${workspaceId}`);
  redirect(destination);
}

export async function adjustCreditsAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const workspaceId = String(formData.get('workspaceId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.credit.adjust');
    await withSpan('workspace.adjust_credits', {}, async () =>
      getCreditService().adjust(
        serviceActor(actor),
        workspaceId,
        Number(formData.get('credits') ?? 0),
        String(formData.get('reason') ?? ''),
        // The form carries a per-render key, so a double submit or a browser
        // retry replays the SAME logical adjustment instead of applying two.
        String(formData.get('idempotencyKey') ?? randomUUID()),
      ),
    );
    destination = detailUrl(locale, workspaceId, { ok: 'CREDITS_ADJUSTED' });
  } catch (error: unknown) {
    destination = failure((p) => detailUrl(locale, workspaceId, p), error, {
      action: 'adjust_credits',
    });
  }
  revalidatePath(`/${locale}/console/workspaces/${workspaceId}`);
  redirect(destination);
}

export async function inviteMemberAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const workspaceId = String(formData.get('workspaceId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.workspace.invite');
    const issued = await withSpan('workspace.invite', {}, async () =>
      getInvitationService().create({
        workspaceId,
        email: String(formData.get('email') ?? ''),
        roleId: String(formData.get('roleId') ?? ''),
        inviter: {
          kind: 'platform',
          platformUserId: actor.platformUserId,
          permissionKeys: actor.permissionKeys,
          mfaVerified: actor.mfaVerified,
        },
      }),
    );

    // The link is composed here and handed to the provider. The raw token is
    // never persisted anywhere — not in the outbox, not in the audit event.
    await getEmailProvider().send({
      to: issued.email,
      templateKey: 'workspace.invitation',
      locale: locale === 'ar' ? 'AR' : 'EN',
      workspaceId,
      variables: { expiresAt: issued.expiresAt.toISOString() },
      link: `/${locale}/invitations/${issued.token}`,
    });

    destination = detailUrl(locale, workspaceId, { ok: 'INVITATION_SENT' });
  } catch (error: unknown) {
    destination = failure((p) => detailUrl(locale, workspaceId, p), error, { action: 'invite' });
  }
  revalidatePath(`/${locale}/console/workspaces/${workspaceId}`);
  redirect(destination);
}

export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const workspaceId = String(formData.get('workspaceId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.workspace.invite');
    await getInvitationService().revoke(
      workspaceId,
      String(formData.get('invitationId') ?? ''),
      'Revoked from the Control Center',
      {
        kind: 'platform',
        platformUserId: actor.platformUserId,
        permissionKeys: actor.permissionKeys,
        mfaVerified: actor.mfaVerified,
      },
    );
    destination = detailUrl(locale, workspaceId, { ok: 'INVITATION_REVOKED' });
  } catch (error: unknown) {
    destination = failure((p) => detailUrl(locale, workspaceId, p), error, {
      action: 'revoke_invitation',
    });
  }
  revalidatePath(`/${locale}/console/workspaces/${workspaceId}`);
  redirect(destination);
}

// ---------------------------------------------------------------------------
// Phase 3 — beta cohort membership
// ---------------------------------------------------------------------------

/**
 * Put a workspace in a named beta cohort.
 *
 * The cohort must exist in the active `beta-cohorts` configuration: a
 * membership of a cohort nobody defined would target nothing and look like a
 * flag that silently does not work. The service checks the permission, the MFA
 * and the reason again — this guard is convenience, not the control.
 */
export async function addCohortAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const workspaceId = String(formData.get('workspaceId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.entitlement.override');
    const cohorts = (await getConfigService().get('beta-cohorts', currentEnvironment())) as {
      cohorts?: { key: string }[];
    };
    await withSpan('admin.cohort.add', {}, async () =>
      getBetaCohortService().add(
        serviceActor(actor),
        workspaceId,
        String(formData.get('cohortKey') ?? '').trim(),
        String(formData.get('reason') ?? ''),
        (cohorts.cohorts ?? []).map((c) => c.key),
      ),
    );
    destination = detailUrl(locale, workspaceId, { ok: 'COHORT_ADDED' });
  } catch (error: unknown) {
    destination = failure((p) => detailUrl(locale, workspaceId, p), error, {
      action: 'add_cohort',
    });
  }
  revalidatePath(`/${locale}/console/workspaces/${workspaceId}`);
  redirect(destination);
}

export async function removeCohortAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const workspaceId = String(formData.get('workspaceId') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.entitlement.override');
    await withSpan('admin.cohort.remove', {}, async () =>
      getBetaCohortService().remove(
        serviceActor(actor),
        workspaceId,
        String(formData.get('cohortKey') ?? '').trim(),
      ),
    );
    destination = detailUrl(locale, workspaceId, { ok: 'COHORT_REMOVED' });
  } catch (error: unknown) {
    destination = failure((p) => detailUrl(locale, workspaceId, p), error, {
      action: 'remove_cohort',
    });
  }
  revalidatePath(`/${locale}/console/workspaces/${workspaceId}`);
  redirect(destination);
}
