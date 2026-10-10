import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { BOOTSTRAP_CEILINGS, SignupService, type EmailMessageInput } from '@brandspace/auth';
import { appRoleClient, platformRoleClient } from './fixtures';

/**
 * BATCH 7 PR C (2d) — AN ACCOUNT WHOSE FIRST LINK NEVER ARRIVED.
 *
 * The account row is written before the verification email is sent. When the
 * send failed, the person was left with a PENDING account; signing up again
 * mailed "you already have an account — sign in" to someone who could not
 * sign in. Now an unverified address gets its verification link again, under
 * the same cooldown, and the password typed the second time is not applied.
 * A verified address still gets the "you already have an account" notice.
 */

let app: PrismaClient;
let platform: PrismaClient;
const PASSWORD = 'a-strong-local-only-test-password-8842';
const POLICY = {
  signup: {
    open: true,
    minPasswordLength: 12,
    verificationTtlMinutes: 60,
    verificationResendCooldownSeconds: 120,
    verificationsPerHour: 5,
  },
  abuse: { ...BOOTSTRAP_CEILINGS, signUpPerIp: 1_000, verificationResendPerIp: 1_000 },
  legalDocuments: [],
  mfa: { customerEnrolmentEnabled: true, requiredForCustomers: false, recoveryCodeCount: 10 },
  steps: [],
};

beforeAll(() => {
  app = appRoleClient();
  platform = platformRoleClient();
});
afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

function service(sent: EmailMessageInput[], fail = false): SignupService {
  return new SignupService({
    prisma: app,
    email: {
      key: 'test',
      send: async (message: EmailMessageInput) => {
        if (fail) throw new Error('provider refused');
        sent.push(message);
        return { messageId: randomUUID() };
      },
    },
    verificationLink: () => 'https://example.test/verify',
  });
}

const input = (email: string, password = PASSWORD) => ({
  email,
  password,
  name: 'batch seven',
  locale: 'EN' as const,
  timezone: 'UTC',
  acceptedDocuments: [],
  ip: `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
});

describe('2d — signing up again after the first email failed', () => {
  it('sends the verification link again, not "you already have an account"', async () => {
    const email = `b7-pending-${randomUUID()}@example.test`;
    const failed = await service([], true)
      .signUp(POLICY, input(email))
      .then(
        () => 'sent',
        () => 'failed',
      );
    expect(failed).toBe('failed');
    const before = await platform.user.findUniqueOrThrow({
      where: { email },
      select: { emailVerifiedAt: true, passwordHash: true },
    });
    expect(before.emailVerifiedAt).toBeNull();

    // The failed send minted a token: inside the cooldown nothing is sent yet.
    await platform.emailVerificationToken.updateMany({
      where: { user: { email } },
      data: { createdAt: new Date(Date.now() - 10 * 60_000) },
    });
    const sent: EmailMessageInput[] = [];
    await service(sent).signUp(POLICY, input(email, 'a-different-password-typed-later'));
    expect(sent.map((message) => message.templateKey)).toEqual(['auth.email_verification']);

    // The password typed the second time is not applied.
    const after = await platform.user.findUniqueOrThrow({
      where: { email },
      select: { passwordHash: true },
    });
    expect(after.passwordHash).toBe(before.passwordHash);
  });

  it('keeps the cooldown: a second ask inside it sends nothing', async () => {
    const email = `b7-cooldown-${randomUUID()}@example.test`;
    const first: EmailMessageInput[] = [];
    await service(first).signUp(POLICY, input(email));
    expect(first.map((message) => message.templateKey)).toEqual(['auth.email_verification']);
    const again: EmailMessageInput[] = [];
    await service(again).signUp(POLICY, input(email));
    expect(again).toEqual([]);
  });

  it('a verified address is still told it already has an account', async () => {
    const email = `b7-verified-${randomUUID()}@example.test`;
    await service([]).signUp(POLICY, input(email));
    await platform.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
    const sent: EmailMessageInput[] = [];
    await service(sent).signUp(POLICY, input(email));
    expect(sent.map((message) => message.templateKey)).toEqual(['auth.signup.exists']);
  });

  it('refuses an address a mail provider would refuse, at the form', async () => {
    for (const email of ['a..b@example.test', 'a.@example.test', 'a@example.t', 'a@-x.test']) {
      const outcome = await service([])
        .signUp(POLICY, input(email))
        .then(
          () => 'accepted',
          (error: { code?: string }) => error.code ?? 'other',
        );
      expect(outcome, email).toBe('VALIDATION_FAILED');
    }
  });
});
