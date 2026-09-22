import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_CEILINGS,
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
  /*
   * CEILINGS WELL ABOVE WHAT THIS SUITE DOES — Phase 4 (F-19, D-250).
   *
   * The abuse ceilings are real, and this file signs the SAME fixture account in
   * over thirty times across its cases; under the schema defaults it now trips
   * the per-account ceiling partway through, which is the limiter working. What
   * this suite is about is realm separation, enumeration resistance, lockout and
   * password-reset atomicity — the ceilings have their own suite
   * (`phase4-auth-abuse`), and a number here that interfered with these cases
   * would make them fail for a reason none of them is testing.
   */
  auth = new CustomerAuthService({
    prisma: app,
    ceilings: {
      ...BOOTSTRAP_CEILINGS,
      signInPerIp: 100_000,
      signInPerAccount: 100_000,
      passwordResetPerIp: 100_000,
      passwordResetPerAccount: 100_000,
      mfaPerIp: 100_000,
      mfaPerAccount: 100_000,
    },
  });

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
        timezone: 'UTC',
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
        timezone: 'UTC',
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
        timezone: 'UTC',
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

/*
 * A-1. A RESET IS NOT AN APPEAL AGAINST A SUSPENSION.
 *
 * `completePasswordReset` used to write `status: 'ACTIVE'` unconditionally, so
 * a suspended account — or a deleted one whose token was minted before the
 * deletion — could be resurrected from the user's own inbox. These are the
 * assertions that would have caught it.
 */
describe('a password reset never reactivates an account', () => {
  /** A throwaway user in a given state, with a live reset token. */
  async function userWithToken(status: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DELETED') {
    const email = `reset-${status.toLowerCase()}-${randomUUID()}@example.local`;
    const user = await platform.user.create({
      data: {
        timezone: 'UTC',
        email,
        name: `Reset ${status}`,
        status: 'ACTIVE',
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
      },
    });
    // Minted while the account is still usable, exactly as it would have been
    // in the window before an administrator acted.
    const issued = await auth.beginPasswordReset(email);
    expect(issued).not.toBeNull();

    if (status !== 'ACTIVE') {
      await platform.user.update({
        where: { id: user.id },
        data: {
          status,
          ...(status === 'DELETED' ? { deletedAt: new Date() } : {}),
        },
      });
    }
    return { id: user.id, email, token: issued!.token };
  }

  it('refuses a token belonging to a SUSPENDED account, and leaves it suspended', async () => {
    const target = await userWithToken('SUSPENDED');

    await expect(auth.completePasswordReset(target.token, PASSWORD)).rejects.toThrow(
      // The SAME message as an unknown or expired token: a distinct one would
      // tell whoever holds the link what happened to the account.
      'This reset link is no longer valid.',
    );

    const after = await platform.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.status).toBe('SUSPENDED');
  });

  it('refuses a token belonging to a DELETED account, and leaves it deleted', async () => {
    const target = await userWithToken('DELETED');

    await expect(auth.completePasswordReset(target.token, PASSWORD)).rejects.toThrow(
      'This reset link is no longer valid.',
    );

    const after = await platform.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.status).toBe('DELETED');
    expect(after.deletedAt).not.toBeNull();
  });

  it('does not spend the token when the account is refused', async () => {
    // The refusal rolls back the consumption. It matters because the reverse —
    // burning the token AND refusing — would leave a reinstated user unable to
    // use the link they were legitimately sent.
    const target = await userWithToken('SUSPENDED');
    await expect(auth.completePasswordReset(target.token, PASSWORD)).rejects.toThrow();

    const rows = await platform.passwordResetToken.findMany({ where: { userId: target.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usedAt).toBeNull();
  });

  it('mints no token for a suspended account in the first place', async () => {
    const email = `reset-nomint-${randomUUID()}@example.local`;
    await platform.user.create({
      data: { email, name: 'No mint', status: 'SUSPENDED', timezone: 'UTC' },
    });
    // Null, not a throw: the caller's response must be identical to the
    // unknown-address case or the endpoint becomes a status oracle.
    await expect(auth.beginPasswordReset(email)).resolves.toBeNull();
    expect(await platform.passwordResetToken.count({ where: { user: { email } } })).toBe(0);
  });

  it('advances PENDING to ACTIVE, because that is what a reset proves', async () => {
    // The rule is "never REACTIVATE", not "never change status". Completing a
    // reset is proof of address control, which is exactly what PENDING awaits.
    const target = await userWithToken('PENDING');
    await auth.completePasswordReset(target.token, PASSWORD);

    const after = await platform.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.emailVerifiedAt).not.toBeNull();
  });
});

/*
 * A-1, second half. THE WHOLE RESET COMMITS OR NONE OF IT DOES.
 */
describe('password reset is atomic', () => {
  it('does not consume the token when the new password is rejected', async () => {
    const issued = await auth.beginPasswordReset(fixtures.a.userEmail);
    expect(issued).not.toBeNull();

    // Under the twelve-character minimum. The web form checks this too, but
    // the service is the boundary: a caller that forgets must not cost the
    // user their only recovery link.
    await expect(auth.completePasswordReset(issued!.token, 'short')).rejects.toThrow();

    const row = await platform.passwordResetToken.findFirst({
      where: { userId: fixtures.a.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row?.usedAt, 'a rejected password must not spend the token').toBeNull();

    // And the link still works afterwards, which is the property that matters.
    await auth.completePasswordReset(issued!.token, PASSWORD);
    const spent = await platform.passwordResetToken.findFirst({
      where: { userId: fixtures.a.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(spent?.usedAt).not.toBeNull();
  });

  it('leaves the password unchanged when the reset is refused', async () => {
    const email = `reset-atomic-${randomUUID()}@example.local`;
    const user = await platform.user.create({
      data: {
        timezone: 'UTC',
        email,
        name: 'Atomic',
        status: 'ACTIVE',
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
      },
    });
    const issued = await auth.beginPasswordReset(email);
    const before = (await platform.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash;

    await platform.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
    await expect(auth.completePasswordReset(issued!.token, `${PASSWORD}-new`)).rejects.toThrow();

    const after = await platform.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).toBe(before);
  });

  it('revokes sessions in the same transaction as the password write', async () => {
    // Not "revocation happens" — the earlier test covers that. This asserts
    // the two are ONE unit: a session that outlives the password authorising
    // it is the window this exists to close.
    const session = await auth.signIn({ email: fixtures.a.userEmail, password: PASSWORD });
    await expect(auth.resolve(session.token)).resolves.not.toBeNull();

    const issued = await auth.beginPasswordReset(fixtures.a.userEmail);
    await auth.completePasswordReset(issued!.token, PASSWORD);

    await expect(auth.resolve(session.token)).resolves.toBeNull();
    const row = await platform.customerSession.findFirstOrThrow({
      where: { userId: fixtures.a.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.revokedReason).toBe('Password changed');
  });
});
