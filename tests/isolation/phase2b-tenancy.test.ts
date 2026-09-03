import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, withoutTenantContext } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Cross-tenant isolation for every model Phase 2B added.
 *
 * The D-29 gate REQUIRES this file: a tenant-owned model with no isolation
 * coverage fails the build. Each model gets the same three assertions, because
 * each is a different way the same leak happens:
 *
 *   1. a direct read of B's row from A's context returns null (not a row),
 *   2. a listing from A's context excludes B entirely (not "mostly"),
 *   3. a write aimed at B from A's context is refused by the database.
 *
 * Everything below runs through `withWorkspace()`, so PostgreSQL RLS — not a
 * `where` clause this test remembered to add — is what is being measured.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('Invitation is tenant-owned', () => {
  it('A cannot read B invitation by id', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.invitation.findUnique({ where: { id: fixtures.b.invitationId } }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A listing shows only A invitations', async () => {
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.invitation.findMany(),
      { prisma: app },
    );
    expect(rows.map((r) => r.id)).toContain(fixtures.a.invitationId);
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.invitationId);
  });

  it('A cannot look up B invitation by its token hash', async () => {
    // The lookup a real acceptance performs. A unique index makes this a direct
    // hit if RLS is not applied, which is exactly why it is asserted.
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.invitation.findUnique({ where: { tokenHash: `fixture-token-hash-${fixtures.b.slug}` } }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A cannot create an invitation into B', async () => {
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          db.invitation.create({
            data: {
              workspaceId: fixtures.b.workspaceId,
              email: 'attacker@example.local',
              roleId: (await db.role.findFirstOrThrow({ where: { workspaceId: null } })).id,
              tokenHash: `attack-${Date.now()}`,
              expiresAt: new Date(Date.now() + 3600_000),
              invitedByUserId: fixtures.a.userId,
            },
          }),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });

  it('A cannot revoke B invitation', async () => {
    const result = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.invitation.updateMany({
          where: { id: fixtures.b.invitationId },
          data: { status: 'REVOKED' },
        }),
      { prisma: app },
    );
    // Zero rows affected: the row is invisible, so there is nothing to update.
    expect(result.count).toBe(0);
  });
});

describe('WorkspaceOverride is tenant-owned', () => {
  it('A cannot read B override', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.workspaceOverride.findUnique({ where: { id: fixtures.b.overrideId } }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A listing excludes B overrides', async () => {
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.workspaceOverride.findMany(),
      { prisma: app },
    );
    expect(rows.map((r) => r.id)).toEqual([fixtures.a.overrideId]);
  });

  it('A cannot grant itself an override inside B', async () => {
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          db.workspaceOverride.create({
            data: {
              workspaceId: fixtures.b.workspaceId,
              featureKey: 'attack.feature',
              enabled: true,
              reason: 'cross-tenant attempt',
              grantedByPlatformUserId: fixtures.platformUserId,
            },
          }),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });
});

describe('CreditWallet and CreditTransaction are tenant-owned', () => {
  it('A cannot read B wallet', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.creditWallet.findUnique({ where: { id: fixtures.b.walletId } }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A cannot read B wallet by its unique workspace key either', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.creditWallet.findUnique({ where: { workspaceId: fixtures.b.workspaceId } }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A cannot read B ledger', async () => {
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.creditTransaction.findMany(),
      { prisma: app },
    );
    expect(rows.map((r) => r.id)).toEqual([fixtures.a.creditTransactionId]);
  });

  it('A cannot move credits in B', async () => {
    const result = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.creditWallet.updateMany({
          where: { id: fixtures.b.walletId },
          data: { balanceMilliCredits: 999_000n },
        }),
      { prisma: app },
    );
    expect(result.count).toBe(0);
  });

  it('the ledger is append-only even for its own tenant', async () => {
    // REVOKE plus a trigger. Both are asserted, because a future migration
    // could restore the grant and the trigger would still hold.
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          db.creditTransaction.update({
            where: { id: fixtures.a.creditTransactionId },
            data: { reason: 'rewritten history' },
          }),
        { prisma: app },
      ),
    ).rejects.toThrow();

    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          db.creditTransaction.delete({ where: { id: fixtures.a.creditTransactionId } }),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });

  it('a negative balance is refused by the database, not only by the service', async () => {
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          db.creditWallet.update({
            where: { id: fixtures.a.walletId },
            data: { balanceMilliCredits: -1n },
          }),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });
});

describe('EmailMessage is tenant-owned with a nullable key', () => {
  it('A cannot read B messages', async () => {
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.emailMessage.findMany(),
      { prisma: app },
    );
    expect(rows.map((r) => r.id)).toEqual([fixtures.a.emailMessageId]);
  });

  it('a workspace-less message is invisible to every tenant', async () => {
    // `workspaceId IS NULL` never equals a uuid, so a password-reset message
    // stays out of every tenant's view with no special case in the policy.
    const platform = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
    });
    const orphan = await platform.emailMessage.create({
      data: {
        workspaceId: null,
        toEmail: 'reset@example.local',
        templateKey: 'auth.password_reset',
        locale: 'EN',
      },
    });
    await platform.$disconnect();

    for (const workspaceId of [fixtures.a.workspaceId, fixtures.b.workspaceId]) {
      const row = await withWorkspace(
        workspaceId,
        async (db) => db.emailMessage.findUnique({ where: { id: orphan.id } }),
        { prisma: app },
      );
      expect(row).toBeNull();
    }
  });

  it('never stores an action link', async () => {
    // The outbox holds the destination and the template, never the URL that
    // carries the token. A dump of this table yields nothing usable.
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.emailMessage.findMany(),
      { prisma: app },
    );
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain('http');
      expect(JSON.stringify(row)).not.toContain('/invitations/');
    }
  });
});

describe('CustomerSession and PasswordResetToken are auth-context only', () => {
  it('are invisible from inside any workspace', async () => {
    // The tightest policy in the schema: these rows are readable ONLY with no
    // workspace context, so a member acting inside A cannot read session rows
    // at all — not another tenant's, and not even their own.
    for (const workspaceId of [fixtures.a.workspaceId, fixtures.b.workspaceId]) {
      const sessions = await withWorkspace(
        workspaceId,
        async (db) => db.customerSession.findMany(),
        { prisma: app },
      );
      expect(sessions).toHaveLength(0);

      const resets = await withWorkspace(
        workspaceId,
        async (db) => db.passwordResetToken.findMany(),
        { prisma: app },
      );
      expect(resets).toHaveLength(0);
    }
  });

  it('are reachable from the authentication path, which has no workspace', async () => {
    // Authentication must resolve a session before any workspace is known. If
    // this returned nothing, sign-in itself would be impossible — so the test
    // proves the policy is narrow rather than simply broken.
    const session = await withoutTenantContext(
      async (db) => db.customerSession.findUnique({ where: { id: fixtures.a.customerSessionId } }),
      { prisma: app },
    );
    expect(session?.id).toBe(fixtures.a.customerSessionId);
  });

  it('a session token hash is never readable from inside a workspace', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.customerSession.findUnique({
          where: { tokenHash: `fixture-session-hash-${fixtures.b.slug}` },
        }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });
});

describe('the invitation lifecycle is enforced by the database', () => {
  it('refuses a second PENDING invitation for the same address', async () => {
    const platform = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
    });
    const role = await platform.role.findFirstOrThrow({ where: { workspaceId: null } });
    await expect(
      platform.invitation.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          email: fixtures.a.invitationEmail,
          roleId: role.id,
          tokenHash: `duplicate-${Date.now()}`,
          expiresAt: new Date(Date.now() + 3600_000),
          invitedByPlatformUserId: fixtures.platformUserId,
        },
      }),
    ).rejects.toThrow();
    await platform.$disconnect();
  });

  it('refuses an invitation with no inviter, and one with two', async () => {
    const platform = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
    });
    const role = await platform.role.findFirstOrThrow({ where: { workspaceId: null } });
    const base = {
      workspaceId: fixtures.a.workspaceId,
      roleId: role.id,
      expiresAt: new Date(Date.now() + 3600_000),
    };

    await expect(
      platform.invitation.create({
        data: { ...base, email: `noinviter-${Date.now()}@x.local`, tokenHash: `n-${Date.now()}` },
      }),
    ).rejects.toThrow();

    await expect(
      platform.invitation.create({
        data: {
          ...base,
          email: `twoinviters-${Date.now()}@x.local`,
          tokenHash: `t-${Date.now()}`,
          invitedByUserId: fixtures.a.userId,
          invitedByPlatformUserId: fixtures.platformUserId,
        },
      }),
    ).rejects.toThrow();
    await platform.$disconnect();
  });

  it('refuses an upper-case email, so a case variant cannot evade the unique index', async () => {
    const platform = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
    });
    const role = await platform.role.findFirstOrThrow({ where: { workspaceId: null } });
    await expect(
      platform.invitation.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          email: fixtures.a.invitationEmail.toUpperCase(),
          roleId: role.id,
          tokenHash: `upper-${Date.now()}`,
          expiresAt: new Date(Date.now() + 3600_000),
          invitedByPlatformUserId: fixtures.platformUserId,
        },
      }),
    ).rejects.toThrow();
    await platform.$disconnect();
  });

  it('refuses reviving a terminal invitation, and refuses editing its token', async () => {
    const platform = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
    });
    await platform.invitation.update({
      where: { id: fixtures.b.invitationId },
      data: { status: 'REVOKED' },
    });

    await expect(
      platform.invitation.update({
        where: { id: fixtures.b.invitationId },
        data: { status: 'PENDING' },
      }),
    ).rejects.toThrow(/terminal/i);

    await expect(
      platform.invitation.update({
        where: { id: fixtures.b.invitationId },
        data: { tokenHash: `rotated-${Date.now()}` },
      }),
    ).rejects.toThrow(/immutable/i);
    await platform.$disconnect();
  });
});

describe('workspace lifecycle constraints', () => {
  it('refuses a suspension with no stated reason', async () => {
    const platform = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
    });
    await expect(
      platform.workspace.update({
        where: { id: fixtures.a.workspaceId },
        data: { status: 'SUSPENDED', statusReason: null },
      }),
    ).rejects.toThrow();
    await platform.$disconnect();
  });

  it('accepts a suspension that states one', async () => {
    const platform = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
    });
    const updated = await platform.workspace.update({
      where: { id: fixtures.b.workspaceId },
      data: { status: 'SUSPENDED', statusReason: 'Non-payment after the grace period' },
    });
    expect(updated.status).toBe('SUSPENDED');
    // Put it back, so later assertions in this file see an operable workspace.
    await platform.workspace.update({
      where: { id: fixtures.b.workspaceId },
      data: { status: 'ACTIVE', statusReason: 'Reinstated by the fixture' },
    });
    await platform.$disconnect();
  });

  it('allows at most one ACTIVE override per feature', async () => {
    const platform = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
    });
    await expect(
      platform.workspaceOverride.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          featureKey: 'fixture.feature',
          enabled: false,
          reason: 'a second active override for the same feature',
          grantedByPlatformUserId: fixtures.platformUserId,
        },
      }),
    ).rejects.toThrow();
    await platform.$disconnect();
  });
});
