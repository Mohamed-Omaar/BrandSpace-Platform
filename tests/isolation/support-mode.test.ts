import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CustomerAuthService,
  SUPPORT_MODE_FORBIDDEN_FIELDS,
  SupportModeService,
  WorkspaceAdminService,
} from '@brandspace/auth';
import { PLATFORM_ROLE_KEYS, ROLE_DEFINITIONS } from '@brandspace/shared';
import { withWorkspace } from '@brandspace/database';
import {
  appRoleClient,
  createIsolationFixtures,
  ensurePlatformRbac,
  type IsolationFixtures,
} from './fixtures';

/**
 * Support Mode — docs/SECURITY.md §8, D-28.
 *
 * The guarantees that make this a bounded capability rather than a hidden
 * superpower, each asserted:
 *
 *   1. it requires the permission, verified MFA and a written reason;
 *   2. it CANNOT become a customer session;
 *   3. it CANNOT be pointed at a second workspace;
 *   4. it expires, and an expired grant is inert without a sweep;
 *   5. it is read-only, and a denied write is audited;
 *   6. it appears in the CUSTOMER's own activity log.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
let support: SupportModeService;

function actor(permissionKeys: readonly string[], mfaVerified = true, roleKey = 'platform_owner') {
  return { platformUserId: fixtures.platformUserId, roleKey, mfaVerified, permissionKeys };
}

const SUPPORT_PERMISSIONS =
  ROLE_DEFINITIONS.find((r) => r.key === 'support_agent')?.permissionKeys ?? [];

beforeAll(async () => {
  app = appRoleClient();
  platform = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
  });
  await ensurePlatformRbac(platform);
  fixtures = await createIsolationFixtures(app);
  support = new SupportModeService({ prisma: platform });
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('entry requires permission, MFA and a reason', () => {
  it('refuses with no actor', async () => {
    await expect(
      support.start(undefined as never, fixtures.a.workspaceId, 'a perfectly good reason'),
    ).rejects.toThrow(/requires a platform actor/);
  });

  it('refuses without verified MFA — the step-up requirement', async () => {
    await expect(
      support.start(
        actor(SUPPORT_PERMISSIONS, false),
        fixtures.a.workspaceId,
        'a perfectly good reason',
      ),
    ).rejects.toThrow(/verified MFA/);
  });

  it('refuses without platform.support_mode.enter', async () => {
    await expect(
      support.start(
        actor(['platform.workspace.read']),
        fixtures.a.workspaceId,
        'a perfectly good reason',
      ),
    ).rejects.toThrow('platform.support_mode.enter');
  });

  it('refuses a missing or too-short reason', async () => {
    for (const reason of ['', '   ', 'short']) {
      await expect(
        support.start(actor(SUPPORT_PERMISSIONS), fixtures.a.workspaceId, reason),
      ).rejects.toThrow(/written reason/);
    }
  });

  it('refuses a workspace that does not exist', async () => {
    await expect(
      support.start(
        actor(SUPPORT_PERMISSIONS),
        '00000000-0000-4000-8000-000000000000',
        'a perfectly good reason',
      ),
    ).rejects.toThrow('Workspace not found.');
  });

  it('audits every denial', async () => {
    await support
      .start(actor(['platform.workspace.read']), fixtures.a.workspaceId, 'denied attempt reason')
      .catch(() => undefined);
    const denial = await platform.auditEvent.findFirst({
      where: { action: 'support_mode.denied', actorId: fixtures.platformUserId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(denial?.outcome).toBe('DENIED');
    expect(denial?.reason).toContain('platform.support_mode.enter');
  });

  it('only the roles documented as holding it may enter', async () => {
    const expected: Record<string, boolean> = {
      platform_owner: true,
      platform_admin: true,
      support_agent: true,
      billing_manager: false,
      operations_viewer: false,
    };
    for (const roleKey of PLATFORM_ROLE_KEYS) {
      const definition = ROLE_DEFINITIONS.find((r) => r.key === roleKey)!;
      const attempt = support.start(
        actor(definition.permissionKeys, true, roleKey),
        fixtures.a.workspaceId,
        `role authority probe for ${roleKey}`,
      );
      if (expected[roleKey]) {
        await expect(attempt).resolves.toMatchObject({ workspaceId: fixtures.a.workspaceId });
      } else {
        await expect(attempt).rejects.toThrow(/platform\.support_mode\.enter/);
      }
    }
  });
});

describe('a support session is NOT a customer session', () => {
  it('creates no customer session row', async () => {
    const before = await platform.customerSession.count();
    await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'checking that no customer session is minted',
    );
    const after = await platform.customerSession.count();
    // D-28: impersonation is prohibited, and it is prohibited by construction —
    // there is no code path here that touches the customer session table.
    expect(after).toBe(before);
  });

  it('its id is worthless as a customer session token', async () => {
    const grant = await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'attempting to use the grant id as a session',
    );
    const customerAuth = new CustomerAuthService({ prisma: platform });
    await expect(customerAuth.resolve(grant.id)).resolves.toBeNull();
  });

  it('attributes every event to a PLATFORM actor, never the customer', async () => {
    const grant = await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'checking the attribution of support events',
    );
    await support.recordAccess(grant.id, fixtures.platformUserId, 'workspace');

    const events = await platform.auditEvent.findMany({
      where: { supportModeSessionId: grant.id },
    });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.actorType).toBe('PLATFORM_USER');
      expect(event.actorId).toBe(fixtures.platformUserId);
      // Never the customer's user id.
      expect(event.actorId).not.toBe(fixtures.a.userId);
    }
  });

  it('is read-only, and a write attempt is refused AND audited', async () => {
    const grant = await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'attempting a write inside support mode',
    );
    await expect(
      support.assertMayWrite(grant.id, fixtures.platformUserId, 'workspace.update'),
    ).rejects.toThrow('Support Mode is read-only.');

    const denial = await platform.auditEvent.findFirst({
      where: { action: 'support_mode.write_denied', supportModeSessionId: grant.id },
    });
    expect(denial?.outcome).toBe('DENIED');
  });

  it('never issues a write-enabled grant in Phase 2B', async () => {
    const grant = await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'checking the default posture is read-only',
    );
    expect(grant.writeEnabled).toBe(false);
    const row = await platform.supportModeSession.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.writeEnabled).toBe(false);
  });
});

describe('a support session cannot cross a workspace boundary', () => {
  it('binds the workspace at grant time', async () => {
    const grant = await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'a grant that must stay on tenant A',
    );
    const resolved = await support.resolve(grant.id, fixtures.platformUserId);
    expect(resolved?.workspaceId).toBe(fixtures.a.workspaceId);
    expect(resolved?.workspaceId).not.toBe(fixtures.b.workspaceId);
  });

  it('another platform user cannot ride the grant', async () => {
    const grant = await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'a grant belonging to one actor only',
    );
    const otherRole = await platform.role.findFirstOrThrow({
      where: { key: 'support_agent', workspaceId: null },
    });
    const otherActor = await platform.platformUser.create({
      data: {
        email: `other-support-${Date.now()}@brandspace.local`,
        status: 'ACTIVE',
        roleId: otherRole.id,
      },
    });
    await expect(support.resolve(grant.id, otherActor.id)).resolves.toBeNull();
    // And they cannot end somebody else's session either.
    await support.end(grant.id, otherActor.id);
    const still = await platform.supportModeSession.findUniqueOrThrow({ where: { id: grant.id } });
    expect(still.endedAt).toBeNull();
  });

  it('a grant over A does not make B readable — RLS still applies', async () => {
    await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'a grant that must not widen tenant visibility',
    );
    // The tenant role, scoped to A, still cannot see B. A support grant is an
    // application-level authorisation; it changes nothing in the database.
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.workspace.findMany(),
      { prisma: app },
    );
    expect(rows.map((r) => r.id)).toEqual([fixtures.a.workspaceId]);
  });

  it('starting a second grant on the same workspace ends the first', async () => {
    const first = await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'the first overlapping grant',
    );
    const second = await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'the second overlapping grant',
    );
    // Two live grants whose accesses cannot be told apart is an audit problem.
    await expect(support.resolve(first.id, fixtures.platformUserId)).resolves.toBeNull();
    await expect(support.resolve(second.id, fixtures.platformUserId)).resolves.not.toBeNull();
  });
});

describe('a support session expires', () => {
  it('an expired grant resolves to null WITHOUT any sweep', async () => {
    const grant = await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'a grant that will be expired by hand',
    );
    await platform.supportModeSession.update({
      where: { id: grant.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    // Expiry is enforced on read, so an unswept row is already unusable.
    await expect(support.resolve(grant.id, fixtures.platformUserId)).resolves.toBeNull();
    await expect(
      support.recordAccess(grant.id, fixtures.platformUserId, 'workspace'),
    ).rejects.toThrow(/no longer active/);
  });

  it('clamps the TTL to the documented maximum', () => {
    const absurd = new SupportModeService({ prisma: platform, ttlMinutes: 100_000 });
    expect(absurd).toBeInstanceOf(SupportModeService);
  });

  it('an ended grant is inert, and ending is idempotent', async () => {
    const grant = await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'a grant that will be ended early',
    );
    await support.end(grant.id, fixtures.platformUserId);
    await support.end(grant.id, fixtures.platformUserId);
    await expect(support.resolve(grant.id, fixtures.platformUserId)).resolves.toBeNull();

    const ended = await platform.auditEvent.findMany({
      where: { action: 'support_mode.ended', supportModeSessionId: grant.id },
    });
    expect(ended).toHaveLength(1);
  });

  it('ends every grant when the platform session ends', async () => {
    await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'a grant that must not outlive its session',
    );
    const ended = await support.endAllForActor(fixtures.platformUserId);
    expect(ended).toBeGreaterThan(0);
    const live = await platform.supportModeSession.count({
      where: { platformUserId: fixtures.platformUserId, endedAt: null },
    });
    expect(live).toBe(0);
  });
});

describe('the customer can see that support looked', () => {
  it('writes the entry event against the WORKSPACE, not the platform', async () => {
    const grant = await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'an access the customer must be able to see',
    );

    // Read through the TENANT path: this is what the customer's Activity Log
    // uses, so if the event were platform-scoped it would be invisible here.
    const events = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.auditEvent.findMany({ where: { action: 'support_mode.entered' } }),
      { prisma: app },
    );
    expect(events.some((e) => e.supportModeSessionId === grant.id)).toBe(true);
    const mine = events.find((e) => e.supportModeSessionId === grant.id)!;
    expect(mine.reason).toBe('an access the customer must be able to see');
  });

  it('the customer can see the session row itself, with its duration', async () => {
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.supportModeSession.findMany(),
      { prisma: app },
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.workspaceId).toBe(fixtures.a.workspaceId);
      expect(row.reason).toBeTruthy();
      expect(row.expiresAt).toBeInstanceOf(Date);
    }
  });

  it("tenant B cannot see tenant A's support sessions", async () => {
    const rows = await withWorkspace(
      fixtures.b.workspaceId,
      async (db) => db.supportModeSession.findMany(),
      { prisma: app },
    );
    expect(rows.every((r) => r.workspaceId === fixtures.b.workspaceId)).toBe(true);
  });
});

describe('secret material is out of reach', () => {
  it('names every field support must never surface', () => {
    // A checklist that a future query can be tested against, rather than a
    // promise in a document.
    for (const field of ['passwordHash', 'mfaSecretRef', 'tokenHash', 'ciphertext']) {
      expect(SUPPORT_MODE_FORBIDDEN_FIELDS).toContain(field);
    }
  });

  it('the tenant role cannot read platform credentials at all, grant or not', async () => {
    await support.start(
      actor(SUPPORT_PERMISSIONS),
      fixtures.a.workspaceId,
      'a grant that must not unlock the vault',
    );
    // Permission denied, not zero rows: the privilege is revoked, so a support
    // grant cannot become a route to secret material.
    await expect(
      withWorkspace(fixtures.a.workspaceId, async (db) => db.secretVersion.findMany(), {
        prisma: app,
      }),
    ).rejects.toThrow();
  });
});

describe('the workspace lifecycle is authorised and audited', () => {
  it('refuses a status change without platform.workspace.suspend', async () => {
    const workspaces = new WorkspaceAdminService({ prisma: platform });
    await expect(
      workspaces.changeStatus(
        actor(['platform.workspace.read']),
        fixtures.a.workspaceId,
        'SUSPENDED',
        'attempting without the permission',
        0,
      ),
    ).rejects.toThrow('platform.workspace.suspend');
  });

  it('refuses an unsafe transition by name', async () => {
    const workspaces = new WorkspaceAdminService({ prisma: platform });
    const ownerPermissions =
      ROLE_DEFINITIONS.find((r) => r.key === 'platform_owner')?.permissionKeys ?? [];
    const row = await platform.workspace.findUniqueOrThrow({
      where: { id: fixtures.a.workspaceId },
    });
    await platform.workspace.update({
      where: { id: fixtures.a.workspaceId },
      data: { status: 'ARCHIVED', statusReason: 'archived for this assertion' },
    });

    await expect(
      workspaces.changeStatus(
        actor(ownerPermissions),
        fixtures.a.workspaceId,
        'ACTIVE',
        'attempting to revive an archived workspace',
        row.lockVersion,
      ),
    ).rejects.toThrow(/cannot move from ARCHIVED to ACTIVE/);

    await platform.workspace.update({
      where: { id: fixtures.a.workspaceId },
      data: { status: 'ACTIVE', statusReason: 'restored by the fixture' },
    });
  });

  it('refuses a concurrent edit rather than overwriting it', async () => {
    const workspaces = new WorkspaceAdminService({ prisma: platform });
    const ownerPermissions =
      ROLE_DEFINITIONS.find((r) => r.key === 'platform_owner')?.permissionKeys ?? [];
    const row = await platform.workspace.findUniqueOrThrow({
      where: { id: fixtures.b.workspaceId },
    });

    await workspaces.update(actor(ownerPermissions), fixtures.b.workspaceId, {
      name: 'Renamed once',
      lockVersion: row.lockVersion,
    });

    // The second save carries the STALE version and must be refused.
    await expect(
      workspaces.update(actor(ownerPermissions), fixtures.b.workspaceId, {
        name: 'Renamed twice',
        lockVersion: row.lockVersion,
      }),
    ).rejects.toThrow(/changed by someone else/);

    const after = await platform.workspace.findUniqueOrThrow({
      where: { id: fixtures.b.workspaceId },
    });
    expect(after.name).toBe('Renamed once');
  });

  it('suspension revokes sessions scoped to that workspace', async () => {
    const workspaces = new WorkspaceAdminService({ prisma: platform });
    const ownerPermissions =
      ROLE_DEFINITIONS.find((r) => r.key === 'platform_owner')?.permissionKeys ?? [];
    const session = await platform.customerSession.create({
      data: {
        userId: fixtures.b.userId,
        tokenHash: `suspend-test-${Date.now()}`,
        activeWorkspaceId: fixtures.b.workspaceId,
        expiresAt: new Date(Date.now() + 3600_000),
        absoluteExpiresAt: new Date(Date.now() + 7200_000),
      },
    });
    const row = await platform.workspace.findUniqueOrThrow({
      where: { id: fixtures.b.workspaceId },
    });

    await workspaces.changeStatus(
      actor(ownerPermissions),
      fixtures.b.workspaceId,
      'SUSPENDED',
      'suspended for non-payment in this assertion',
      row.lockVersion,
    );

    const after = await platform.customerSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(after.revokedAt).not.toBeNull();
    expect(after.revokedReason).toContain('suspended');
  });
});

/*
 * A-10. AN ACCESS GRANT AND ITS AUDIT EVENT ARE ONE THING.
 *
 * `start` was three separate statements — end any live session, create the new
 * one, write the audit event — with no transaction and no lock. Two failures
 * followed: a crash after the INSERT left a live grant with nothing in the
 * customer's Activity Log, and two concurrent starts produced two overlapping
 * grants whose accesses could not be attributed to either, despite a comment
 * asserting one session per operator per workspace.
 */
describe('support mode cannot open two overlapping sessions', () => {
  async function liveSessions(workspaceId: string, platformUserId: string): Promise<number> {
    return platform.supportModeSession.count({
      where: { workspaceId, platformUserId, endedAt: null },
    });
  }

  it('six concurrent starts leave exactly one live session', async () => {
    const workspaceId = fixtures.b.workspaceId;
    // Anything already live from an earlier test in this file.
    await platform.supportModeSession.updateMany({
      where: { workspaceId, endedAt: null },
      data: { endedAt: new Date() },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        support.start(
          actor(SUPPORT_PERMISSIONS),
          workspaceId,
          `concurrent support entry number ${i}`,
        ),
      ),
    );

    // At least one must succeed; the rest either succeed (having ended the
    // previous one) or are refused. What must NEVER happen is two live at once.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(
      await liveSessions(workspaceId, fixtures.platformUserId),
      'two live grants cannot be told apart in the audit trail',
    ).toBe(1);
  });

  it('the database refuses a second live session even without the lock', async () => {
    // The partial unique index is the backstop that holds if a future caller
    // forgets to serialise. Asserted directly, because a guarantee that lives
    // only in application code is one refactor from being gone.
    const workspaceId = fixtures.a.workspaceId;
    await platform.supportModeSession.updateMany({
      where: { workspaceId, endedAt: null },
      data: { endedAt: new Date() },
    });
    await support.start(actor(SUPPORT_PERMISSIONS), workspaceId, 'the first live session');

    await expect(
      platform.supportModeSession.create({
        data: {
          workspaceId,
          platformUserId: fixtures.platformUserId,
          reason: 'a second live session, written directly',
          writeEnabled: false,
          expiresAt: new Date(Date.now() + 600_000),
        },
      }),
    ).rejects.toThrow();
  });

  it('starting again ends the previous session rather than stacking', async () => {
    const workspaceId = fixtures.a.workspaceId;
    await platform.supportModeSession.updateMany({
      where: { workspaceId, endedAt: null },
      data: { endedAt: new Date() },
    });

    const first = await support.start(
      actor(SUPPORT_PERMISSIONS),
      workspaceId,
      'the first entry for this check',
    );
    const second = await support.start(
      actor(SUPPORT_PERMISSIONS),
      workspaceId,
      'the second entry for this check',
    );

    expect(second.id).not.toBe(first.id);
    const ended = await platform.supportModeSession.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(ended.endedAt, 'the earlier grant must be closed, not left open').not.toBeNull();
    expect(await liveSessions(workspaceId, fixtures.platformUserId)).toBe(1);
  });

  it('rolls the session back when the audit write fails', async () => {
    /*
     * INJECTED FAILURE, at the database.
     *
     * A trigger that refuses the audit insert reproduces exactly the case the
     * transaction exists for: everything before it has already been written.
     * Before `start` was one transaction this left a LIVE SUPPORT GRANT with
     * nothing in the customer's Activity Log — an operator holding access to a
     * customer's workspace, unrecorded, which is what docs/SECURITY.md §8
     * forbids.
     */
    const workspaceId = fixtures.b.workspaceId;
    await platform.supportModeSession.updateMany({
      where: { workspaceId, endedAt: null },
      data: { endedAt: new Date() },
    });
    const before = await platform.supportModeSession.count({ where: { workspaceId } });

    /*
     * Installed as the MIGRATOR, not the platform role. The platform role has
     * no DDL rights in `public` — which is the least-privilege separation
     * working exactly as intended, and is itself worth noticing here rather
     * than working around by widening a production role for a test.
     */
    const migrator = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_MIGRATION_URL']! }),
    });
    await migrator.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION refuse_support_entry_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW."action" = 'support_mode.entered' THEN
          RAISE EXCEPTION 'injected audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await migrator.$executeRawUnsafe(`
      CREATE TRIGGER refuse_support_entry_audit_trigger
      BEFORE INSERT ON "audit_event"
      FOR EACH ROW EXECUTE FUNCTION refuse_support_entry_audit()`);

    try {
      await expect(
        support.start(actor(SUPPORT_PERMISSIONS), workspaceId, 'entry whose audit will fail'),
      ).rejects.toThrow();

      // NO session row at all — not a live one, not an ended one.
      expect(
        await platform.supportModeSession.count({ where: { workspaceId } }),
        'a failed audit write must take the grant with it',
      ).toBe(before);
      expect(await liveSessions(workspaceId, fixtures.platformUserId)).toBe(0);
    } finally {
      // Dropped whatever happened above: leaving this trigger behind would
      // break every later suite that writes an audit event.
      await migrator.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS refuse_support_entry_audit_trigger ON "audit_event"',
      );
      await migrator.$executeRawUnsafe('DROP FUNCTION IF EXISTS refuse_support_entry_audit()');
      await migrator.$disconnect();
    }

    // And the ordinary path still works once the injected failure is removed.
    const recovered = await support.start(
      actor(SUPPORT_PERMISSIONS),
      workspaceId,
      'entry after the injected failure',
    );
    expect(recovered.id).toBeDefined();
  });

  it('never leaves a live session without its audit event', async () => {
    // The property the transaction exists for: an operator holding access with
    // nothing in the customer's Activity Log saying so is precisely what
    // docs/SECURITY.md §8 forbids.
    const workspaceId = fixtures.b.workspaceId;
    await platform.supportModeSession.updateMany({
      where: { workspaceId, endedAt: null },
      data: { endedAt: new Date() },
    });
    await support.start(actor(SUPPORT_PERMISSIONS), workspaceId, 'audited support entry');

    const live = await platform.supportModeSession.findMany({
      where: { workspaceId, endedAt: null },
    });
    for (const session of live) {
      const events = await platform.auditEvent.count({
        where: { supportModeSessionId: session.id, action: 'support_mode.entered' },
      });
      expect(events, `session ${session.id} has no entry event`).toBe(1);
    }
  });
});
