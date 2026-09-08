import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Secret, TOTP } from 'otpauth';
import {
  MAX_FAILED_ATTEMPTS,
  PlatformAuthService,
  generateRecoveryCodes,
  generateTotpEnrolment,
  hashPassword,
} from '@brandspace/auth';
import { SecretService } from '@brandspace/secrets';
import { PLATFORM_PERMISSIONS } from '@brandspace/shared';
import { ensurePlatformRole, platformRoleClient } from './fixtures';
import { deleteTestSecrets, testSecretProvider } from '../support/secret-fixtures';
import type { PrismaClient } from '@prisma/client';

/**
 * One token for this suite RUN, embedded in every secret ref it creates, so
 * `afterAll` can delete exactly these rows and nothing else — including nothing
 * belonging to a suite running in parallel (F-53).
 *
 * It goes in the ref's NAME segment, not the provider one: `platform-auth`
 * asserts that an MFA ref starts `mfa-totp/platform/`, which is a real property
 * of the product and not something a cleanup scheme may bend.
 */
const TEST_SECRET_PROVIDER = testSecretProvider();

/**
 * Regression suite for the independent security review — findings 1 and 3.
 *
 * FINDING 1: `verifyMfa()` never read `lockedUntil`. Failed MFA attempts set the
 * lock, but nothing consulted it, so a session created before the lock could go
 * on submitting codes — and a CORRECT code would still sign the attacker in. The
 * counter was also a read-modify-write (`currentCount + 1`), so parallel
 * requests overwrote each other and the threshold was never reached.
 *
 * FINDING 3: a recovery code was matched with `findMany` and then consumed with
 * an `update` by id. Two concurrent requests could both read the same unused
 * code and both succeed.
 *
 * Both are concurrency bugs, so both are asserted against a REAL PostgreSQL with
 * genuinely parallel requests. A mocked database would prove nothing here.
 */

const PASSWORD = 'correct horse battery staple';
const ENV = 'DEVELOPMENT' as const;

let prisma: PrismaClient;
let auth: PlatformAuthService;
let secrets: SecretService;
let ownerRoleId: string;
let provisionerId: string;

function totpCode(secret: string): string {
  return new TOTP({
    issuer: 'BrandSpace Platform',
    label: 'lockout',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate();
}

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly totpSecret: string;
}

async function createUser(): Promise<TestUser> {
  const email = `lockout-${randomUUID()}@brandspace.local`;
  const enrolment = generateTotpEnrolment(email);
  const ref = `mfa-totp/platform/development/${TEST_SECRET_PROVIDER}-${email}`;

  await secrets.createSecret(
    {
      platformUserId: provisionerId,
      roleKey: 'platform_owner',
      mfaVerified: true,
      permissionKeys: PLATFORM_PERMISSIONS.map((p) => p.key),
    },
    {
      ref,
      name: `TOTP seed for ${email}`,
      category: 'mfa_totp',
      environment: ENV,
      value: enrolment.secret,
    },
  );

  const created = await prisma.platformUser.create({
    data: {
      email,
      name: 'Lockout Test User',
      status: 'ACTIVE',
      roleId: ownerRoleId,
      passwordHash: await hashPassword(PASSWORD),
      mfaEnabled: true,
      mfaSecretRef: ref,
      mfaEnrolledAt: new Date(),
    },
  });

  return { id: created.id, email, totpSecret: enrolment.secret };
}

/** A pre-MFA session token: password accepted, second factor still outstanding. */
async function preMfaToken(user: TestUser): Promise<string> {
  const { session } = await auth.authenticateWithPassword({
    email: user.email,
    password: PASSWORD,
  });
  return session.token;
}

beforeAll(async () => {
  prisma = platformRoleClient();
  secrets = new SecretService({ prisma, env: { SECRET_VAULT_KEK: 'l'.repeat(48) } });
  ownerRoleId = await ensurePlatformRole(prisma);

  const provisioner = await prisma.platformUser.create({
    data: {
      email: `lockout-provisioner-${randomUUID()}@brandspace.local`,
      name: 'Lockout Test Provisioner',
      status: 'ACTIVE',
      roleId: ownerRoleId,
    },
  });
  provisionerId = provisioner.id;

  auth = new PlatformAuthService({
    prisma,
    resolveMfaSecret: (ref) => secrets.resolveSecret(ref, ENV),
  });
});

afterAll(async () => {
  // This run's secrets go before the connection does.
  if (prisma) await deleteTestSecrets(prisma, TEST_SECRET_PROVIDER);
  await prisma?.$disconnect();
});

// ---------------------------------------------------------------------------
// Finding 1 — the lock must actually stop MFA
// ---------------------------------------------------------------------------

describe('MFA lockout cannot be bypassed by a pre-existing session', () => {
  it('sets lockedUntil after the configured number of wrong MFA codes', async () => {
    const user = await createUser();

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      const token = await preMfaToken(user);
      await expect(auth.verifyMfa({ token, code: '000000' })).rejects.toThrow();
    }

    const row = await prisma.platformUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.lockedUntil).not.toBeNull();
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it('REFUSES the CORRECT code on a session created before the lock', async () => {
    // The decisive assertion. The attacker already holds a pre-MFA session and
    // has just exhausted the allowance; the lock is worthless if the very next
    // request — with a valid code — still signs them in.
    const user = await createUser();
    const survivingToken = await preMfaToken(user);

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      const token = await preMfaToken(user);
      await expect(auth.verifyMfa({ token, code: '000000' })).rejects.toThrow();
    }

    await expect(
      auth.verifyMfa({ token: survivingToken, code: totpCode(user.totpSecret) }),
    ).rejects.toThrow();

    // And no session was promoted.
    const verified = await prisma.platformSession.count({
      where: { platformUserId: user.id, mfaVerifiedAt: { not: null } },
    });
    expect(verified).toBe(0);
  });

  it('refuses the same session on the next WRONG code, and revokes pre-MFA sessions', async () => {
    const user = await createUser();
    const token = await preMfaToken(user);

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await expect(auth.verifyMfa({ token, code: '000000' })).rejects.toThrow();
    }

    await expect(auth.verifyMfa({ token, code: '111111' })).rejects.toThrow();

    // Pre-MFA sessions are worthless once the account locks: they are revoked,
    // not merely refused by a check someone could later forget to write.
    const live = await prisma.platformSession.count({
      where: { platformUserId: user.id, mfaVerifiedAt: null, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it('refuses OTHER pre-MFA sessions created before the lock', async () => {
    const user = await createUser();
    const first = await preMfaToken(user);
    const second = await preMfaToken(user);
    const third = await preMfaToken(user);

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      await expect(auth.verifyMfa({ token: first, code: '000000' })).rejects.toThrow();
    }

    const code = totpCode(user.totpSecret);
    await expect(auth.verifyMfa({ token: second, code })).rejects.toThrow();
    await expect(auth.verifyMfa({ token: third, code })).rejects.toThrow();
  });

  it('keeps the public error uniform whether the code is wrong or the account is locked', async () => {
    // A wrong code on a healthy account.
    const healthy = await createUser();
    const wrongCodeMessage = await auth
      .verifyMfa({ token: await preMfaToken(healthy), code: '000000' })
      .then(() => null)
      .catch((e: Error) => e.message);

    // A CORRECT code on a locked account, using a session created before the
    // lock — the one path an attacker actually has.
    const locked = await createUser();
    const survivor = await preMfaToken(locked);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      const token = await preMfaToken(locked);
      await auth.verifyMfa({ token, code: '000000' }).catch(() => undefined);
    }
    const lockedMessage = await auth
      .verifyMfa({ token: survivor, code: totpCode(locked.totpSecret) })
      .then(() => null)
      .catch((e: Error) => e.message);

    expect(wrongCodeMessage).toBe('Invalid verification code.');
    expect(lockedMessage).toBe(wrongCodeMessage);
  });

  it('audits the lockout without recording the submitted code', async () => {
    const user = await createUser();
    const guessed = '424242';

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      const token = await preMfaToken(user);
      await auth.verifyMfa({ token, code: guessed }).catch(() => undefined);
    }

    const events = await prisma.auditEvent.findMany({ where: { actorId: user.id } });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.action === 'platform.account.locked')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(guessed);
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    expect(JSON.stringify(events)).not.toContain(user.totpSecret);
  });

  it('lets the account back in once the lock has expired', async () => {
    const user = await createUser();

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      const token = await preMfaToken(user);
      await auth.verifyMfa({ token, code: '000000' }).catch(() => undefined);
    }

    await prisma.platformUser.update({
      where: { id: user.id },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });

    const token = await preMfaToken(user);
    const actor = await auth.verifyMfa({ token, code: totpCode(user.totpSecret) });
    expect(actor.platformUserId).toBe(user.id);

    const row = await prisma.platformUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it('resets the counter on a successful verification before the threshold', async () => {
    const user = await createUser();

    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 2; i += 1) {
      const token = await preMfaToken(user);
      await auth.verifyMfa({ token, code: '000000' }).catch(() => undefined);
    }

    const midway = await prisma.platformUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(midway.failedLoginCount).toBe(MAX_FAILED_ATTEMPTS - 2);
    expect(midway.lockedUntil).toBeNull();

    const token = await preMfaToken(user);
    await auth.verifyMfa({ token, code: totpCode(user.totpSecret) });

    const after = await prisma.platformUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.failedLoginCount).toBe(0);
    expect(after.lockedUntil).toBeNull();
  });
});

describe('failed-attempt counting is atomic', () => {
  it('loses no increments when attempts run in parallel', async () => {
    const user = await createUser();
    const attempts = MAX_FAILED_ATTEMPTS - 1;

    const tokens = await Promise.all(Array.from({ length: attempts }, () => preMfaToken(user)));
    await Promise.all(
      tokens.map((token) => auth.verifyMfa({ token, code: '000000' }).catch(() => undefined)),
    );

    const row = await prisma.platformUser.findUniqueOrThrow({ where: { id: user.id } });
    // Every parallel attempt must be counted. A read-modify-write counter loses
    // most of them and the account never locks.
    expect(row.failedLoginCount).toBe(attempts);
    expect(row.lockedUntil).toBeNull();
  });

  it('cannot be pushed past the threshold without locking, even fully in parallel', async () => {
    const user = await createUser();
    const attempts = MAX_FAILED_ATTEMPTS * 2;

    // Held from before the lock: once the account locks, a fresh password login
    // is refused too, so this is the only session an attacker could still hold.
    const survivor = await preMfaToken(user);

    const tokens = await Promise.all(Array.from({ length: attempts }, () => preMfaToken(user)));
    await Promise.all(
      tokens.map((token) => auth.verifyMfa({ token, code: '000000' }).catch(() => undefined)),
    );

    const row = await prisma.platformUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.lockedUntil).not.toBeNull();

    // Neither the surviving session nor a new login can get through.
    await expect(
      auth.verifyMfa({ token: survivor, code: totpCode(user.totpSecret) }),
    ).rejects.toThrow();
    await expect(
      auth.authenticateWithPassword({ email: user.email, password: PASSWORD }),
    ).rejects.toThrow('Invalid credentials.');
  });

  it('counts parallel wrong PASSWORDS atomically too', async () => {
    const user = await createUser();
    const attempts = MAX_FAILED_ATTEMPTS - 1;

    await Promise.all(
      Array.from({ length: attempts }, (_unused, i) =>
        auth
          .authenticateWithPassword({ email: user.email, password: `wrong-${i}` })
          .catch(() => undefined),
      ),
    );

    const row = await prisma.platformUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedLoginCount).toBe(attempts);
  });
});

// ---------------------------------------------------------------------------
// Finding 3 — a recovery code is consumed exactly once
// ---------------------------------------------------------------------------

describe('a recovery code can be spent exactly once', () => {
  it('lets only ONE of two concurrent requests succeed with the same code', async () => {
    const user = await createUser();
    const codes = generateRecoveryCodes(3);
    await auth.storeRecoveryCodes(user.id, codes);
    const code = codes[0]!;

    const [tokenA, tokenB] = await Promise.all([preMfaToken(user), preMfaToken(user)]);

    const results = await Promise.all([
      auth
        .verifyMfa({ token: tokenA, code })
        .then(() => 'ok' as const)
        .catch(() => 'refused' as const),
      auth
        .verifyMfa({ token: tokenB, code })
        .then(() => 'ok' as const)
        .catch(() => 'refused' as const),
    ]);

    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'refused')).toHaveLength(1);
  });

  it('records exactly one consumption timestamp for that code', async () => {
    const user = await createUser();
    const codes = generateRecoveryCodes(3);
    await auth.storeRecoveryCodes(user.id, codes);
    const code = codes[0]!;

    const tokens = await Promise.all([
      preMfaToken(user),
      preMfaToken(user),
      preMfaToken(user),
      preMfaToken(user),
    ]);
    await Promise.all(
      tokens.map((token) => auth.verifyMfa({ token, code }).catch(() => undefined)),
    );

    const used = await prisma.platformMfaRecoveryCode.findMany({
      where: { platformUserId: user.id, usedAt: { not: null } },
    });
    expect(used).toHaveLength(1);
  });

  it('leaves the code unusable afterwards', async () => {
    const user = await createUser();
    const codes = generateRecoveryCodes(3);
    await auth.storeRecoveryCodes(user.id, codes);
    const code = codes[0]!;

    await auth.verifyMfa({ token: await preMfaToken(user), code });

    await expect(auth.verifyMfa({ token: await preMfaToken(user), code })).rejects.toThrow();
  });

  it('never stores a recovery code in clear', async () => {
    const user = await createUser();
    const codes = generateRecoveryCodes(3);
    await auth.storeRecoveryCodes(user.id, codes);

    const rows = await prisma.$queryRawUnsafe<Array<{ blob: string }>>(
      `SELECT "platform_mfa_recovery_code"::text AS blob FROM "platform_mfa_recovery_code"`,
    );
    const all = rows.map((r) => r.blob).join('\n');
    for (const code of codes) {
      expect(all).not.toContain(code);
    }
  });
});
