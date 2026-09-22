import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_CEILINGS,
  CustomerAuthService,
  SignupService,
  hashPassword,
  type AbuseCeilings,
} from '@brandspace/auth';
import { LocalDevelopmentKeyProvider } from '@brandspace/vault';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * A SECURITY EVENT AN OPERATOR CAN ACT ON — Phase 4 §5.
 *
 * WHAT WAS TRUE BEFORE, measured against unmodified main:
 *
 *   - a failed sign-in given `userAgent: 'ProbeAgent/1.0'` recorded
 *     `userAgent: null`, because `CustomerAuthService` had no parameter for it
 *     and the column it has carried since Phase 1 was never written;
 *   - `customer.mfa.verified` — a SUCCESSFUL second factor — was recorded as
 *     `outcome: DENIED, severity: WARNING`, like every refusal beside it, so an
 *     operator filtering for denials found successes mixed in and an operator
 *     asking "did they get in" was told no.
 *
 * Both assertions below fail against that implementation.
 */

const PASSWORD = 'a-strong-local-only-test-password-8842';
const FIXTURE_KEK = 'isolation-fixture-customer-mfa-kek-000000';

/** Ceilings far above anything this suite does: it is not testing the ceiling. */
const CEILINGS: AbuseCeilings = {
  ...BOOTSTRAP_CEILINGS,
  signInPerIp: 10_000,
  signInPerAccount: 10_000,
  mfaPerIp: 10_000,
  mfaPerAccount: 10_000,
};

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
let auth: CustomerAuthService;

beforeAll(async () => {
  app = appRoleClient();
  platform = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
  });
  fixtures = await createIsolationFixtures(app);
  void fixtures;
  auth = new CustomerAuthService({ prisma: app, ceilings: CEILINGS });
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

async function customer(): Promise<{ id: string; email: string }> {
  return platform.user.create({
    data: {
      email: `p4ctx-${randomUUID()}@example.test`,
      name: 'phase four',
      locale: 'EN',
      timezone: 'UTC',
      status: 'ACTIVE',
      passwordHash: await hashPassword(PASSWORD),
    },
    select: { id: true, email: true },
  });
}

/** The policy shape the signup service wants. Ceilings well above this suite. */
const POLICY = {
  signup: {
    open: true,
    minPasswordLength: 12,
    verificationTtlMinutes: 60,
    verificationResendCooldownSeconds: 0,
    verificationsPerHour: 50,
  },
  abuse: CEILINGS,
  legalDocuments: [],
  mfa: { customerEnrolmentEnabled: true, requiredForCustomers: false, recoveryCodeCount: 10 },
  steps: [],
};

/**
 * A customer with a second factor, enrolled through the real path.
 *
 * `mfaEnabled` cannot simply be set: a CHECK constraint requires the flag and
 * the sealed seed to agree. The code is never verified here — `verify` is
 * stubbed at the call site — because what is under test is the audit record.
 */
async function enrolledCustomer(): Promise<{ id: string; email: string }> {
  const target = await customer();
  const signup = new SignupService({
    prisma: platform,
    email: { key: 'test', send: async () => ({ messageId: randomUUID() }) },
    verificationLink: () => 'https://example.test/verify',
    keyProvider: new LocalDevelopmentKeyProvider(FIXTURE_KEK),
  });
  await signup.beginMfaEnrolment(POLICY, target.id);
  await platform.user.update({
    where: { id: target.id },
    data: { mfaEnabled: true, mfaEnrolledAt: new Date() },
  });
  return target;
}

async function newestEvent(userId: string, action?: string) {
  return platform.auditEvent.findFirst({
    where: { actorId: userId, ...(action ? { action } : {}) },
    orderBy: { occurredAt: 'desc' },
    select: { action: true, outcome: true, severity: true, ip: true, userAgent: true },
  });
}

describe('an authentication event records where it came from', () => {
  it('KEEPS THE USER AGENT of a failed sign-in, not only the address', async () => {
    const target = await customer();
    await auth
      .signIn({
        email: target.email,
        password: 'wrong',
        ip: '203.0.113.7',
        userAgent: 'ProbeAgent/1.0',
      })
      .catch(() => undefined);

    const event = await newestEvent(target.id);
    expect(event?.action).toBe('customer.auth.bad_password');
    expect(event?.ip).toBe('203.0.113.7');
    // Null here was the defect: the column existed and nothing ever wrote it.
    expect(event?.userAgent).toBe('ProbeAgent/1.0');
  });

  it('keeps it on a locked account and on an inactive one too', async () => {
    const target = await customer();
    await platform.user.update({
      where: { id: target.id },
      data: { lockedUntil: new Date(Date.now() + 600_000) },
    });
    await auth
      .signIn({ email: target.email, password: PASSWORD, ip: '203.0.113.8', userAgent: 'Locked/2' })
      .catch(() => undefined);
    expect(await newestEvent(target.id, 'customer.auth.locked')).toMatchObject({
      ip: '203.0.113.8',
      userAgent: 'Locked/2',
    });

    const suspended = await customer();
    await platform.user.update({ where: { id: suspended.id }, data: { status: 'SUSPENDED' } });
    await auth
      .signIn({
        email: suspended.email,
        password: PASSWORD,
        ip: '203.0.113.9',
        userAgent: 'Suspended/3',
      })
      .catch(() => undefined);
    expect(await newestEvent(suspended.id, 'customer.auth.inactive')).toMatchObject({
      ip: '203.0.113.9',
      userAgent: 'Suspended/3',
    });
  });
});

describe('the outcome of a security event is the truth', () => {
  it('RECORDS A COMPLETED SECOND FACTOR AS A SUCCESS, not as a denial', async () => {
    const target = await enrolledCustomer();
    const session = await auth.signIn({ email: target.email, password: PASSWORD });
    await auth.completeMfa({
      token: session.token,
      code: '000000',
      ip: '203.0.113.42',
      userAgent: 'Authenticator/9',
      verify: async () => true,
    });

    const event = await newestEvent(target.id, 'customer.mfa.verified');
    // DENIED/WARNING was what this recorded for a factor that SUCCEEDED.
    expect(event?.outcome).toBe('SUCCESS');
    expect(event?.severity).toBe('NOTICE');
    expect(event?.ip).toBe('203.0.113.42');
    expect(event?.userAgent).toBe('Authenticator/9');
  });

  it('still records a REFUSED second factor as a denial', async () => {
    const target = await enrolledCustomer();
    const session = await auth.signIn({ email: target.email, password: PASSWORD });
    await auth
      .completeMfa({
        token: session.token,
        code: '000000',
        ip: '203.0.113.43',
        userAgent: 'Guesser/1',
        verify: async () => false,
      })
      .catch(() => undefined);

    // The correction must not have turned every event into a success.
    const event = await newestEvent(target.id, 'customer.mfa.failed');
    expect(event?.outcome).toBe('DENIED');
    expect(event?.userAgent).toBe('Guesser/1');
  });
});
