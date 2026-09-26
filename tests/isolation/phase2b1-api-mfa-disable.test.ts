import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { TOTP, URI } from 'otpauth';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BOOTSTRAP_CEILINGS,
  CustomerAuthService,
  SignupService,
  hashPassword,
} from '@brandspace/auth';
import type { OnboardingPolicy } from '@brandspace/onboarding';
import { buildServer } from '../../apps/api/src/server';
import { appRoleClient, platformRoleClient } from './fixtures';

/**
 * PHASE 2B-1 REVIEW, ITEM 11 — `POST /v1/account/mfa/disable` FOLLOWS THE
 * SAME RULES AS SETTINGS → SECURITY, through the real HTTP handler against
 * real PostgreSQL:
 *
 *   - a current code (authenticator or recovery) OR the password, checked only
 *     through the counted, rate-limited step-up — a wrong proof is refused and
 *     counted toward the lockout;
 *   - refused while a workspace the person belongs to requires two-step,
 *     BEFORE any proof is checked, so no recovery code is spent;
 *   - if that requirement cannot be read, refused — never "no workspace
 *     requires it".
 *
 * The enrolment uses the environment's MFA key, the one the API itself uses.
 */

const PASSWORD = 'a-strong-local-only-api-password-2b1';
const POLICY = {
  signup: {
    open: true,
    minPasswordLength: 8,
    verificationTtlMinutes: 60,
    verificationResendCooldownSeconds: 0,
    verificationsPerHour: 50,
  },
  abuse: BOOTSTRAP_CEILINGS,
  legalDocuments: [],
  mfa: { customerEnrolmentEnabled: true, requiredForCustomers: false, recoveryCodeCount: 10 },
  steps: [],
} as unknown as OnboardingPolicy;

let app: PrismaClient;
let platform: PrismaClient;
let server: Awaited<ReturnType<typeof buildServer>>;

const signup = () =>
  new SignupService({
    prisma: platform as never,
    email: { key: 'test', send: async () => ({ messageId: randomUUID() }) },
    verificationLink: () => 'https://example.test/verify',
  });
const auth = () => new CustomerAuthService({ prisma: app as never });

function codeFor(uri: string): string {
  const totp = URI.parse(uri);
  if (!(totp instanceof TOTP)) throw new Error('not a TOTP URI');
  return totp.generate();
}

/** A person with two-step on, signed in with both factors; optionally in a workspace that requires it. */
async function enrolledPerson(opts: { requiredWorkspace?: boolean } = {}) {
  const user = await platform.user.create({
    data: {
      email: `p2b1-apimfa-${randomUUID()}@example.test`,
      name: 'API two-step',
      locale: 'EN',
      timezone: 'UTC',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(PASSWORD),
    },
    select: { id: true, email: true },
  });
  await signup().beginMfaEnrolment(POLICY, user.id);
  const pending = await signup().pendingEnrolment(user.id);
  if (!pending) throw new Error('no enrolment in progress');
  const { recoveryCodes } = await signup().confirmMfaEnrolment(
    POLICY,
    user.id,
    codeFor(pending.otpauthUri),
  );
  if (opts.requiredWorkspace) {
    const id = randomUUID();
    await platform.workspace.create({
      data: {
        id,
        workspaceId: id,
        slug: `p2b1-apimfa-${id.slice(0, 12)}`,
        name: 'Requires two-step',
        ownerUserId: user.id,
        status: 'ACTIVE',
        country: 'US',
        defaultLocale: 'EN',
        timezone: 'UTC',
        currency: 'USD',
        requireMfa: true,
      },
    });
    const role = await platform.role.findFirstOrThrow({
      where: { key: 'workspace_owner', workspaceId: null },
      select: { id: true },
    });
    await platform.membership.create({
      data: {
        workspaceId: id,
        userId: user.id,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });
  }
  const session = await auth().signIn({
    email: user.email,
    password: PASSWORD,
    ip: '203.0.113.21',
  });
  if (session.mfaRequired) {
    await auth().completeMfa({
      token: session.token,
      code: codeFor(pending.otpauthUri),
      verify: async (userId, code) => signup().verifyMfa(userId, code),
    });
  }
  return { userId: user.id, token: session.token, uri: pending.otpauthUri, recoveryCodes };
}

async function disable(token: string, body: Record<string, string>) {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/account/mfa/disable',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: body,
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

const mfaEnabled = async (userId: string) =>
  (await platform.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaEnabled: true } }))
    .mfaEnabled;
const unusedRecoveryCodes = (userId: string) =>
  platform.userMfaRecoveryCode.count({ where: { userId, usedAt: null } });
const stepUpFailures = (userId: string) =>
  platform.auditEvent.count({ where: { actorId: userId, action: 'customer.auth.step_up_failed' } });

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  server = await buildServer();
  await server.ready();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await server?.close();
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('Review item 11 · turning two-step off through the API', () => {
  it('a current code passes the counted step-up and turns it off', async () => {
    const p = await enrolledPerson();
    const result = await disable(p.token, { code: codeFor(p.uri) });
    expect(result).toEqual({ status: 200, body: { disabled: true } });
    expect(await mfaEnabled(p.userId)).toBe(false);
  });

  it('the account password passes the counted step-up and turns it off', async () => {
    const p = await enrolledPerson();
    const result = await disable(p.token, { password: PASSWORD });
    expect(result.status).toBe(200);
    expect(await mfaEnabled(p.userId)).toBe(false);
  });

  it('a wrong code or password is refused and COUNTED toward the lockout; it stays on', async () => {
    const p = await enrolledPerson();
    const before = await stepUpFailures(p.userId);
    expect(await disable(p.token, { code: '000000' })).toMatchObject({
      status: 401,
      body: { error: { code: 'UNAUTHENTICATED', reason: 'MFA_PROOF_FAILED' } },
    });
    expect(await disable(p.token, { password: 'not-the-password' })).toMatchObject({
      status: 401,
    });
    expect(await stepUpFailures(p.userId)).toBe(before + 2);
    expect(await mfaEnabled(p.userId)).toBe(true);
    // Neither proof at all is a validation error, not a guess.
    expect((await disable(p.token, {})).status).toBe(422);
  });

  it('refused while a workspace requires it — BEFORE the proof, so no recovery code is spent', async () => {
    const p = await enrolledPerson({ requiredWorkspace: true });
    const unused = await unusedRecoveryCodes(p.userId);
    const result = await disable(p.token, { code: p.recoveryCodes[0] ?? '' });
    expect(result).toMatchObject({
      status: 409,
      body: { error: { code: 'CONFLICT', reason: 'MFA_REQUIRED_BY_WORKSPACE' } },
    });
    expect(await unusedRecoveryCodes(p.userId)).toBe(unused);
    expect(await mfaEnabled(p.userId)).toBe(true);
  });

  it('if the requirement cannot be read, it is refused — never read as "none requires it"', async () => {
    const p = await enrolledPerson();
    const unused = await unusedRecoveryCodes(p.userId);
    vi.spyOn(CustomerAuthService.prototype, 'listWorkspaces').mockRejectedValueOnce(
      new Error('the database is unreachable'),
    );
    const result = await disable(p.token, { code: p.recoveryCodes[0] ?? '' });
    expect(result.status).toBeGreaterThanOrEqual(500);
    expect(await mfaEnabled(p.userId)).toBe(true);
    expect(await unusedRecoveryCodes(p.userId)).toBe(unused);
  });
});
