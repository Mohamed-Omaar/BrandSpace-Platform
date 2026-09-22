import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@brandspace/shared';
import type * as AuthModule from '@brandspace/auth';

/**
 * A SEND THAT FAILED IS NOT A SEND THAT WORKED — Phase 4 §4.
 *
 * THE DEFECT. `requestPasswordResetAction` wrapped everything in one `try` and,
 * in the `catch`, logged and redirected to `?ok=RESET_REQUESTED` — "if an
 * account exists for that address, a message is on its way". A provider outage
 * therefore told every customer their reset link was on its way and delivered
 * none of them. `resendVerificationAction` had the same shape: whatever
 * happened, it landed on "check your email". Both providers throw precisely so a
 * caller can tell — `ApiEmailProvider` on a refused or unreachable API,
 * `UnconfiguredEmailProvider` on every call — and both callers discarded it.
 *
 * ANTI-ENUMERATION IS WHY THE CATCH EXISTED, AND IT IS UNTOUCHED. Whether the
 * transport worked is independent of whether the address has an account: the
 * tests below drive a REGISTERED and an UNREGISTERED address through the same
 * failure and assert they are indistinguishable, and drive the success path for
 * both and assert the same. What changes is only that a broken send now says so.
 *
 * DRIVEN THROUGH THE REAL ACTION. A test of a helper would not have caught this,
 * because the defect was the control flow of the action itself — so every
 * boundary is mocked and the action is called exactly as a form submission calls
 * it. `redirect()` throws in Next.js, which is what carries the destination out.
 */

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => new Map<string, string>(),
}));

/** Whether the provider is currently able to deliver. Flipped per test. */
let deliveryWorks = true;
const sent: string[] = [];

const templates: string[] = [];

const emailProvider = {
  key: 'test',
  send: async (message: { to: string; templateKey?: string }) => {
    if (!deliveryWorks) {
      // Exactly what `ApiEmailProvider` raises when the API refuses or cannot be
      // reached, and what `UnconfiguredEmailProvider` raises always.
      throw new AppError('INTERNAL', 'Email delivery is unavailable.');
    }
    sent.push(message.to);
    if (message.templateKey) templates.push(message.templateKey);
    return { messageId: 'test' };
  },
};

/** Addresses this fake knows about. Everything else is a stranger. */
const REGISTERED = 'registered@example.test';

const customerAuth = {
  beginPasswordReset: async (email: string) =>
    email.trim().toLowerCase() === REGISTERED ? { token: 'raw-token-never-stored' } : null,
};

vi.mock('../../apps/dashboard/src/server/customer-context', () => ({
  getCustomerAuth: () => customerAuth,
  getUnscopedEmailProvider: () => emailProvider,
  customerLandingPath: async () => '/en/overview',
  inWorkspace: async () => undefined,
  currentEnvironment: () => 'DEVELOPMENT',
  requestOrigin: async () => ({ ip: '203.0.113.5', userAgent: 'Test/1' }),
}));

/*
 * `server-only` is a build-time marker with no Node implementation: importing a
 * module that carries it outside Next.js fails to resolve. Stubbed so the ACTION
 * can be loaded, which is the whole point of this file.
 */
vi.mock('server-only', () => ({}));

vi.mock('../../apps/dashboard/src/server/email-links', () => ({
  customerLink: (path: string) => `https://dashboard.example.test${path}`,
}));

vi.mock('@brandspace/database', () => ({
  getPrisma: () => ({}),
  withoutTenantContext: async (fn: (db: unknown) => unknown) => fn({}),
}));

vi.mock('@brandspace/onboarding', () => ({
  TenantOnboardingPolicySource: class {
    async load() {
      return {
        signup: {
          open: true,
          minPasswordLength: 12,
          verificationTtlMinutes: 60,
          verificationResendCooldownSeconds: 0,
          verificationsPerHour: 50,
        },
        abuse: {
          windowSeconds: 300,
          signInPerIp: 1_000,
          signInPerAccount: 1_000,
          signUpPerIp: 1_000,
          passwordResetPerIp: 1_000,
          passwordResetPerAccount: 1_000,
          verificationResendPerIp: 1_000,
          mfaPerIp: 1_000,
          mfaPerAccount: 1_000,
        },
        legalDocuments: [],
        mfa: { customerEnrolmentEnabled: true, requiredForCustomers: false, recoveryCodeCount: 10 },
        steps: [],
      };
    }
  },
}));

/** The signup service the resend action builds. Only `resendVerification` runs. */
const resendCalls: string[] = [];
vi.mock('@brandspace/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthModule>();
  return {
    ...actual,
    SignupService: class {
      async resendVerification(_policy: unknown, email: string) {
        resendCalls.push(email);
        // The real service sends through the provider; a transport failure
        // propagates out of it exactly like this.
        await emailProvider.send({ to: email });
        return { acknowledged: true };
      }
    },
    InvitationService: class {},
  };
});

async function loadActions() {
  return import('../../apps/dashboard/src/app/[locale]/(auth)/actions');
}

/**
 * Run an action and return where it redirected.
 *
 * READ OUT OF THE REAL `redirect()`, not a stub of it. Next.js signals a
 * redirect by throwing an error whose `digest` is
 * `NEXT_REDIRECT;<kind>;<url>;<status>;` — so the destination comes from the
 * framework's own control flow, and the test cannot pass because a mock of
 * `redirect` was wired up wrongly and silently recorded nothing.
 */
async function destinationOf(run: () => Promise<void>): Promise<string> {
  let destination: string | null = null;
  await run().catch((error: unknown) => {
    const digest = (error as { digest?: string }).digest;
    if (typeof digest !== 'string' || !digest.startsWith('NEXT_REDIRECT')) throw error;
    destination = digest.split(';')[2] ?? '';
  });
  if (destination === null) throw new Error('the action returned without redirecting');
  return destination;
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

beforeEach(() => {
  deliveryWorks = true;
  sent.length = 0;
  templates.length = 0;
  resendCalls.length = 0;
});

describe('a password reset that could not be sent does not claim it was', () => {
  it('SAYS THE SEND FAILED when the provider throws', async () => {
    const { requestPasswordResetAction } = await loadActions();
    deliveryWorks = false;

    const destination = await destinationOf(() =>
      requestPasswordResetAction(form({ locale: 'en', email: REGISTERED })),
    );

    // The defect: this used to be `?ok=RESET_REQUESTED`.
    expect(destination).not.toContain('ok=RESET_REQUESTED');
    expect(destination).toContain('error=EMAIL_NOT_SENT');
  });

  it('still acknowledges uniformly when the send works', async () => {
    const { requestPasswordResetAction } = await loadActions();

    const registered = await destinationOf(() =>
      requestPasswordResetAction(form({ locale: 'en', email: REGISTERED })),
    );
    const stranger = await destinationOf(() =>
      requestPasswordResetAction(form({ locale: 'en', email: 'nobody@example.test' })),
    );

    expect(registered).toContain('ok=RESET_REQUESTED');
    // AND THE TWO ARE IDENTICAL: the uniform acknowledgement is the property the
    // catch existed to protect, and it is unchanged.
    expect(stranger).toBe(registered);
    /*
     * BOTH ADDRESSES ARE MAILED, which is what makes the failure case above
     * indistinguishable too: a branch that never touches the provider cannot
     * observe a provider outage, and one that does. The registered address gets
     * a reset link, the stranger a "no account here" notice, and the caller
     * cannot tell which — the same pairing the two signup templates use.
     */
    expect(sent).toEqual([REGISTERED, 'nobody@example.test']);
    // Different templates, so the stranger is not sent a reset link.
    expect(templates).toEqual(['auth.password_reset', 'auth.password_reset.unknown']);
  });

  it('FAILS IDENTICALLY for a registered and an unregistered address', async () => {
    const { requestPasswordResetAction } = await loadActions();
    deliveryWorks = false;

    const registered = await destinationOf(() =>
      requestPasswordResetAction(form({ locale: 'en', email: REGISTERED })),
    );
    const stranger = await destinationOf(() =>
      requestPasswordResetAction(form({ locale: 'en', email: 'nobody@example.test' })),
    );

    /*
     * A STRANGER NEVER REACHES THE PROVIDER — `beginPasswordReset` returns null
     * and nothing is sent — so the two outcomes could legitimately differ here,
     * and that difference would be an account-existence oracle. They are
     * compared with the correlation id stripped, which is the only part that is
     * meant to vary.
     */
    const withoutRef = (url: string) => url.replace(/[?&]ref=[^&]*/, '');
    expect(withoutRef(stranger)).toBe(withoutRef(registered));
  });
});

describe('a verification resend that could not be sent does not claim it was', () => {
  it('SAYS THE SEND FAILED rather than landing on "check your email"', async () => {
    const { resendVerificationAction } = await loadActions();
    deliveryWorks = false;

    const destination = await destinationOf(() =>
      resendVerificationAction(form({ locale: 'en', email: REGISTERED })),
    );

    expect(destination).toContain('error=EMAIL_NOT_SENT');
    // It still lands on the same page, so the customer keeps the resend button —
    // what changes is that the page now tells them the truth about it.
    expect(destination).toContain('/en/sign-up/sent');
  });

  it('lands on the confirmation with no error when the send works', async () => {
    const { resendVerificationAction } = await loadActions();

    const destination = await destinationOf(() =>
      resendVerificationAction(form({ locale: 'en', email: REGISTERED })),
    );

    expect(destination).toContain('/en/sign-up/sent');
    expect(destination).not.toContain('error=');
    expect(resendCalls).toEqual([REGISTERED]);
  });
});
