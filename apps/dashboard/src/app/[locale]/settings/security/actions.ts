'use server';

import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CUSTOMER_REALM, SignupService } from '@brandspace/auth';
import { getPrisma, withoutTenantContext } from '@brandspace/database';
import { TenantOnboardingPolicySource, type OnboardingPolicy } from '@brandspace/onboarding';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import {
  currentEnvironment,
  getCustomerAuth,
  getUnscopedEmailProvider,
  requireCustomer,
} from '../../../../server/customer-context';

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
 * Begin enrolment: mint a seed and show the QR.
 *
 * THE SEED TRAVELS ONCE, IN THE REDIRECT, and is not persisted anywhere this
 * page can read it back. It is in the URL because the alternative — holding it
 * in a server-side draft between two requests — is a second copy of the seed
 * with a lifetime nobody manages. The page tells the reader to finish now.
 */
export async function beginMfaEnrolmentAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const customer = await requireCustomer(locale);
    const policy = await readOnboardingPolicy();
    const enrolment = await signupService(locale).beginMfaEnrolment(policy, customer.userId);
    destination = securityUrl(locale, { otpauth: enrolment.otpauthUri });
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('mfa enrolment could not start', { correlationId, ...internalErrorFields(error) });
    destination = securityUrl(locale, { error: toPublicErrorCode(error), ref: correlationId });
  }
  redirect(destination);
}

/**
 * Confirm enrolment with a live code, and show the recovery codes once.
 *
 * THE CODES ARE RETURNED ONCE AND ARE NOT RECOVERABLE. They are carried in the
 * redirect for the same reason the seed is, and the page says plainly that this
 * is the only time they are shown — because it is: only their hashes are stored.
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
    destination = securityUrl(locale, {
      ok: 'MFA_ENABLED',
      codes: result.recoveryCodes.join(' '),
    });
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('mfa enrolment could not be confirmed', {
      correlationId,
      ...internalErrorFields(error),
    });
    destination = securityUrl(locale, { error: toPublicErrorCode(error), ref: correlationId });
  }
  redirect(destination);
}

/** Turn the second factor off. Requires a working code, not merely a session. */
export async function disableMfaAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const customer = await requireCustomer(locale);
    await signupService(locale).disableMfa(customer.userId, String(formData.get('code') ?? ''));
    destination = securityUrl(locale, { ok: 'MFA_DISABLED' });
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('mfa could not be disabled', { correlationId, ...internalErrorFields(error) });
    destination = securityUrl(locale, { error: toPublicErrorCode(error), ref: correlationId });
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
 * asked for on purpose and behind a working code exactly like disabling.
 */
export async function regenerateRecoveryCodesAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const customer = await requireCustomer(locale);
    const policy = await readOnboardingPolicy();
    const codes = await signupService(locale).regenerateRecoveryCodes(
      policy,
      customer.userId,
      String(formData.get('code') ?? ''),
    );
    destination = securityUrl(locale, {
      ok: 'RECOVERY_CODES_REPLACED',
      codes: codes.recoveryCodes.join(' '),
    });
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('recovery codes could not be regenerated', {
      correlationId,
      ...internalErrorFields(error),
    });
    destination = securityUrl(locale, { error: toPublicErrorCode(error), ref: correlationId });
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
    destination = securityUrl(locale, { error: toPublicErrorCode(error), ref: correlationId });
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
