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
import { InvitationService, SignupService } from '@brandspace/auth';
import { TenantOnboardingPolicySource, type OnboardingPolicy } from '@brandspace/onboarding';
import { withoutTenantContext } from '@brandspace/database';
import { currentEnvironment } from '../../../server/customer-context';
import { customerLink } from '../../../server/email-links';

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

/**
 * The signup and MFA service, built per action.
 *
 * THE VERIFICATION LINK IS COMPOSED HERE, from the deployment's own base URL,
 * and handed to the outbox as a link that is delivered and never stored. The
 * service never learns a URL shape, and the outbox never holds a usable token.
 */
function signupService(locale: string): SignupService {
  const prisma = getPrisma();
  return new SignupService({
    prisma,
    // Production delegates to the API, which holds the key that unwraps the
    // provider credential; development keeps the deterministic outbox. See
    // apps/dashboard/src/server/customer-context.ts.
    email: getUnscopedEmailProvider(),
    verificationLink: (token) =>
      customerLink(`/${locale}/verify?token=${encodeURIComponent(token)}`),
  });
}

/**
 * The activated `onboarding` rules, read through the customer-visible
 * projection with NO workspace context — because signing up precedes every
 * workspace, and `configuration_version` is platform-owned besides.
 */
async function readOnboardingPolicy(): Promise<OnboardingPolicy> {
  return withoutTenantContext(
    async (db) => new TenantOnboardingPolicySource(db, currentEnvironment()).load(),
    { prisma: getPrisma() },
  );
}

function signInUrl(locale: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params).toString();
  return `/${locale}/sign-in${search ? `?${search}` : ''}`;
}

async function defaultCustomerDestination(locale: string, token: string): Promise<string> {
  const workspaces = await getCustomerAuth()
    .listWorkspaces(token)
    .catch(() => []);
  return workspaces.length === 0 ? `/${locale}/onboarding/workspace` : `/${locale}/workspaces`;
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

    /*
     * AN MFA-ENROLLED ACCOUNT IS NOT SIGNED IN YET (Phase 9 §11). The cookie is
     * set because the second step needs the session it completes, and that
     * session resolves to NOTHING until a code is presented — so landing
     * anywhere but the challenge would simply bounce back to sign-in.
     */
    if (session.mfaRequired) {
      destination = `/${locale}/mfa`;
    } else {
      // Only a relative in-app path is honoured, so `?next=` cannot be turned
      // into an open redirect to another origin (docs/SECURITY.md §9).
      destination =
        next.startsWith('/') && !next.startsWith('//')
          ? next
          : await defaultCustomerDestination(locale, session.token);
    }
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
        link: customerLink(`/${locale}/reset/${issued.token}`),
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

/**
 * Self-service signup — Phase 9 §10.
 *
 * ONE DESTINATION FOR EVERY OUTCOME that depends on whether the address exists.
 * A free address gets a verification link; a taken one gets a "you already have
 * an account" notice; both land here, on the "check your email" page. The only
 * failures that redirect back to the form are properties of the REQUEST — a
 * short password, an unaccepted document, a malformed address — which reveal
 * nothing about who has an account.
 */
export async function signUpAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const email = String(formData.get('email') ?? '');
  let destination: string;

  try {
    const policy = await readOnboardingPolicy();
    const accepted = policy.legalDocuments
      .filter((document) => document.required)
      .filter((document) => formData.get(`accept:${document.key}`) === 'on')
      .map((document) => ({ key: document.key, version: document.version }));

    await signupService(locale).signUp(policy, {
      email,
      password: String(formData.get('password') ?? ''),
      name: String(formData.get('name') ?? ''),
      locale: locale === 'ar' ? 'AR' : 'EN',
      // D-194: no fallback. The form supplies it, and an empty value is refused
      // by the service rather than replaced.
      timezone: String(formData.get('timezone') ?? ''),
      acceptedDocuments: accepted,
    });
    destination = `/${locale}/sign-up/sent?email=${encodeURIComponent(email)}`;
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('signup failed', { correlationId, ...internalErrorFields(error) });
    destination = `/${locale}/sign-up?error=${toPublicErrorCode(error)}&ref=${correlationId}`;
  }
  redirect(destination);
}

/** Ask for another verification link. Rate-limited and silent about the result. */
export async function resendVerificationAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const email = String(formData.get('email') ?? '');
  try {
    const policy = await readOnboardingPolicy();
    await signupService(locale).resendVerification(policy, email);
  } catch (error: unknown) {
    log.warn('verification resend failed', {
      correlationId: randomUUID(),
      ...internalErrorFields(error),
    });
  }
  redirect(`/${locale}/sign-up/sent?email=${encodeURIComponent(email)}`);
}

/**
 * Present a second factor for a session that owes one.
 *
 * The session already exists and still grants nothing until this succeeds, so a
 * failure simply returns to the same page — there is nothing to revoke.
 */
export async function verifyMfaAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const store = await cookies();
  const token = store.get(CUSTOMER_REALM.cookieName)?.value;
  if (!token) redirect(signInUrl(locale));

  let destination: string;
  try {
    const service = signupService(locale);
    await getCustomerAuth().completeMfa({
      token: token!,
      code: String(formData.get('code') ?? ''),
      verify: (userId, code) => service.verifyMfa(userId, code),
    });
    destination = await defaultCustomerDestination(locale, token!);
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('customer mfa failed', { correlationId, ...internalErrorFields(error) });
    destination = `/${locale}/mfa?error=${toPublicErrorCode(error)}&ref=${correlationId}`;
  }
  redirect(destination);
}
