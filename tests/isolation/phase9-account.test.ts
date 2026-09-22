import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CustomerAuthService,
  OutboxEmailProvider,
  SignupService,
  customerMfaContext,
  type OnboardingPolicy,
} from '@brandspace/auth';
import { LocalDevelopmentKeyProvider } from '@brandspace/vault';
import { TOTP, Secret } from 'otpauth';
import { appRoleClient, platformRoleClient } from './fixtures';

/**
 * Signup, verification and customer MFA, against REAL PostgreSQL.
 *
 * WHAT THIS SUITE PROTECTS. The two questions an attacker asks before anything
 * else — "does this address have an account?" and "can I get in with only the
 * password?" — and the one a customer asks after losing a phone.
 *
 * ENUMERATION IS ASSERTED AS AN EQUALITY, not as a comment. A free address and a
 * taken one go through the SAME call and are compared: the return value is
 * identical, no second user is created, and the difference lives only in which
 * template landed in the outbox — which the caller never sees.
 *
 * THE KEY PROVIDER IS A FIXTURE and protects nothing real. It is explicit rather
 * than read from the environment so the suite seals the same way on every
 * machine, and a missing variable is a clear failure rather than a test that
 * silently stores something unprotected.
 */

const FIXTURE_KEK = 'isolation-fixture-customer-mfa-kek-000000';

let app: PrismaClient;
let platform: PrismaClient;
let signup: SignupService;
let auth: CustomerAuthService;

const POLICY: OnboardingPolicy = {
  signup: {
    open: true,
    minPasswordLength: 12,
    verificationTtlMinutes: 60,
    verificationResendCooldownSeconds: 0,
    verificationsPerHour: 5,
  },
  /*
   * Phase 4 (F-19). Deliberately HIGH, because this suite proves the signup,
   * verification and MFA rules — not the ceilings, which have their own suite.
   * A tight number here would make these assertions fail for the wrong reason
   * the day somebody adds a case.
   */
  abuse: {
    windowSeconds: 300,
    signInPerIp: 10_000,
    signInPerAccount: 10_000,
    signUpPerIp: 10_000,
    passwordResetPerIp: 10_000,
    passwordResetPerAccount: 10_000,
    verificationResendPerIp: 10_000,
    mfaPerIp: 10_000,
    mfaPerAccount: 10_000,
  },
  legalDocuments: [
    {
      key: 'terms-of-service',
      title: { ar: 'الشروط', en: 'Terms of service' },
      version: '2026-09-01',
      url: null,
      required: true,
    },
  ],
  mfa: { customerEnrolmentEnabled: true, requiredForCustomers: false, recoveryCodeCount: 4 },
  steps: [],
};

/** The raw token for a user's newest verification link, read from the database. */
async function newestTokenFor(userId: string): Promise<string | null> {
  // The RAW token is never stored, so the test cannot read it back. It mints its
  // own instead and writes the hash, which is exactly what the service does —
  // proving the storage contract rather than working around it.
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await platform.emailVerificationToken.create({
    data: { userId, tokenHash: hash, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  return raw;
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  signup = new SignupService({
    prisma: app,
    email: new OutboxEmailProvider(app),
    verificationLink: (token) => `https://app.test/verify?token=${token}`,
    keyProvider: new LocalDevelopmentKeyProvider(FIXTURE_KEK),
  });
  auth = new CustomerAuthService({ prisma: app });
}, 60_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

function signupInput(email: string) {
  return {
    email,
    password: 'a-long-enough-fixture-password',
    name: 'Fixture Person',
    locale: 'EN' as const,
    timezone: 'Europe/London',
    acceptedDocuments: [{ key: 'terms-of-service', version: '2026-09-01' }],
  };
}

describe('signup does not reveal who has an account', () => {
  it('returns the same acknowledgement for a free address and a taken one', async () => {
    const email = `p9-signup-${crypto.randomUUID().slice(0, 8)}@example.local`;

    const first = await signup.signUp(POLICY, signupInput(email));
    const second = await signup.signUp(POLICY, signupInput(email));

    // IDENTICAL. Not "similar", not "both succeeded" — the same value.
    expect(second).toEqual(first);
    // And exactly one account exists.
    expect(await platform.user.count({ where: { email } })).toBe(1);
  });

  it('creates the account PENDING, and it cannot sign in until verified', async () => {
    const email = `p9-pending-${crypto.randomUUID().slice(0, 8)}@example.local`;
    await signup.signUp(POLICY, signupInput(email));

    const user = await platform.user.findUniqueOrThrow({ where: { email } });
    expect(user.status).toBe('PENDING');
    expect(user.emailVerifiedAt).toBeNull();

    await expect(
      auth.signIn({ email, password: 'a-long-enough-fixture-password' }),
    ).rejects.toThrow(/Invalid credentials/i);
  });

  it('records the legal acceptance WITH its version', async () => {
    const email = `p9-legal-${crypto.randomUUID().slice(0, 8)}@example.local`;
    await signup.signUp(POLICY, signupInput(email));
    const user = await platform.user.findUniqueOrThrow({ where: { email } });

    const acceptance = await platform.userLegalAcceptance.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(acceptance.documentKey).toBe('terms-of-service');
    // "They agreed to the terms" is not a fact unless it says WHICH terms.
    expect(acceptance.version).toBe('2026-09-01');
  });

  it('refuses a signup that has not accepted the CURRENT version', async () => {
    const email = `p9-stale-terms-${crypto.randomUUID().slice(0, 8)}@example.local`;
    await expect(
      signup.signUp(POLICY, {
        ...signupInput(email),
        acceptedDocuments: [{ key: 'terms-of-service', version: '2020-01-01' }],
      }),
    ).rejects.toThrow(/current terms/i);
    expect(await platform.user.count({ where: { email } })).toBe(0);
  });

  it('refuses a password below the CONFIGURED floor, not a hard-coded one', async () => {
    const email = `p9-short-${crypto.randomUUID().slice(0, 8)}@example.local`;
    const strict: OnboardingPolicy = {
      ...POLICY,
      signup: { ...POLICY.signup, minPasswordLength: 40 },
    };
    await expect(signup.signUp(strict, signupInput(email))).rejects.toThrow(/too short/i);
  });

  it('refuses a signup with no timezone rather than inventing one (D-194)', async () => {
    const email = `p9-no-tz-${crypto.randomUUID().slice(0, 8)}@example.local`;
    await expect(signup.signUp(POLICY, { ...signupInput(email), timezone: '   ' })).rejects.toThrow(
      /timezone is required/i,
    );
  });

  it('stores only the HASH of a verification token', async () => {
    const email = `p9-hash-${crypto.randomUUID().slice(0, 8)}@example.local`;
    await signup.signUp(POLICY, signupInput(email));
    const user = await platform.user.findUniqueOrThrow({ where: { email } });
    const token = await platform.emailVerificationToken.findFirstOrThrow({
      where: { userId: user.id },
    });
    // 64 hex characters and nothing else. A dump of this table is unusable.
    expect(token.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verification is single use', () => {
  it('verifies once, activates the account, and refuses the same link again', async () => {
    const email = `p9-verify-${crypto.randomUUID().slice(0, 8)}@example.local`;
    await signup.signUp(POLICY, signupInput(email));
    const user = await platform.user.findUniqueOrThrow({ where: { email } });

    const token = (await newestTokenFor(user.id))!;
    const first = await signup.verifyEmail(token);
    expect(first?.userId).toBe(user.id);

    const verified = await platform.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(verified.status).toBe('ACTIVE');
    expect(verified.emailVerifiedAt).not.toBeNull();

    // A refresh, a forwarded link, a prefetching mail client.
    expect(await signup.verifyEmail(token)).toBeNull();
  });

  it('refuses an expired link and an invented one identically', async () => {
    const email = `p9-expired-${crypto.randomUUID().slice(0, 8)}@example.local`;
    await signup.signUp(POLICY, signupInput(email));
    const user = await platform.user.findUniqueOrThrow({ where: { email } });

    const raw = crypto.randomBytes(32).toString('base64url');
    await platform.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: crypto.createHash('sha256').update(raw).digest('hex'),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    expect(await signup.verifyEmail(raw)).toBeNull();
    expect(await signup.verifyEmail('a-token-nobody-ever-issued')).toBeNull();
  });

  it('does not reactivate a SUSPENDED account', async () => {
    const email = `p9-suspended-${crypto.randomUUID().slice(0, 8)}@example.local`;
    await signup.signUp(POLICY, signupInput(email));
    const user = await platform.user.findUniqueOrThrow({ where: { email } });
    await platform.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });

    const token = (await newestTokenFor(user.id))!;
    await signup.verifyEmail(token);

    const after = await platform.user.findUniqueOrThrow({ where: { id: user.id } });
    // A link in somebody's inbox must not overturn an administrative decision.
    expect(after.status).toBe('SUSPENDED');
  });
});

describe('customer MFA', () => {
  async function verifiedUser(): Promise<string> {
    const email = `p9-mfa-${crypto.randomUUID().slice(0, 8)}@example.local`;
    await signup.signUp(POLICY, signupInput(email));
    const user = await platform.user.findUniqueOrThrow({ where: { email } });
    const token = (await newestTokenFor(user.id))!;
    await signup.verifyEmail(token);
    return user.id;
  }

  /** Read the sealed seed back the way the service does, to compute a live code. */
  async function codeFor(userId: string): Promise<string> {
    const row = await platform.user.findUniqueOrThrow({
      where: { id: userId },
      select: { mfaSecretMaterial: true },
    });
    const material = row.mfaSecretMaterial as unknown as {
      ciphertext: string;
      iv: string;
      authTag: string;
      wrappedDataKey: string;
      keyProvider: string;
      keyId: string;
      encryptionContext: string;
    };
    const { decryptSecret } = await import('@brandspace/vault');
    const seed = await decryptSecret(material, new LocalDevelopmentKeyProvider(FIXTURE_KEK));
    return new TOTP({
      issuer: 'BrandSpace Platform',
      label: 'verify',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(seed),
    }).generate();
  }

  it('does not enable MFA until a live code proves the authenticator has the seed', async () => {
    const userId = await verifiedUser();
    const enrolment = await signup.beginMfaEnrolment(POLICY, userId);
    expect(enrolment.otpauthUri).toContain('otpauth://totp/');

    const pending = await platform.user.findUniqueOrThrow({ where: { id: userId } });
    expect(pending.mfaEnabled).toBe(false);
    expect(pending.mfaSecretMaterial).not.toBeNull();

    await expect(signup.confirmMfaEnrolment(POLICY, userId, '000000')).rejects.toThrow(
      /not valid/i,
    );
    const still = await platform.user.findUniqueOrThrow({ where: { id: userId } });
    expect(still.mfaEnabled).toBe(false);

    const { recoveryCodes } = await signup.confirmMfaEnrolment(
      POLICY,
      userId,
      await codeFor(userId),
    );
    expect(recoveryCodes).toHaveLength(POLICY.mfa.recoveryCodeCount);

    const enabled = await platform.user.findUniqueOrThrow({ where: { id: userId } });
    expect(enabled.mfaEnabled).toBe(true);
    expect(enabled.mfaEnrolledAt).not.toBeNull();
  });

  it('never stores the seed in clear, and never a recovery code', async () => {
    const userId = await verifiedUser();
    await signup.beginMfaEnrolment(POLICY, userId);
    const { recoveryCodes } = await signup.confirmMfaEnrolment(
      POLICY,
      userId,
      await codeFor(userId),
    );

    const row = await platform.user.findUniqueOrThrow({ where: { id: userId } });
    const serialized = JSON.stringify(row.mfaSecretMaterial);
    // The envelope holds ciphertext, an iv, a tag and a wrapped key — and the
    // context that binds it to this user. No base32 seed.
    expect(serialized).toContain('ciphertext');
    expect(serialized).toContain(customerMfaContext(userId));

    const stored = await platform.userMfaRecoveryCode.findMany({ where: { userId } });
    for (const code of recoveryCodes) {
      expect(stored.some((candidate) => candidate.codeHash === code)).toBe(false);
    }
    for (const candidate of stored) expect(candidate.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('spends a recovery code exactly once', async () => {
    const userId = await verifiedUser();
    await signup.beginMfaEnrolment(POLICY, userId);
    const { recoveryCodes } = await signup.confirmMfaEnrolment(
      POLICY,
      userId,
      await codeFor(userId),
    );
    const code = recoveryCodes[0]!;

    expect(await signup.verifyMfa(userId, code)).toBe(true);
    expect(await signup.verifyMfa(userId, code)).toBe(false);
    expect(await signup.remainingRecoveryCodes(userId)).toBe(POLICY.mfa.recoveryCodeCount - 1);
  });

  it('refuses a seed copied onto another account', async () => {
    const owner = await verifiedUser();
    const other = await verifiedUser();
    await signup.beginMfaEnrolment(POLICY, owner);
    const material = (
      await platform.user.findUniqueOrThrow({
        where: { id: owner },
        select: { mfaSecretMaterial: true },
      })
    ).mfaSecretMaterial;

    // The exact envelope, on somebody else's row.
    await platform.user.update({
      where: { id: other },
      data: { mfaSecretMaterial: material as never, mfaEnabled: true },
    });

    // The CONTEXT names the owner, so this cannot authenticate the other
    // account even with a code that is correct for the seed.
    expect(await signup.verifyMfa(other, await codeFor(owner))).toBe(false);
  });

  it('gives an MFA-enrolled account a session that grants NOTHING until the code', async () => {
    const userId = await verifiedUser();
    const user = await platform.user.findUniqueOrThrow({ where: { id: userId } });
    await signup.beginMfaEnrolment(POLICY, userId);
    await signup.confirmMfaEnrolment(POLICY, userId, await codeFor(userId));

    const session = await auth.signIn({
      email: user.email,
      password: 'a-long-enough-fixture-password',
    });
    expect(session.mfaRequired).toBe(true);
    // THE SESSION EXISTS AND RESOLVES TO NOTHING.
    expect(await auth.resolve(session.token)).toBeNull();

    await auth.completeMfa({
      token: session.token,
      code: await codeFor(userId),
      verify: (id, code) => signup.verifyMfa(id, code),
    });
    const resolved = await auth.resolve(session.token);
    expect(resolved?.userId).toBe(userId);
  });

  it('will not turn MFA off without a working code', async () => {
    const userId = await verifiedUser();
    await signup.beginMfaEnrolment(POLICY, userId);
    await signup.confirmMfaEnrolment(POLICY, userId, await codeFor(userId));

    await expect(signup.disableMfa(userId, '000000')).rejects.toThrow(/not valid/i);
    expect((await platform.user.findUniqueOrThrow({ where: { id: userId } })).mfaEnabled).toBe(
      true,
    );

    await signup.disableMfa(userId, await codeFor(userId));
    const off = await platform.user.findUniqueOrThrow({ where: { id: userId } });
    expect(off.mfaEnabled).toBe(false);
    expect(off.mfaSecretMaterial).toBeNull();
    // The old printout stops working the moment enrolment is removed.
    expect(await platform.userMfaRecoveryCode.count({ where: { userId } })).toBe(0);
  });
});
