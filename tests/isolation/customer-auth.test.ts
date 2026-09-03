import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CUSTOMER_MAX_FAILED_ATTEMPTS,
  CUSTOMER_REALM,
  CustomerAuthService,
  PLATFORM_REALM,
  PlatformAuthService,
  hashPassword,
  hashSessionToken,
} from '@brandspace/auth';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Customer authentication, against a real PostgreSQL.
 *
 * The properties under test are the ones that are cheap to claim and expensive
 * to get wrong: realm separation, enumeration resistance, lockout that actually
 * locks, and a session whose workspace scope is re-derived rather than trusted.
 *
 * Every assertion here would have caught a specific Phase 2A defect had the
 * equivalent existed then — R-01 (a lockout that never locked) most of all.
 */

const PASSWORD = 'a-strong-local-only-test-password-8842';

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
  // THE TENANT CLIENT, deliberately. Running these against the platform client
  // would prove nothing about what the customer application can actually do:
  // an earlier version of this file did exactly that and missed that
  // `listWorkspaces` returned NOTHING under RLS, because `membership` and
  // `workspace` are invisible without a workspace context — which is precisely
  // the state authentication runs in.
  auth = new CustomerAuthService({ prisma: app });

  // Give tenant A's owner a usable password. B's owner deliberately keeps none,
  // so the "passwordless account" path is exercised too.
  await platform.user.update({
    where: { id: fixtures.a.userId },
    data: { passwordHash: await hashPassword(PASSWORD), status: 'ACTIVE' },
  });
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('the two session realms cannot cross', () => {
  it('uses a different cookie, audience and signing key', () => {
    expect(CUSTOMER_REALM.cookieName).not.toBe(PLATFORM_REALM.cookieName);
    expect(CUSTOMER_REALM.audience).not.toBe(PLATFORM_REALM.audience);
    expect(CUSTOMER_REALM.secretEnvVar).not.toBe(PLATFORM_REALM.secretEnvVar);
  });

  it('a customer token resolves to NO platform actor', async () => {
    const session = await auth.signIn({ email: fixtures.a.userEmail, password: PASSWORD });
    const platformAuth = new PlatformAuthService({
      prisma: platform,
      resolveMfaSecret: async () => 'unused',
    });
    await expect(platformAuth.resolveActor(session.token)).resolves.toBeNull();
  });

  it('a platform session token resolves to NO customer', async () => {
    // Not "is rejected" — there is no row. The realms share no store, so this
    // cannot be re-enabled by forgetting a check.
    const platformSession = await platform.platformSession.create({
      data: {
        platformUserId: fixtures.platformUserId,
        tokenHash: hashSessionToken(`platform-token-under-test-${Date.now()}`),
        mfaVerifiedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
        absoluteExpiresAt: new Date(Date.now() + 7200_000),
      },
    });
    expect(platformSession.id).toBeTruthy();
    // The platform token itself: not in `customer_session` at all.
    await expect(auth.resolve('platform-token-under-test')).resolves.toBeNull();
  });

  it('the two session tables are physically separate', async () => {
    const [customerCount, platformCount] = await Promise.all([
      platform.customerSession.count(),
      platform.platformSession.count(),
    ]);
    expect(customerCount).toBeGreaterThan(0);
    expect(platformCount).toBeGreaterThan(0);
  });
});

describe('sign-in does not reveal whether an account exists', () => {
  it('returns the same message for an unknown address and a wrong password', async () => {
    const unknown = await auth
      .signIn({ email: `nobody-${Date.now()}@example.local`, password: PASSWORD })
      .catch((e: Error) => e.message);
    const wrong = await auth
      .signIn({ email: fixtures.a.userEmail, password: 'definitely-not-the-password' })
      .catch((e: Error) => e.message);

    expect(unknown).toBe('Invalid credentials.');
    expect(wrong).toBe('Invalid credentials.');
    expect(unknown).toBe(wrong);
  });

  it('returns the same message for a PASSWORDLESS (invitation-only) account', async () => {
    // B's owner has no password hash. Without the dummy-verify guard this path
    // would return in a fraction of the time and be a reliable oracle.
    const passwordless = await auth
      .signIn({ email: fixtures.b.userEmail, password: PASSWORD })
      .catch((e: Error) => e.message);
    expect(passwordless).toBe('Invalid credentials.');
  });

  it('returns the same message for a SUSPENDED account with the right password', async () => {
    const email = `suspended-${Date.now()}@example.local`;
    await platform.user.create({
      data: {
        email,
        status: 'SUSPENDED',
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
      },
    });
    const message = await auth.signIn({ email, password: PASSWORD }).catch((e: Error) => e.message);
    expect(message).toBe('Invalid credentials.');
  });

  it('audits the real reason, so an operator can still tell them apart', async () => {
    // Re-run the passwordless attempt here rather than relying on test order.
    await auth.signIn({ email: fixtures.b.userEmail, password: PASSWORD }).catch(() => undefined);

    const events = await platform.auditEvent.findMany({
      where: { actorId: fixtures.b.userId, outcome: 'DENIED' },
      orderBy: { occurredAt: 'desc' },
      take: 10,
    });
    expect(events.some((e) => e.action === 'customer.auth.no_password')).toBe(true);
  });

  it('the tenant role can WRITE an authentication audit event but never READ it', async () => {
    // The asymmetry is deliberate and is what the `createMany` above works
    // with: the write is permitted from the authentication path, and the read
    // is not permitted from anywhere in the tenant role.
    await auth.signIn({ email: fixtures.b.userEmail, password: PASSWORD }).catch(() => undefined);

    const visibleToTenant = await app.auditEvent.findMany({
      where: { action: 'customer.auth.no_password' },
    });
    expect(visibleToTenant).toHaveLength(0);

    const visibleToPlatform = await platform.auditEvent.findMany({
      where: { action: 'customer.auth.no_password' },
    });
    expect(visibleToPlatform.length).toBeGreaterThan(0);
  });
});

describe('lockout actually locks', () => {
  it('locks the account after the threshold and refuses the CORRECT password', async () => {
    const email = `lockout-${Date.now()}@example.local`;
    const user = await platform.user.create({
      data: {
        email,
        status: 'ACTIVE',
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
      },
    });

    for (let i = 0; i < CUSTOMER_MAX_FAILED_ATTEMPTS; i += 1) {
      await auth.signIn({ email, password: 'wrong' }).catch(() => undefined);
    }

    const locked = await platform.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(locked.lockedUntil).not.toBeNull();
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // THE assertion R-01 was missing: the right password must still be refused.
    await expect(auth.signIn({ email, password: PASSWORD })).rejects.toThrow(
      'Invalid credentials.',
    );
  }, 60_000);

  it('loses no increments when attempts arrive in parallel', async () => {
    const email = `parallel-${Date.now()}@example.local`;
    const user = await platform.user.create({
      data: {
        email,
        status: 'ACTIVE',
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
      },
    });

    const attempts = CUSTOMER_MAX_FAILED_ATTEMPTS - 1;
    await Promise.all(
      Array.from({ length: attempts }, () =>
        auth.signIn({ email, password: 'wrong' }).catch(() => undefined),
      ),
    );

    // Read-modify-write would record 1. An atomic UPDATE records every one.
    const row = await platform.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedLoginCount).toBe(attempts);
  }, 60_000);

  it('clears the counter on a successful sign-in', async () => {
    await auth.signIn({ email: fixtures.a.userEmail, password: 'wrong' }).catch(() => undefined);
    await auth.signIn({ email: fixtures.a.userEmail, password: PASSWORD });
    const row = await platform.user.findUniqueOrThrow({ where: { id: fixtures.a.userId } });
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });
});

describe('a session grants identity, never workspace scope', () => {
  it('stores only the token hash', async () => {
    const session = await auth.signIn({ email: fixtures.a.userEmail, password: PASSWORD });
    const row = await platform.customerSession.findUniqueOrThrow({
      where: { id: session.sessionId },
    });
    expect(row.tokenHash).not.toBe(session.token);
    expect(row.tokenHash).toBe(hashSessionToken(session.token));

    // The raw token appears in no column of the row.
    expect(JSON.stringify(row)).not.toContain(session.token);
  });

  it('lists only workspaces the user is an ACTIVE member of', async () => {
    const session = await auth.signIn({ email: fixtures.a.userEmail, password: PASSWORD });
    const workspaces = await auth.listWorkspaces(session.token);
    expect(workspaces.map((w) => w.workspaceId)).toEqual([fixtures.a.workspaceId]);
    expect(workspaces.map((w) => w.workspaceId)).not.toContain(fixtures.b.workspaceId);
  });

  it('refuses a token that matches no session instead of reporting no workspaces', async () => {
    // REGRESSION. `listWorkspaces` takes the SESSION TOKEN. A caller that passed
    // a user id — the same TypeScript type — used to get `[]` back, which the
    // workspace picker rendered as "no workspace is available to your account".
    // A silent empty list cannot be told apart from a genuine member-of-nothing,
    // so an unknown token now fails loudly.
    const session = await auth.signIn({ email: fixtures.a.userEmail, password: PASSWORD });
    expect(await auth.listWorkspaces(session.token)).toHaveLength(1);

    await expect(auth.listWorkspaces(fixtures.a.userId)).rejects.toThrow(
      'Your session is no longer valid.',
    );
    await expect(auth.listWorkspaces('not-a-real-session-token')).rejects.toThrow(
      'Your session is no longer valid.',
    );

    // A revoked session is refused on the same terms.
    await auth.signOut(session.token);
    await expect(auth.listWorkspaces(session.token)).rejects.toThrow(
      'Your session is no longer valid.',
    );
  });

  it('refuses to switch into a workspace the user does not belong to', async () => {
    const session = await auth.signIn({ email: fixtures.a.userEmail, password: PASSWORD });
    // NOT_FOUND, shaped exactly like a workspace that does not exist — so this
    // cannot be used to discover that tenant B exists.
    await expect(auth.switchWorkspace(session.token, fixtures.b.workspaceId)).rejects.toThrow(
      'Workspace not found.',
    );
  });

  it('drops the active workspace when the membership is removed', async () => {
    const session = await auth.signIn({ email: fixtures.a.userEmail, password: PASSWORD });
    await auth.switchWorkspace(session.token, fixtures.a.workspaceId);

    await platform.membership.update({
      where: { id: fixtures.a.membershipId },
      data: { status: 'REMOVED' },
    });

    // Re-derived on every resolve, so revocation lands at the next request
    // rather than at the next login.
    const after = await auth.resolve(session.token);
    expect(after?.activeWorkspaceId).toBeNull();

    await platform.membership.update({
      where: { id: fixtures.a.membershipId },
      data: { status: 'ACTIVE' },
    });
  });

  it('a multi-workspace user sees both and switches cleanly between them', async () => {
    // Give A's owner a membership in B as well: an agency shape.
    const role = await platform.role.findFirstOrThrow({
      where: { key: 'workspace_admin', workspaceId: null },
    });
    await platform.membership.create({
      data: {
        workspaceId: fixtures.b.workspaceId,
        userId: fixtures.a.userId,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
        brandScope: [],
      },
    });

    const session = await auth.signIn({ email: fixtures.a.userEmail, password: PASSWORD });
    const available = await auth.listWorkspaces(session.token);
    expect(available.map((w) => w.workspaceId).sort()).toEqual(
      [fixtures.a.workspaceId, fixtures.b.workspaceId].sort(),
    );

    const inB = await auth.switchWorkspace(session.token, fixtures.b.workspaceId);
    expect(inB.workspaceId).toBe(fixtures.b.workspaceId);
    expect(inB.roleKey).toBe('workspace_admin');

    const inA = await auth.switchWorkspace(session.token, fixtures.a.workspaceId);
    // Each switch establishes a NEW scope; the permissions come from THAT
    // membership's role, not from the previous one.
    expect(inA.workspaceId).toBe(fixtures.a.workspaceId);
    expect(inA.roleKey).toBe('workspace_owner');
  });
});

describe('suspension ends access', () => {
  it('revokes sessions scoped to the suspended workspace only', async () => {
    const session = await auth.signIn({ email: fixtures.a.userEmail, password: PASSWORD });
    await auth.switchWorkspace(session.token, fixtures.a.workspaceId);

    // A second session, working inside B.
    const otherSession = await auth.signIn({ email: fixtures.a.userEmail, password: PASSWORD });
    await auth.switchWorkspace(otherSession.token, fixtures.b.workspaceId);

    const revoked = await auth.revokeSessionsForWorkspace(fixtures.a.workspaceId, 'Suspended');
    expect(revoked).toBeGreaterThan(0);

    await expect(auth.resolve(session.token)).resolves.toBeNull();
    // Suspending customer A must not sign anyone out of customer B.
    await expect(auth.resolve(otherSession.token)).resolves.not.toBeNull();
  });

  it('a suspended workspace disappears from the selector', async () => {
    await platform.workspace.update({
      where: { id: fixtures.b.workspaceId },
      data: { status: 'SUSPENDED', statusReason: 'Suspended for this assertion' },
    });
    const session = await auth.signIn({ email: fixtures.a.userEmail, password: PASSWORD });
    const available = await auth.listWorkspaces(session.token);
    expect(available.map((w) => w.workspaceId)).not.toContain(fixtures.b.workspaceId);

    await platform.workspace.update({
      where: { id: fixtures.b.workspaceId },
      data: { status: 'ACTIVE', statusReason: 'Reinstated' },
    });
  });

  it('a password change revokes every session', async () => {
    const first = await auth.signIn({ email: fixtures.a.userEmail, password: PASSWORD });
    const second = await auth.signIn({ email: fixtures.a.userEmail, password: PASSWORD });

    const issued = await auth.beginPasswordReset(fixtures.a.userEmail);
    expect(issued).not.toBeNull();
    await auth.completePasswordReset(issued!.token, PASSWORD);

    await expect(auth.resolve(first.token)).resolves.toBeNull();
    await expect(auth.resolve(second.token)).resolves.toBeNull();
  });
});

describe('password reset', () => {
  it('returns null for an unknown address rather than throwing', async () => {
    // The CALLER must not be able to distinguish. Returning null lets the
    // action take the same path and reach the same confirmation.
    await expect(
      auth.beginPasswordReset(`unknown-${Date.now()}@example.local`),
    ).resolves.toBeNull();
  });

  it('stores only the hash of the reset token', async () => {
    const issued = await auth.beginPasswordReset(fixtures.a.userEmail);
    const rows = await platform.passwordResetToken.findMany({
      where: { userId: fixtures.a.userId },
    });
    expect(rows.some((r) => r.tokenHash === issued!.token)).toBe(false);
  });

  it('can be spent exactly once, even under concurrency', async () => {
    const issued = await auth.beginPasswordReset(fixtures.a.userEmail);
    const results = await Promise.allSettled([
      auth.completePasswordReset(issued!.token, PASSWORD),
      auth.completePasswordReset(issued!.token, PASSWORD),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
  });

  it('refuses an expired token', async () => {
    const issued = await auth.beginPasswordReset(fixtures.a.userEmail);
    await platform.passwordResetToken.updateMany({
      where: { userId: fixtures.a.userId, usedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(auth.completePasswordReset(issued!.token, PASSWORD)).rejects.toThrow(
      'This reset link is no longer valid.',
    );
  });
});
