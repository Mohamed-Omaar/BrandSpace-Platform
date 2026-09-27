'use server';

import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CUSTOMER_REALM, SignupService } from '@brandspace/auth';
import { getPrisma, withoutTenantContext } from '@brandspace/database';
import { TenantOnboardingPolicySource, type OnboardingPolicy } from '@brandspace/onboarding';
import { AppError, createLogger, internalErrorFields, isAppError } from '@brandspace/shared';
import {
  currentEnvironment,
  getCustomerAuth,
  getSessionToken,
  getUnscopedEmailProvider,
  inWorkspace,
  requestOrigin,
  requireCustomer,
  requireWorkspaceAction,
} from '../../../../server/customer-context';
import { actionErrorCode } from '../../../../server/denial';
import { setWorkspaceMfaRequirement } from '../../../../server/workspace-security';
import { RECOVERY_CODES_COOKIE } from '../../../../server/mfa-codes';

const log = createLogger({ context: { component: 'dashboard.security' } });

/**
 * The customer's own security controls — Phase 4.
 *
 * WHY THESE EXIST. `SignupService` has carried complete, tested customer MFA
 * since Phase 9: enrolment, a live-code confirmation, hashed recovery codes
 * consumed exactly once, and a disable that demands a working code. Nothing in
 * the product called any of it. The three routes that did were on the API, which
 * the dashboard never calls, so the only way a customer could turn on a second
 * factor was for somebody to craft an HTTP request by hand with their session
 * cookie. `remainingRecoveryCodes` — written for "the number the settings page
 * shows" — had no caller at all.
 *
 * SO THIS IS A SURFACE, NOT A MECHANISM. Every rule below already existed and is
 * unchanged; what is new is that a person can reach it.
 *
 * MFA IS A PROPERTY OF THE PERSON, NOT THE WORKSPACE, which is why these use
 * `requireCustomer` and never a permission: a second factor protects an account
 * that may belong to several workspaces or, briefly, to none, and no workspace
 * administrator has any business over another person's authenticator.
 */

function securityUrl(locale: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params).toString();
  return `/${locale}/settings/security${search ? `?${search}` : ''}`;
}

async function readOnboardingPolicy(): Promise<OnboardingPolicy> {
  return withoutTenantContext(
    async (db) => new TenantOnboardingPolicySource(db, currentEnvironment()).load(),
    { prisma: getPrisma() },
  );
}

function signupService(locale: string): SignupService {
  return new SignupService({
    prisma: getPrisma(),
    email: getUnscopedEmailProvider(),
    // Enrolment sends no mail; the link builder is required by the constructor
    // and is never reached from any path in this file.
    verificationLink: (token) => `/${locale}/verify?token=${encodeURIComponent(token)}`,
  });
}

/**
 * Where an enrolment action returns: the Security page, or the page a
 * workspace that REQUIRES two-step sends a member to (D-333). A closed set.
 */
function enrolmentHome(locale: string, formData: FormData): string {
  return formData.get('from') === 'setup' ? `/${locale}/mfa-setup` : securityUrl(locale);
}

/**
 * The recovery codes, shown ONCE (G4, D-333). They used to travel in the
 * redirect's query string — into the browser history and any Referer. They
 * now ride a short-lived, httpOnly, same-site cookie that only the Security
 * page reads, and "I have saved them" deletes it.
 */
async function showRecoveryCodesOnce(codes: readonly string[]): Promise<void> {
  const store = await cookies();
  store.set(RECOVERY_CODES_COOKIE, codes.join(' '), {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 300,
  });
}

/**
 * Begin enrolment: mint a seed. The page then draws the QR code and prints
 * the key from the SERVER (`pendingEnrolment`) — the seed is never put in a
 * URL (G4, D-333).
 */
export async function beginMfaEnrolmentAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const customer = await requireCustomer(locale);
    const policy = await readOnboardingPolicy();
    await signupService(locale).beginMfaEnrolment(policy, customer.userId);
    destination = enrolmentHome(locale, formData);
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('mfa enrolment could not start', { correlationId, ...internalErrorFields(error) });
    destination = `${enrolmentHome(locale, formData)}?error=${actionErrorCode(error)}&ref=${correlationId}`;
  }
  redirect(destination);
}

/**
 * Confirm enrolment with a live code, and show the recovery codes once. A
 * member sent here by a workspace that requires it lands on the Security page
 * afterwards, where the codes are shown — the requirement is now met.
 */
export async function confirmMfaEnrolmentAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const customer = await requireCustomer(locale);
    const policy = await readOnboardingPolicy();
    const result = await signupService(locale).confirmMfaEnrolment(
      policy,
      customer.userId,
      String(formData.get('code') ?? ''),
    );
    await showRecoveryCodesOnce(result.recoveryCodes);
    destination = securityUrl(locale, { ok: 'MFA_ENABLED' });
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('mfa enrolment could not be confirmed', {
      correlationId,
      ...internalErrorFields(error),
    });
    destination = `${enrolmentHome(locale, formData)}?error=${actionErrorCode(error)}&ref=${correlationId}`;
  }
  redirect(destination);
}

/**
 * A STEP-UP ON THIS SESSION (D-333): rate-limited, refused while the account is
 * locked, and a wrong proof counted toward the lockout — the same brakes a
 * sign-in has. `attempt` returns false for a wrong code or password.
 */
async function withStepUp(attempt: (userId: string) => Promise<boolean>): Promise<void> {
  const origin = await requestOrigin();
  const ok = await getCustomerAuth().stepUp({
    token: (await getSessionToken()) ?? '',
    attempt,
    ip: origin.ip,
    userAgent: origin.userAgent,
  });
  if (!ok) throw new AppError('UNAUTHENTICATED', 'That code or password is not correct.');
}

/** A code the service refused is `false` to the step-up, so it is counted. */
async function refusedIsFalse(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error: unknown) {
    if (isAppError(error) && error.code === 'UNAUTHENTICATED') return false;
    throw error;
  }
}

/** The failure code a security action reports: a stable reason, else the generic one. */
function securityErrorCode(error: unknown): string {
  const reason = isAppError(error) ? error.publicDetails['reason'] : undefined;
  if (reason === 'MFA_REQUIRED_BY_WORKSPACE' || reason === 'MFA_ENROL_FIRST') return reason;
  if (isAppError(error) && error.code === 'UNAUTHENTICATED') return 'MFA_PROOF_FAILED';
  return actionErrorCode(error);
}

/**
 * Turn the second factor off (G4, D-333) — with EITHER a current code or the
 * account password, through the counted step-up. Refused, before any proof is
 * checked (so no recovery code is spent), while a workspace this person
 * belongs to requires it.
 */
export async function disableMfaAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const customer = await requireCustomer(locale);
    const workspaces = await getCustomerAuth().listWorkspaces((await getSessionToken()) ?? '', {
      includePendingDeletion: true,
      includeMfaRequired: true,
    });
    if (workspaces.some((workspace) => workspace.requireMfa)) {
      throw new AppError('CONFLICT', 'A workspace you belong to requires two-step verification.', {
        reason: 'MFA_REQUIRED_BY_WORKSPACE',
      });
    }
    const code = String(formData.get('code') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const signup = signupService(locale);
    await withStepUp(async () =>
      signup.disableMfaWith(customer.userId, code !== '' ? { code } : { password }),
    );
    destination = securityUrl(locale, { ok: 'MFA_DISABLED' });
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('mfa could not be disabled', { correlationId, ...internalErrorFields(error) });
    destination = securityUrl(locale, { error: securityErrorCode(error), ref: correlationId });
  }
  redirect(destination);
}

/**
 * Issue a fresh set of recovery codes.
 *
 * WHY THIS IS NOT MERELY CONVENIENT. F-13 records the platform-side version of
 * the same gap: codes are shown once and, when they run out, the person has no
 * way back. `confirmMfaEnrolment` already replaces the whole set — deliberately,
 * so an old printout stops working — so regenerating is that same operation,
 * asked for on purpose and behind a working code exactly like disabling. The
 * code goes through the counted step-up (D-333).
 */
export async function regenerateRecoveryCodesAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const customer = await requireCustomer(locale);
    const policy = await readOnboardingPolicy();
    const signup = signupService(locale);
    let codes: readonly string[] = [];
    await withStepUp(async () =>
      refusedIsFalse(async () => {
        codes = (
          await signup.regenerateRecoveryCodes(
            policy,
            customer.userId,
            String(formData.get('code') ?? ''),
          )
        ).recoveryCodes;
      }),
    );
    await showRecoveryCodesOnce(codes);
    destination = securityUrl(locale, { ok: 'RECOVERY_CODES_REPLACED' });
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('recovery codes could not be regenerated', {
      correlationId,
      ...internalErrorFields(error),
    });
    destination = securityUrl(locale, { error: securityErrorCode(error), ref: correlationId });
  }
  redirect(destination);
}

/**
 * "NEW PHONE" (G4, D-333): a current code — from the old phone or a recovery
 * code — starts setting up another authenticator; the old one keeps working
 * until the new one proves itself.
 */
export async function beginNewPhoneAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const customer = await requireCustomer(locale);
    const policy = await readOnboardingPolicy();
    const signup = signupService(locale);
    await withStepUp(async () =>
      signup.beginMfaReenrolment(policy, customer.userId, String(formData.get('code') ?? '')),
    );
    destination = securityUrl(locale);
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('new phone could not start', { correlationId, ...internalErrorFields(error) });
    destination = securityUrl(locale, { error: securityErrorCode(error), ref: correlationId });
  }
  redirect(destination);
}

/** The new phone's first 6-digit code: it becomes the one, with fresh recovery codes. */
export async function confirmNewPhoneAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const customer = await requireCustomer(locale);
    const policy = await readOnboardingPolicy();
    const signup = signupService(locale);
    let codes: readonly string[] = [];
    await withStepUp(async () =>
      refusedIsFalse(async () => {
        codes = (
          await signup.confirmMfaReenrolment(
            policy,
            customer.userId,
            String(formData.get('code') ?? ''),
          )
        ).recoveryCodes;
      }),
    );
    await showRecoveryCodesOnce(codes);
    destination = securityUrl(locale, { ok: 'MFA_NEW_PHONE' });
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('new phone could not be confirmed', {
      correlationId,
      ...internalErrorFields(error),
    });
    destination = securityUrl(locale, { error: securityErrorCode(error), ref: correlationId });
  }
  redirect(destination);
}

/** Stop setting up a new phone. The current one was never touched. */
export async function cancelNewPhoneAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const customer = await requireCustomer(locale);
  await signupService(locale).cancelMfaReenrolment(customer.userId);
  redirect(securityUrl(locale));
}

/** "I have saved them": the recovery codes are not shown again. */
export async function dismissRecoveryCodesAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  await requireCustomer(locale);
  (await cookies()).delete(RECOVERY_CODES_COOKIE);
  redirect(securityUrl(locale));
}

/**
 * THE OWNER REQUIRES TWO-STEP VERIFICATION FOR EVERYONE (G4, D-333).
 * `workspace.security.manage` — the Owner only.
 */
export async function setWorkspaceMfaRequirementAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'workspace.security.manage');
    await inWorkspace(session.workspace.workspaceId, async ({ db }) =>
      setWorkspaceMfaRequirement(
        db,
        {
          workspaceId: session.workspace.workspaceId,
          actorUserId: session.customer.userId,
          actorHasMfa: session.customer.mfaEnabled === true,
        },
        formData.get('requireMfa') !== null,
      ),
    );
    destination = securityUrl(locale, { ok: 'SETTINGS_SAVED' });
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('workspace mfa requirement could not be saved', {
      correlationId,
      ...internalErrorFields(error),
    });
    const reason = securityErrorCode(error);
    destination = securityUrl(locale, {
      error: reason === 'MFA_ENROL_FIRST' ? reason : actionErrorCode(error),
      ref: correlationId,
    });
  }
  redirect(destination);
}

/**
 * Sign out everywhere else, keeping this session.
 *
 * `revokeAllForUser` has existed since Phase 2B and was reachable only from a
 * password change. Somebody who suspects a session was taken should not have to
 * change their password to end it — and the one they are using is re-issued here
 * rather than revoked, so acting on the suspicion does not sign them out too.
 */
export async function signOutOtherSessionsAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const customer = await requireCustomer(locale);
    const auth = getCustomerAuth();
    await auth.revokeAllForUser(customer.userId, 'Signed out other devices');

    // The caller's own session was revoked with the rest — deliberately, because
    // "all but this one" is a rule that needs the current session's identity
    // inside the service. A fresh one is issued here, which is the same identity
    // proven by the same cookie one statement ago.
    const session = await auth.startSessionForUser(customer.userId);
    const store = await cookies();
    store.set(CUSTOMER_REALM.cookieName, session.token, {
      httpOnly: true,
      secure: true,
      sameSite: CUSTOMER_REALM.sameSite,
      path: '/',
      maxAge: CUSTOMER_REALM.sessionTtlSeconds,
    });
    // An MFA-enrolled account owes its second factor again, which is correct:
    // the new session has presented a cookie and nothing else.
    destination = session.mfaRequired
      ? `/${locale}/mfa`
      : securityUrl(locale, { ok: 'SESSIONS_REVOKED' });
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('other sessions could not be revoked', {
      correlationId,
      ...internalErrorFields(error),
    });
    destination = securityUrl(locale, { error: actionErrorCode(error), ref: correlationId });
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
