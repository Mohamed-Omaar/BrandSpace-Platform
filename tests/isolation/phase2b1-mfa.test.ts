import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { TOTP, URI } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_CEILINGS,
  CustomerAuthService,
  SignupService,
  hashPassword,
  type OnboardingPolicy,
} from '@brandspace/auth';
import { withWorkspace } from '@brandspace/database';
import { LocalDevelopmentKeyProvider } from '@brandspace/vault';
import { setWorkspaceMfaRequirement } from '../../apps/dashboard/src/server/workspace-security';
import { appRoleClient } from './fixtures';

/**
 * PROTOTYPE v94 PHASE 2B-1, ITEM 6 — TWO-STEP VERIFICATION (G4 / Q23, D-333),
 * AGAINST REAL POSTGRESQL.
 *
 * The seed is read back only on the server, for its own person; "New phone"
 * keeps the old authenticator working until the new one proves itself; it can
 * be turned off with a code OR the password, and a wrong proof counts toward
 * the lockout; and a workspace that requires it is closed to a member without
 * it — in the API's view entirely — while nobody in it can turn theirs off.
 */

const FIXTURE_KEK = 'isolation-fixture-customer-mfa-kek-000000';
const PASSWORD = 'a-strong-local-only-test-password-2b1';

let app: PrismaClient;
let platform: PrismaClient;

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

function signup(): SignupService {
  return new SignupService({
    prisma: platform,
    email: { key: 'test', send: async () => ({ messageId: randomUUID() }) },
    verificationLink: () => 'https://example.test/verify',
    keyProvider: new LocalDevelopmentKeyProvider(FIXTURE_KEK),
  });
}

function auth(): CustomerAuthService {
  return new CustomerAuthService({ prisma: app, ceilings: BOOTSTRAP_CEILINGS });
}

function codeFor(otpauthUri: string): string {
  const totp = URI.parse(otpauthUri);
  if (!(totp instanceof TOTP)) throw new Error('not a TOTP URI');
  return totp.generate();
}

async function person(): Promise<{ id: string; email: string }> {
  const email = `p2b1-mfa-${randomUUID()}@example.test`;
  return platform.user.create({
    data: {
      email,
      name: 'Two-step',
      locale: 'EN',
      timezone: 'UTC',
      status: 'ACTIVE',
      passwordHash: await hashPassword(PASSWORD),
    },
    select: { id: true, email: true },
  });
}

/** Enrol through the real path and return what the authenticator holds. */
async function enrolled(
  userId: string,
): Promise<{ uri: string; recoveryCodes: readonly string[] }> {
  await signup().beginMfaEnrolment(POLICY, userId);
  const pending = await signup().pendingEnrolment(userId);
  if (!pending) throw new Error('no enrolment in progress');
  const { recoveryCodes } = await signup().confirmMfaEnrolment(
    POLICY,
    userId,
    codeFor(pending.otpauthUri),
  );
  return { uri: pending.otpauthUri, recoveryCodes };
}

/** A workspace this person owns, with an owner membership, optionally requiring two-step. */
async function workspaceFor(userId: string, requireMfa: boolean): Promise<string> {
  const id = randomUUID();
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      slug: `p2b1-mfa-${id.slice(0, 12)}`,
      name: `MFA ${id.slice(0, 6)}`,
      ownerUserId: userId,
      status: 'ACTIVE',
      country: 'US',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
      requireMfa,
    },
  });
  const role = await platform.role.findFirstOrThrow({
    where: { key: 'workspace_owner', workspaceId: null },
    select: { id: true },
  });
  await platform.membership.create({
    data: { workspaceId: id, userId, roleId: role.id, status: 'ACTIVE', acceptedAt: new Date() },
  });
  return id;
}

async function sessionFor(email: string, mfaUri?: string): Promise<string> {
  const session = await auth().signIn({ email, password: PASSWORD, ip: '203.0.113.9' });
  if (session.mfaRequired && mfaUri) {
    await auth().completeMfa({
      token: session.token,
      code: codeFor(mfaUri),
      verify: async (userId, code) => signup().verifyMfa(userId, code),
    });
  }
  return session.token;
}

beforeAll(() => {
  app = appRoleClient();
  platform = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
  });
});

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('G4 · the seed stays on the server', () => {
  it('an enrolment in progress is read back for its own person only, and never exists once done', async () => {
    const a = await person();
    const b = await person();
    expect(await signup().pendingEnrolment(a.id)).toBeNull();
    await signup().beginMfaEnrolment(POLICY, a.id);
    const pending = await signup().pendingEnrolment(a.id);
    expect(pending?.secret).toMatch(/^[A-Z2-7]+$/);
    expect(pending?.otpauthUri).toContain(`secret=${pending?.secret}`);
    // Somebody else has nothing in progress, and cannot be handed A's.
    expect(await signup().pendingEnrolment(b.id)).toBeNull();
    // Material copied onto another person's row does not open for them.
    const row = await platform.user.findUniqueOrThrow({
      where: { id: a.id },
      select: { mfaSecretMaterial: true },
    });
    await platform.user.update({
      where: { id: b.id },
      data: { mfaSecretMaterial: row.mfaSecretMaterial as object },
    });
    expect(await signup().pendingEnrolment(b.id)).toBeNull();
  });
});

describe('G4 · "New phone": the old phone works until the new one proves itself', () => {
  it('needs a current code, keeps the old seed meanwhile, then switches and replaces the codes', async () => {
    const me = await person();
    const { uri: oldUri, recoveryCodes: oldCodes } = await enrolled(me.id);

    expect(await signup().beginMfaReenrolment(POLICY, me.id, '000000')).toBe(false);
    expect(await signup().beginMfaReenrolment(POLICY, me.id, codeFor(oldUri))).toBe(true);
    const pending = await signup().pendingEnrolment(me.id);
    expect(pending).not.toBeNull();
    expect(pending?.otpauthUri).not.toBe(oldUri);
    // Abandoned halfway, nobody is locked out: the old phone still verifies.
    expect(await signup().verifyMfa(me.id, codeFor(oldUri))).toBe(true);

    await expect(
      signup().confirmMfaReenrolment(POLICY, me.id, codeFor(oldUri)),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const { recoveryCodes } = await signup().confirmMfaReenrolment(
      POLICY,
      me.id,
      codeFor(pending!.otpauthUri),
    );
    expect(recoveryCodes).toHaveLength(10);
    expect(await signup().pendingEnrolment(me.id)).toBeNull();
    // The new phone is the one now; the old printout stopped working.
    expect(await signup().verifyMfa(me.id, codeFor(pending!.otpauthUri))).toBe(true);
    expect(await signup().verifyMfa(me.id, oldCodes[0]!)).toBe(false);
  });

  it('cancelling a new phone leaves the current one exactly as it was', async () => {
    const me = await person();
    const { uri } = await enrolled(me.id);
    await signup().beginMfaReenrolment(POLICY, me.id, codeFor(uri));
    await signup().cancelMfaReenrolment(me.id);
    expect(await signup().pendingEnrolment(me.id)).toBeNull();
    expect(await signup().verifyMfa(me.id, codeFor(uri))).toBe(true);
  });
});

describe('G4 · turning it off takes a current code OR the password, and a wrong one counts', () => {
  it('the password works, a wrong one does not', async () => {
    const me = await person();
    await enrolled(me.id);
    expect(await signup().disableMfaWith(me.id, { password: 'not-it' })).toBe(false);
    expect(await signup().disableMfaWith(me.id, { password: PASSWORD })).toBe(true);
    const row = await platform.user.findUniqueOrThrow({
      where: { id: me.id },
      select: { mfaEnabled: true, mfaSecretMaterial: true, mfaPendingSecretMaterial: true },
    });
    expect(row).toEqual({
      mfaEnabled: false,
      mfaSecretMaterial: null,
      mfaPendingSecretMaterial: null,
    });
  });

  it('a recovery code works too', async () => {
    const me = await person();
    const { recoveryCodes } = await enrolled(me.id);
    expect(await signup().disableMfaWith(me.id, { code: recoveryCodes[0]! })).toBe(true);
  });

  it('a wrong proof through the step-up counts toward the lockout', async () => {
    const me = await person();
    const { uri } = await enrolled(me.id);
    const token = await sessionFor(me.email, uri);
    const refused = await auth().stepUp({
      token,
      attempt: async (userId) => signup().disableMfaWith(userId, { code: '000000' }),
    });
    expect(refused).toBe(false);
    const row = await platform.user.findUniqueOrThrow({
      where: { id: me.id },
      select: { failedLoginCount: true, mfaEnabled: true },
    });
    expect(row).toEqual({ failedLoginCount: 1, mfaEnabled: true });
    expect(
      await platform.auditEvent.count({
        where: { actorId: me.id, action: 'customer.auth.step_up_failed' },
      }),
    ).toBe(1);
  });
});

describe('G4 · a workspace that requires two-step', () => {
  it('is left out for a member without it unless the dashboard gate asks, and kept for one with it', async () => {
    const without = await person();
    const required = await workspaceFor(without.id, true);
    const open = await workspaceFor(without.id, false);
    const token = await sessionFor(without.email);

    const acting = await auth().listWorkspaces(token);
    expect(acting.map((w) => w.workspaceId)).toEqual([open]);
    const gate = await auth().listWorkspaces(token, { includeMfaRequired: true });
    expect(gate.map((w) => w.workspaceId).sort()).toEqual([open, required].sort());
    expect(gate.find((w) => w.workspaceId === required)?.requireMfa).toBe(true);

    const withIt = await person();
    const { uri } = await enrolled(withIt.id);
    const theirs = await workspaceFor(withIt.id, true);
    const token2 = await sessionFor(withIt.email, uri);
    expect((await auth().listWorkspaces(token2)).map((w) => w.workspaceId)).toEqual([theirs]);
  });

  it('the Owner turns it on only with their own two-step on, audited, inside their workspace only', async () => {
    const owner = await person();
    const workspaceId = await workspaceFor(owner.id, false);
    const other = await workspaceFor(owner.id, false);
    const inTenant = <T>(fn: Parameters<typeof withWorkspace<T>>[1]) =>
      withWorkspace(workspaceId, fn, { prisma: app });

    await expect(
      inTenant((db) =>
        setWorkspaceMfaRequirement(
          db,
          { workspaceId, actorUserId: owner.id, actorHasMfa: false },
          true,
        ),
      ),
    ).rejects.toMatchObject({ publicDetails: { reason: 'MFA_ENROL_FIRST' } });

    await inTenant((db) =>
      setWorkspaceMfaRequirement(
        db,
        { workspaceId, actorUserId: owner.id, actorHasMfa: true },
        true,
      ),
    );
    const rows = await platform.workspace.findMany({
      where: { id: { in: [workspaceId, other] } },
      select: { id: true, requireMfa: true },
    });
    expect(rows.find((row) => row.id === workspaceId)?.requireMfa).toBe(true);
    expect(rows.find((row) => row.id === other)?.requireMfa).toBe(false);
    const audit = await platform.auditEvent.findFirst({
      where: { workspaceId, action: 'workspace.security.mfa_requirement_changed' },
    });
    expect(audit?.before).toEqual({ twoStepRequired: false });
    expect(audit?.after).toEqual({ twoStepRequired: true });
  });

  it('only the Owner holds workspace.security.manage in the catalogue', async () => {
    const holders = await platform.rolePermission.findMany({
      where: { permission: { key: 'workspace.security.manage' }, role: { workspaceId: null } },
      select: { role: { select: { key: true } } },
    });
    expect(holders.map((holder) => holder.role.key)).toEqual(['workspace_owner']);
  });
});
