import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { TOTP, Secret } from 'otpauth';
import {
  ADMIN_CAPABLE_ROLES,
  LOCKOUT_MINUTES,
  MAX_FAILED_ATTEMPTS,
  CUSTOMER_REALM,
  PLATFORM_REALM,
  PlatformAuthService,
  generateRecoveryCodes,
  generateTotpEnrolment,
  hashPassword,
  requirePermission,
} from '@brandspace/auth';
import { SecretService } from '@brandspace/secrets';
import { PLATFORM_PERMISSIONS } from '@brandspace/shared';
import { ensurePlatformRole, platformRoleClient } from './fixtures';
import type { PrismaClient } from '@prisma/client';

/**
 * Platform Admin authentication against a REAL PostgreSQL — section A of Phase 2A.
 *
 * The claims under test are the ones that would matter on the day someone
 * attacks the Control Center:
 *
 *   - a password alone is worth NOTHING; the session it creates grants nothing
 *     until MFA succeeds (D-27),
 *   - the tenant application role cannot read the tables these sessions live in,
 *     nor the password hashes they authenticate against,
 *   - a customer session cannot become a platform session by any route,
 *   - revoked, expired and role-demoted sessions stop working immediately.
 *
 * Everything runs on the PLATFORM pool because that is what production admin code
 * uses. Nothing here gets a private door into the database.
 */

const PASSWORD = 'correct horse battery staple';
const ENV = 'DEVELOPMENT' as const;

let prisma: PrismaClient;
let auth: PlatformAuthService;
let secrets: SecretService;
let tenantSql: Client;

let ownerRoleId: string;
let userId: string;
let userEmail: string;
let totpSecret: string;
let recoveryCodes: string[];

/** A valid code for right now, so the test never depends on wall-clock luck. */
function currentTotpCode(secret: string): string {
  return new TOTP({
    issuer: 'BrandSpace Platform',
    label: 'test',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate();
}

async function createPlatformUser(options: {
  roleId: string;
  status?: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  withPassword?: boolean;
  withMfa?: boolean;
}): Promise<{ id: string; email: string; secret?: string }> {
  const email = `auth-${randomUUID()}@brandspace.local`;
  const enrolment = options.withMfa ? generateTotpEnrolment(email) : null;

  if (enrolment) {
    await secrets.createSecret(
      {
        platformUserId: SYSTEM_ACTOR_ID,
        roleKey: 'platform_owner',
        mfaVerified: true,
        permissionKeys: PLATFORM_PERMISSIONS.map((p) => p.key),
      },
      {
        ref: `mfa-totp/platform/${ENV.toLowerCase()}/${email}`,
        name: `TOTP seed for ${email}`,
        category: 'mfa_totp',
        environment: ENV,
        value: enrolment.secret,
      },
    );
  }

  const created = await prisma.platformUser.create({
    data: {
      email,
      name: 'Auth Test User',
      status: options.status ?? 'ACTIVE',
      roleId: options.roleId,
      passwordHash: options.withPassword === false ? null : await hashPassword(PASSWORD),
      mfaEnabled: enrolment !== null,
      mfaSecretRef: enrolment ? `mfa-totp/platform/${ENV.toLowerCase()}/${email}` : null,
      mfaEnrolledAt: enrolment ? new Date() : null,
    },
  });

  const result: { id: string; email: string; secret?: string } = {
    id: created.id,
    email,
  };
  if (enrolment) result.secret = enrolment.secret;
  return result;
}

/** A stable platform user id used as the actor that provisions test secrets. */
let SYSTEM_ACTOR_ID: string;

beforeAll(async () => {
  prisma = platformRoleClient();
  secrets = new SecretService({ prisma, env: { SECRET_VAULT_KEK: 'a'.repeat(48) } });

  // Bootstrapped, not assumed: CI applies migrations and runs no seed, so a
  // suite that only READS this role passes on a seeded developer database and
  // fails on a fresh one.
  ownerRoleId = await ensurePlatformRole(prisma);

  const systemUser = await prisma.platformUser.create({
    data: {
      email: `auth-system-${randomUUID()}@brandspace.local`,
      name: 'Auth Test Provisioner',
      status: 'ACTIVE',
      roleId: ownerRoleId,
    },
  });
  SYSTEM_ACTOR_ID = systemUser.id;

  auth = new PlatformAuthService({
    prisma,
    resolveMfaSecret: (ref) => secrets.resolveSecret(ref, ENV),
  });

  const user = await createPlatformUser({ roleId: ownerRoleId, withMfa: true });
  userId = user.id;
  userEmail = user.email;
  totpSecret = user.secret!;

  recoveryCodes = generateRecoveryCodes(3);
  await auth.storeRecoveryCodes(userId, recoveryCodes);

  tenantSql = new Client({ connectionString: process.env['DATABASE_URL'] });
  await tenantSql.connect();
});

afterAll(async () => {
  // Optional-chained so a failure in beforeAll reports ITS error rather than a
  // confusing "cannot read 'end' of undefined" on top of it.
  await tenantSql?.end();
  await prisma?.$disconnect();
});

// ---------------------------------------------------------------------------
// The tenant role cannot see admin credentials at all
// ---------------------------------------------------------------------------

describe('the tenant application role is refused Platform Admin identity data', () => {
  it.each([
    ['platform_user', 'password hashes and MFA secret references'],
    ['platform_session', 'live admin sessions'],
    ['platform_mfa_recovery_code', 'MFA recovery codes'],
  ])('cannot read %s (%s)', async (table) => {
    await expect(tenantSql.query(`SELECT * FROM "${table}" LIMIT 1`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('is refused rather than returned an empty result', async () => {
    // The distinction matters: zero rows would mean the grant exists and only
    // RLS is holding the line. A permission error means the tenant role has no
    // privilege on the table at all, so a future policy mistake is not enough
    // on its own to expose it.
    const error = await tenantSql
      .query('SELECT "passwordHash" FROM "platform_user"')
      .then(() => null)
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/permission denied for table platform_user/i);
  });

  it('cannot reach the password hash through a join from a tenant table either', async () => {
    await expect(
      tenantSql.query(
        'SELECT p."passwordHash" FROM "support_mode_session" s JOIN "platform_user" p ON p.id = s."platformUserId"',
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('lets the platform role read what the tenant role cannot', async () => {
    // The negative assertions above would also pass if the table were empty or
    // misnamed. This proves they are failing for the right reason.
    const rows = await prisma.platformUser.findMany({ where: { id: userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.passwordHash).toMatch(/^\$argon2id\$/);
  });
});

// ---------------------------------------------------------------------------
// MFA enforcement (D-27)
// ---------------------------------------------------------------------------

describe('MFA is mandatory for every platform session (D-27)', () => {
  it('creates a session on a correct password that grants NOTHING', async () => {
    const { session, mfaRequired } = await auth.authenticateWithPassword({
      email: userEmail,
      password: PASSWORD,
      ip: '203.0.113.10',
    });

    expect(mfaRequired).toBe(true);

    // The session row exists...
    const stored = await prisma.platformSession.findUnique({ where: { id: session.sessionId } });
    expect(stored).not.toBeNull();
    expect(stored?.mfaVerifiedAt).toBeNull();

    // ...and resolves to no actor whatsoever. A stolen pre-MFA cookie is worthless.
    await expect(auth.resolveActor(session.token)).resolves.toBeNull();
  });

  it('rejects a permission check for a pre-MFA session', async () => {
    const { session } = await auth.authenticateWithPassword({
      email: userEmail,
      password: PASSWORD,
    });
    const actor = await auth.resolveActor(session.token);
    expect(() => requirePermission(actor, 'platform.configuration.read')).toThrow(
      /authentication required/i,
    );
  });

  it('makes the session usable only after a valid TOTP code', async () => {
    const { session } = await auth.authenticateWithPassword({
      email: userEmail,
      password: PASSWORD,
    });

    const verified = await auth.verifyMfa({
      token: session.token,
      code: currentTotpCode(totpSecret),
    });
    expect(verified.platformUserId).toBe(userId);
    expect(verified.mfaVerified).toBe(true);

    const actor = await auth.resolveActor(session.token);
    expect(actor?.platformUserId).toBe(userId);
    expect(actor?.mfaVerified).toBe(true);
  });

  it('refuses a wrong TOTP code and leaves the session unusable', async () => {
    const { session } = await auth.authenticateWithPassword({
      email: userEmail,
      password: PASSWORD,
    });

    await expect(auth.verifyMfa({ token: session.token, code: '000000' })).rejects.toThrow(
      /Invalid verification code/i,
    );
    await expect(auth.resolveActor(session.token)).resolves.toBeNull();
  });

  it('refuses sign-in for an account that never enrolled in MFA', async () => {
    const unenrolled = await createPlatformUser({ roleId: ownerRoleId, withMfa: false });
    const { session } = await auth.authenticateWithPassword({
      email: unenrolled.email,
      password: PASSWORD,
    });

    await expect(auth.verifyMfa({ token: session.token, code: '123456' })).rejects.toThrow(
      /MFA enrolment is required/i,
    );
    await expect(auth.resolveActor(session.token)).resolves.toBeNull();
  });

  it('accepts a recovery code exactly once', async () => {
    const code = recoveryCodes[0]!;

    const first = await auth.authenticateWithPassword({ email: userEmail, password: PASSWORD });
    const actor = await auth.verifyMfa({ token: first.session.token, code });
    expect(actor.mfaVerified).toBe(true);

    const second = await auth.authenticateWithPassword({ email: userEmail, password: PASSWORD });
    await expect(auth.verifyMfa({ token: second.session.token, code })).rejects.toThrow(
      /Invalid verification code/i,
    );
  });

  it('stores recovery codes only as hashes', async () => {
    const rows = await prisma.platformMfaRecoveryCode.findMany({
      where: { platformUserId: userId },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      for (const plaintext of recoveryCodes) {
        expect(row.codeHash).not.toContain(plaintext);
      }
    }
  });

  it('never stores the TOTP seed in a platform_user column', async () => {
    const row = await prisma.platformUser.findUniqueOrThrow({ where: { id: userId } });
    expect(JSON.stringify(row)).not.toContain(totpSecret);
    // Only a REFERENCE into the vault is stored.
    expect(row.mfaSecretRef).toMatch(/^mfa-totp\/platform\//);
  });
});

// ---------------------------------------------------------------------------
// Login failures reveal nothing
// ---------------------------------------------------------------------------

describe('authentication failures do not leak which accounts exist', () => {
  it('returns the same error for an unknown email and a wrong password', async () => {
    const unknown = await auth
      .authenticateWithPassword({
        email: `nobody-${randomUUID()}@brandspace.local`,
        password: PASSWORD,
      })
      .catch((e: Error) => e);
    const wrongPassword = await auth
      .authenticateWithPassword({ email: userEmail, password: 'not the password at all' })
      .catch((e: Error) => e);

    expect(unknown).toBeInstanceOf(Error);
    expect(wrongPassword).toBeInstanceOf(Error);
    expect((unknown as Error).message).toBe((wrongPassword as Error).message);
    expect((unknown as Error).message).toBe('Invalid credentials.');
  });

  it('refuses a suspended account with the same message', async () => {
    const suspended = await createPlatformUser({ roleId: ownerRoleId, status: 'SUSPENDED' });
    await expect(
      auth.authenticateWithPassword({ email: suspended.email, password: PASSWORD }),
    ).rejects.toThrow('Invalid credentials.');
  });

  it('refuses an account that has no password set', async () => {
    const passwordless = await createPlatformUser({
      roleId: ownerRoleId,
      withPassword: false,
    });
    await expect(
      auth.authenticateWithPassword({ email: passwordless.email, password: PASSWORD }),
    ).rejects.toThrow('Invalid credentials.');
  });

  it('writes a DENIED audit event for a failed login', async () => {
    const before = await prisma.auditEvent.count({
      where: { action: 'platform.login.failed', outcome: 'DENIED' },
    });
    await auth
      .authenticateWithPassword({ email: userEmail, password: 'wrong password value' })
      .catch(() => undefined);
    const after = await prisma.auditEvent.count({
      where: { action: 'platform.login.failed', outcome: 'DENIED' },
    });
    expect(after).toBe(before + 1);
  });

  it('never writes the password into the audit trail', async () => {
    const secretish = 'Sup3rSecretPassword!parked';
    await auth
      .authenticateWithPassword({ email: userEmail, password: secretish })
      .catch(() => undefined);

    const rows = await prisma.$queryRawUnsafe<Array<{ blob: string }>>(
      `SELECT "audit_event"::text AS blob FROM "audit_event" ORDER BY "occurredAt" DESC LIMIT 20`,
    );
    for (const row of rows) {
      expect(row.blob).not.toContain(secretish);
    }
  });
});

// ---------------------------------------------------------------------------
// Brute-force protection
// ---------------------------------------------------------------------------

describe('repeated failures lock the account', () => {
  it('locks after the configured number of wrong passwords, and stays locked for the CORRECT one', async () => {
    const victim = await createPlatformUser({ roleId: ownerRoleId, withMfa: true });

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await expect(
        auth.authenticateWithPassword({ email: victim.email, password: `wrong-${attempt}` }),
      ).rejects.toThrow('Invalid credentials.');
    }

    // The right password is now refused too — that is the whole point.
    await expect(
      auth.authenticateWithPassword({ email: victim.email, password: PASSWORD }),
    ).rejects.toThrow('Invalid credentials.');

    const row = await prisma.platformUser.findUniqueOrThrow({ where: { id: victim.id } });
    expect(row.lockedUntil).not.toBeNull();
    const minutesOut = (row.lockedUntil!.getTime() - Date.now()) / 60_000;
    expect(minutesOut).toBeGreaterThan(LOCKOUT_MINUTES - 2);
    expect(minutesOut).toBeLessThanOrEqual(LOCKOUT_MINUTES);
  });

  it('gives a locked account the same message as a wrong password, so it cannot be probed', async () => {
    const victim = await createPlatformUser({ roleId: ownerRoleId, withMfa: true });
    await prisma.platformUser.update({
      where: { id: victim.id },
      data: { lockedUntil: new Date(Date.now() + 60_000) },
    });

    const lockedError = await auth
      .authenticateWithPassword({ email: victim.email, password: PASSWORD })
      .catch((e: Error) => e.message);
    const unknownError = await auth
      .authenticateWithPassword({
        email: `nobody-${randomUUID()}@brandspace.local`,
        password: PASSWORD,
      })
      .catch((e: Error) => e.message);

    expect(lockedError).toBe(unknownError);
  });

  it('audits the lockout refusal separately, so repeated locks are visible to operators', async () => {
    const victim = await createPlatformUser({ roleId: ownerRoleId, withMfa: true });
    await prisma.platformUser.update({
      where: { id: victim.id },
      data: { lockedUntil: new Date(Date.now() + 60_000) },
    });
    await auth
      .authenticateWithPassword({ email: victim.email, password: PASSWORD })
      .catch(() => undefined);

    const events = await prisma.auditEvent.findMany({
      where: { actorId: victim.id, action: 'platform.login.locked' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('DENIED');
  });

  it('lets a locked account back in once the lock has expired', async () => {
    const victim = await createPlatformUser({ roleId: ownerRoleId, withMfa: true });
    await prisma.platformUser.update({
      where: { id: victim.id },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });

    const result = await auth.authenticateWithPassword({
      email: victim.email,
      password: PASSWORD,
    });
    expect(result.mfaRequired).toBe(true);
  });

  it('counts failed MFA codes too, so a stolen password does not buy a million guesses', async () => {
    const victim = await createPlatformUser({ roleId: ownerRoleId, withMfa: true });

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      const { session } = await auth.authenticateWithPassword({
        email: victim.email,
        password: PASSWORD,
      });
      await expect(auth.verifyMfa({ token: session.token, code: '000000' })).rejects.toThrow(
        'Invalid verification code.',
      );
    }

    const row = await prisma.platformUser.findUniqueOrThrow({ where: { id: victim.id } });
    expect(row.lockedUntil).not.toBeNull();
  });

  it('clears the counter and the lock on a successful sign-in', async () => {
    const victim = await createPlatformUser({ roleId: ownerRoleId, withMfa: true });
    await prisma.platformUser.update({
      where: { id: victim.id },
      data: { failedLoginCount: 3, lockedUntil: new Date(Date.now() - 1000) },
    });

    const { session } = await auth.authenticateWithPassword({
      email: victim.email,
      password: PASSWORD,
    });
    await auth.verifyMfa({ token: session.token, code: currentTotpCode(victim.secret!) });

    const row = await prisma.platformUser.findUniqueOrThrow({ where: { id: victim.id } });
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe('session lifecycle', () => {
  async function signedInToken(): Promise<string> {
    const { session } = await auth.authenticateWithPassword({
      email: userEmail,
      password: PASSWORD,
    });
    await auth.verifyMfa({ token: session.token, code: currentTotpCode(totpSecret) });
    return session.token;
  }

  it('stops resolving a revoked session immediately', async () => {
    const token = await signedInToken();
    await expect(auth.resolveActor(token)).resolves.not.toBeNull();

    await auth.revokeSession(token, 'Signed out in test');
    await expect(auth.resolveActor(token)).resolves.toBeNull();
  });

  it('revokes every session for a user at once', async () => {
    const a = await signedInToken();
    const b = await signedInToken();

    const count = await auth.revokeAllSessions(userId, 'Credential rotation');
    expect(count).toBeGreaterThanOrEqual(2);

    await expect(auth.resolveActor(a)).resolves.toBeNull();
    await expect(auth.resolveActor(b)).resolves.toBeNull();
  });

  it('stops resolving a session past its idle expiry', async () => {
    const token = await signedInToken();
    const hash = await prisma.platformSession.findFirstOrThrow({
      where: { platformUserId: userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    await prisma.platformSession.update({
      where: { id: hash.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(auth.resolveActor(token)).resolves.toBeNull();
  });

  it('stops resolving a session past its absolute lifetime, even if recently active', async () => {
    const token = await signedInToken();
    const session = await prisma.platformSession.findFirstOrThrow({
      where: { platformUserId: userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    await prisma.platformSession.update({
      where: { id: session.id },
      data: {
        expiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() - 1000),
      },
    });
    await expect(auth.resolveActor(token)).resolves.toBeNull();
  });

  it('never stores the session token itself', async () => {
    const token = await signedInToken();
    const rows = await prisma.$queryRawUnsafe<Array<{ blob: string }>>(
      `SELECT "platform_session"::text AS blob FROM "platform_session"`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.blob).not.toContain(token);
    }
  });

  it('rejects an unknown, empty or malformed token without throwing', async () => {
    await expect(auth.resolveActor(undefined)).resolves.toBeNull();
    await expect(auth.resolveActor('')).resolves.toBeNull();
    await expect(auth.resolveActor('not-a-real-token')).resolves.toBeNull();
    await expect(auth.resolveActor(randomUUID())).resolves.toBeNull();
  });

  it('stops resolving when the account is suspended mid-session', async () => {
    const token = await signedInToken();
    await prisma.platformUser.update({ where: { id: userId }, data: { status: 'SUSPENDED' } });
    await expect(auth.resolveActor(token)).resolves.toBeNull();
    await prisma.platformUser.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
  });
});

// ---------------------------------------------------------------------------
// Role gating
// ---------------------------------------------------------------------------

describe('role gating for the Control Center', () => {
  let outsiderRoleId: string;

  beforeAll(async () => {
    const existing = await prisma.role.findFirst({
      where: { key: 'workspace_owner', workspaceId: null },
    });
    outsiderRoleId =
      existing?.id ??
      (
        await prisma.role.create({
          data: {
            key: 'workspace_owner',
            workspaceId: null,
            realm: 'WORKSPACE',
            nameEn: 'Workspace Owner',
            nameAr: 'مالك مساحة العمل',
            isSystem: true,
          },
        })
      ).id;
  });

  it('refuses password login for a role that may not reach the Control Center', async () => {
    const outsider = await createPlatformUser({ roleId: outsiderRoleId, withMfa: true });
    await expect(
      auth.authenticateWithPassword({ email: outsider.email, password: PASSWORD }),
    ).rejects.toThrow(/may not access the Control Center/i);
  });

  it('drops an existing session when the role is demoted below admin capability', async () => {
    const demotable = await createPlatformUser({ roleId: ownerRoleId, withMfa: true });
    const demotableAuth = new PlatformAuthService({
      prisma,
      resolveMfaSecret: (ref) => secrets.resolveSecret(ref, ENV),
    });
    const { session } = await demotableAuth.authenticateWithPassword({
      email: demotable.email,
      password: PASSWORD,
    });
    await demotableAuth.verifyMfa({
      token: session.token,
      code: currentTotpCode(demotable.secret!),
    });
    await expect(demotableAuth.resolveActor(session.token)).resolves.not.toBeNull();

    await prisma.platformUser.update({
      where: { id: demotable.id },
      data: { roleId: outsiderRoleId },
    });
    await expect(demotableAuth.resolveActor(session.token)).resolves.toBeNull();
  });

  it('does not treat a workspace role as admin-capable', () => {
    expect(ADMIN_CAPABLE_ROLES.has('workspace_owner')).toBe(false);
    expect(ADMIN_CAPABLE_ROLES.has('platform_owner')).toBe(true);
  });

  it('refuses a permission the actor does not hold', async () => {
    const { session } = await auth.authenticateWithPassword({
      email: userEmail,
      password: PASSWORD,
    });
    const actor = await auth.verifyMfa({
      token: session.token,
      code: currentTotpCode(totpSecret),
    });
    expect(() => requirePermission(actor, 'platform.nonexistent.permission')).toThrow(
      /Missing platform permission/,
    );
  });
});

// ---------------------------------------------------------------------------
// Customer sessions can never become platform sessions
// ---------------------------------------------------------------------------

describe('a customer session is not a platform session', () => {
  it('uses a different cookie, so an admin request never even reads the customer token', () => {
    expect(PLATFORM_REALM.cookieName).not.toBe(CUSTOMER_REALM.cookieName);
    expect(PLATFORM_REALM.audience).not.toBe(CUSTOMER_REALM.audience);
    expect(PLATFORM_REALM.secretEnvVar).not.toBe(CUSTOMER_REALM.secretEnvVar);
  });

  it('resolves no actor for a token that is not in the platform session store', async () => {
    // Whatever a customer session token looks like, it was never written to
    // platform_session, so it cannot resolve here. There is no shared store to
    // confuse the two realms.
    const customerLookingToken = Buffer.from(
      JSON.stringify({ aud: CUSTOMER_REALM.audience, sub: randomUUID() }),
    ).toString('base64url');

    await expect(auth.resolveActor(customerLookingToken)).resolves.toBeNull();
  });

  it('has no workspace-scoped rows in the platform session table at all', async () => {
    // If a customer session were ever stored here, it would need a workspace
    // reference. The table has no such column, by design.
    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'platform_session'`,
    );
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('workspaceId');
    expect(names).toContain('platformUserId');
  });

  it('gives a platform actor no workspace permissions', async () => {
    const { session } = await auth.authenticateWithPassword({
      email: userEmail,
      password: PASSWORD,
    });
    const actor = await auth.verifyMfa({
      token: session.token,
      code: currentTotpCode(totpSecret),
    });
    for (const key of actor.permissionKeys) {
      expect(key.startsWith('platform.')).toBe(true);
    }
  });
});
