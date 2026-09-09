'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { CUSTOMER_REALM } from '@brandspace/auth';
import {
  createLogger,
  internalErrorFields,
  systemClock,
  toPublicErrorCode,
} from '@brandspace/shared';
import {
  getCustomerAuth,
  getUnscopedEmailProvider,
  inWorkspace,
} from '../../../server/customer-context';
import { getPrisma } from '@brandspace/database';
import { InvitationService } from '@brandspace/auth';

const log = createLogger({ context: { component: 'dashboard.auth' } });

/**
 * Customer authentication actions.
 *
 * THREE PROPERTIES worth stating, because each is easy to lose:
 *
 *   1. Failures carry a CODE, never a message. The real error is logged once,
 *      redacted, against a correlation id (R-05).
 *   2. Sign-in and password-reset responses are identical whether or not the
 *      account exists. `beginPasswordReset` returns null for an unknown
 *      address and this code does NOT branch on it.
 *   3. The session cookie is the customer realm's own: a different name,
 *      SameSite and TTL from the platform cookie, and set on a path that the
 *      Control Center does not serve.
 */

function signInUrl(locale: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params).toString();
  return `/${locale}/sign-in${search ? `?${search}` : ''}`;
}

export async function signInAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const next = String(formData.get('next') ?? '');
  let destination: string;

  try {
    const session = await getCustomerAuth().signIn({
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
    });

    const store = await cookies();
    store.set(CUSTOMER_REALM.cookieName, session.token, {
      httpOnly: true,
      secure: true,
      sameSite: CUSTOMER_REALM.sameSite,
      path: '/',
      maxAge: CUSTOMER_REALM.sessionTtlSeconds,
    });

    // Only a relative in-app path is honoured, so `?next=` cannot be turned
    // into an open redirect to another origin (docs/SECURITY.md §9).
    destination = next.startsWith('/') && !next.startsWith('//') ? next : `/${locale}/workspaces`;
  } catch (error: unknown) {
    const correlationId = randomUUID();
    log.warn('customer sign-in failed', { correlationId, ...internalErrorFields(error) });
    destination = signInUrl(locale, { error: toPublicErrorCode(error), ref: correlationId });
  }
  redirect(destination);
}

export async function signOutAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const store = await cookies();
  const token = store.get(CUSTOMER_REALM.cookieName)?.value;
  if (token) {
    await getCustomerAuth()
      .signOut(token)
      .catch(() => undefined);
  }
  store.delete(CUSTOMER_REALM.cookieName);
  redirect(`/${locale}/sign-in`);
}

/**
 * Request a password reset.
 *
 * ALWAYS redirects to the same confirmation, whether or not an account exists.
 * The branch below is on "did we create a token", and both arms end at the same
 * URL — that is what stops this endpoint being an account-existence oracle.
 */
export async function requestPasswordResetAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const email = String(formData.get('email') ?? '');

  try {
    const issued = await getCustomerAuth().beginPasswordReset(email);
    if (issued) {
      // No workspace, deliberately: resolving one here would make this an
      // account-existence oracle. The outbox row therefore carries a NULL
      // workspace, which the policy permits only with no context set.
      await getUnscopedEmailProvider().send({
        to: email,
        templateKey: 'auth.password_reset',
        locale: locale === 'ar' ? 'AR' : 'EN',
        // The token is composed into the link and handed over; it is never
        // persisted, not even in the outbox row.
        link: `/${locale}/reset/${issued.token}`,
      });
    }
  } catch (error: unknown) {
    // Even a failure keeps the uniform response. It is logged, not surfaced.
    log.error('password reset request failed', {
      correlationId: randomUUID(),
      ...internalErrorFields(error),
    });
  }
  redirect(signInUrl(locale, { ok: 'RESET_REQUESTED' }));
}

export async function completePasswordResetAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const token = String(formData.get('token') ?? '');
  let destination: string;

  try {
    const password = String(formData.get('password') ?? '');
    if (password.length < 12) {
      // docs/SECURITY.md §3: length-first policy, minimum 12.
      throw Object.assign(new Error('too short'), { code: 'VALIDATION_FAILED' });
    }
    await getCustomerAuth().completePasswordReset(token, password);
    destination = signInUrl(locale, { ok: 'PASSWORD_UPDATED' });
  } catch (error: unknown) {
    const correlationId = randomUUID();
    log.warn('password reset failed', { correlationId, ...internalErrorFields(error) });
    destination = `/${locale}/reset/${encodeURIComponent(token)}?error=${toPublicErrorCode(
      error,
    )}&ref=${correlationId}`;
  }
  redirect(destination);
}

/**
 * Accept an invitation as the signed-in user.
 *
 * Acceptance requires an authenticated identity: the invitation binds to a
 * proven account, not to whoever opened the link. A mismatch between the
 * signed-in address and the invited one is refused with the SAME message as an
 * unknown token, so a forwarded link reveals nothing.
 */
export async function acceptInvitationAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const token = String(formData.get('token') ?? '');
  let destination: string;

  try {
    const store = await cookies();
    const sessionToken = store.get(CUSTOMER_REALM.cookieName)?.value;
    const customer = sessionToken ? await getCustomerAuth().resolve(sessionToken) : null;
    if (!customer) {
      redirect(signInUrl(locale, { next: `/${locale}/invitations/${token}` }));
    }

    // Acceptance MANAGES ITS OWN CONTEXT. The invitee is not a member yet, so
    // there is no workspace to bind up front; the service reads the identity
    // with no context, the invitation under the token scope, and then performs
    // every write inside the workspace the invitation names — where the
    // ordinary tenant policies apply (migration 20260903100000).
    const accepted = await new InvitationService({ prisma: getPrisma() }).accept(
      token,
      customer!.userId,
    );
    await getCustomerAuth().switchWorkspace(sessionToken!, accepted.workspaceId);
    destination = `/${locale}/overview`;
  } catch (error: unknown) {
    // A Next.js redirect throws; re-throw it rather than treating it as failure.
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('invitation acceptance failed', { correlationId, ...internalErrorFields(error) });
    destination = `/${locale}/invitations/${encodeURIComponent(token)}?error=${toPublicErrorCode(
      error,
    )}&ref=${correlationId}`;
  }
  redirect(destination);
}

/**
 * Accept an invitation as somebody who has no account yet — A-2.
 *
 * The invitee sets a password, the identity is created from the address the
 * INVITATION names, the membership is granted, and they arrive signed in — all
 * in one submission, because a new customer's first experience of the product
 * should not be a dead end telling them to sign in to an account that does not
 * exist.
 *
 * Every failure lands on the same page with the same code as an unusable
 * token. In particular, "that address already has an account" is NOT
 * distinguished: doing so would let anyone holding a forwarded link probe
 * whether the invited address is registered.
 */
export async function onboardInvitationAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const token = String(formData.get('token') ?? '');
  let destination: string;

  try {
    const password = String(formData.get('password') ?? '');
    if (password.length < 12) {
      // docs/SECURITY.md §3: length-first policy, minimum 12. Checked here so
      // the invitation is not touched at all for a password that cannot work.
      throw Object.assign(new Error('too short'), { code: 'VALIDATION_FAILED' });
    }

    const onboarded = await new InvitationService({ prisma: getPrisma() }).acceptAsNewUser(
      token,
      password,
    );

    // Straight into a session. The password was just set by this same request,
    // so signing in with it proves nothing further; issuing the session here
    // avoids a second round trip through a form the invitee has no reason to
    // see.
    const session = await getCustomerAuth().startSessionForUser(onboarded.userId);
    const store = await cookies();
    store.set(CUSTOMER_REALM.cookieName, session.token, {
      httpOnly: true,
      secure: true,
      sameSite: CUSTOMER_REALM.sameSite,
      path: '/',
      maxAge: CUSTOMER_REALM.sessionTtlSeconds,
    });
    await getCustomerAuth().switchWorkspace(session.token, onboarded.workspaceId);
    destination = `/${locale}/overview`;
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('invitation onboarding failed', { correlationId, ...internalErrorFields(error) });
    destination = `/${locale}/invitations/${encodeURIComponent(token)}?error=${toPublicErrorCode(
      error,
    )}&ref=${correlationId}`;
  }
  redirect(destination);
}

/** Select the workspace this session acts in. Membership is re-verified. */
export async function switchWorkspaceAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const workspaceId = String(formData.get('workspaceId') ?? '');
  let destination: string;

  try {
    const store = await cookies();
    const sessionToken = store.get(CUSTOMER_REALM.cookieName)?.value;
    const customer = sessionToken ? await getCustomerAuth().resolve(sessionToken) : null;
    if (!customer) redirect(signInUrl(locale));

    await getCustomerAuth().switchWorkspace(sessionToken!, workspaceId);
    // `lastActivityAt` is tenant-owned, so it is written inside the workspace
    // context rather than by the auth service, which deliberately has none.
    await inWorkspace(workspaceId, async ({ db }) => {
      await db.workspace.update({
        where: { id: workspaceId },
        data: { lastActivityAt: systemClock.now() },
      });
    });
    destination = `/${locale}/overview`;
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('workspace switch failed', { correlationId, ...internalErrorFields(error) });
    destination = `/${locale}/workspaces?error=${toPublicErrorCode(error)}&ref=${correlationId}`;
  }
  redirect(destination);
}

/** Next.js signals redirects by throwing; this recognises that control flow. */
function isRedirectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest?: unknown }).digest === 'string' &&
    (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}
