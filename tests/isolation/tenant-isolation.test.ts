import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withWorkspace, withoutTenantContext } from '@brandspace/database';
import { assertConnectionCannotBypassRls } from '@brandspace/database/testing';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Tenant isolation suite — the enforcement mechanism for CLAUDE.md §2.1 and
 * docs/SECURITY.md §2.
 *
 * Every test runs through the tenant-scoped client on the APPLICATION database
 * role, which has NOBYPASSRLS and owns nothing. The suite refuses to run on a
 * privileged connection, because that would make every assertion vacuous.
 */

let prisma: PrismaClient;
let fx: IsolationFixtures;

beforeAll(async () => {
  prisma = appRoleClient();
  await assertConnectionCannotBypassRls(prisma);
  fx = await createIsolationFixtures(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the test harness itself', () => {
  it('runs as a role that cannot bypass RLS', async () => {
    const rows = await prisma.$queryRaw<
      { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it('built two distinct tenants with comparable data', () => {
    expect(fx.a.workspaceId).not.toBe(fx.b.workspaceId);
    expect(fx.a.userId).not.toBe(fx.b.userId);
    expect(fx.a.auditEventId).not.toBe(fx.b.auditEventId);
  });
});

describe('direct read by id', () => {
  it("A cannot read B's workspace", async () => {
    const found = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.workspace.findUnique({ where: { id: fx.b.workspaceId } }),
      { prisma },
    );
    expect(found).toBeNull();
  });

  it("A cannot read B's membership", async () => {
    const found = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.membership.findUnique({ where: { id: fx.b.membershipId } }),
      { prisma },
    );
    expect(found).toBeNull();
  });

  it("A cannot read B's audit event", async () => {
    const found = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.auditEvent.findUnique({ where: { id: fx.b.auditEventId } }),
      { prisma },
    );
    expect(found).toBeNull();
  });

  it("A cannot read B's support-mode session", async () => {
    const found = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.supportModeSession.findUnique({ where: { id: fx.b.supportSessionId } }),
      { prisma },
    );
    expect(found).toBeNull();
  });

  it("A cannot read B's workspace-private custom role", async () => {
    const found = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.role.findUnique({ where: { id: fx.b.customRoleId } }),
      { prisma },
    );
    expect(found).toBeNull();
  });

  it('A CAN read its own rows (the suite is not passing vacuously)', async () => {
    const own = await withWorkspace(
      fx.a.workspaceId,
      async (db) => ({
        workspace: await db.workspace.findUnique({ where: { id: fx.a.workspaceId } }),
        membership: await db.membership.findUnique({ where: { id: fx.a.membershipId } }),
        audit: await db.auditEvent.findUnique({ where: { id: fx.a.auditEventId } }),
        role: await db.role.findUnique({ where: { id: fx.a.customRoleId } }),
        support: await db.supportModeSession.findUnique({ where: { id: fx.a.supportSessionId } }),
      }),
      { prisma },
    );
    expect(own.workspace?.slug).toBe(fx.a.slug);
    expect(own.membership).not.toBeNull();
    expect(own.audit).not.toBeNull();
    expect(own.role).not.toBeNull();
    expect(own.support).not.toBeNull();
  });
});

describe('list and enumerate', () => {
  it("A's workspace listing contains only A", async () => {
    const rows = await withWorkspace(fx.a.workspaceId, (db) => db.workspace.findMany(), { prisma });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(fx.a.workspaceId);
  });

  it("A's membership listing never contains B's rows, at any page size", async () => {
    for (const take of [1, 10, 1000]) {
      const rows = await withWorkspace(
        fx.a.workspaceId,
        (db) => db.membership.findMany({ take, orderBy: { createdAt: 'asc' } }),
        { prisma },
      );
      expect(rows.every((r) => r.workspaceId === fx.a.workspaceId)).toBe(true);
      expect(rows.some((r) => r.id === fx.b.membershipId)).toBe(false);
    }
  });

  it("A's audit listing never contains B's rows", async () => {
    const rows = await withWorkspace(fx.a.workspaceId, (db) => db.auditEvent.findMany(), {
      prisma,
    });
    expect(rows.every((r) => r.workspaceId === fx.a.workspaceId)).toBe(true);
  });

  it("A cannot enumerate B's users (AC-16.14)", async () => {
    const users = await withWorkspace(fx.a.workspaceId, (db) => db.user.findMany(), { prisma });
    const emails = users.map((u) => u.email);
    expect(emails).toContain(fx.a.userEmail);
    expect(emails).not.toContain(fx.b.userEmail);
  });

  it('a filter explicitly naming B returns nothing rather than B rows', async () => {
    const rows = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.membership.findMany({ where: { workspaceId: fx.b.workspaceId } }),
      { prisma },
    );
    expect(rows).toHaveLength(0);
  });
});

describe('search', () => {
  it("A's search by slug never surfaces B", async () => {
    const rows = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.workspace.findMany({ where: { slug: { contains: 'tenant-' } } }),
      { prisma },
    );
    expect(rows.every((r) => r.id === fx.a.workspaceId)).toBe(true);
  });

  it("A's user search by email fragment never surfaces B's user", async () => {
    const rows = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.user.findMany({ where: { email: { contains: '@example.local' } } }),
      { prisma },
    );
    expect(rows.map((u) => u.email)).not.toContain(fx.b.userEmail);
  });
});

describe('mutation', () => {
  it("A's update of B's workspace affects zero rows and leaves B unchanged", async () => {
    const before = await withWorkspace(
      fx.b.workspaceId,
      (db) => db.workspace.findUniqueOrThrow({ where: { id: fx.b.workspaceId } }),
      { prisma },
    );

    const result = await withWorkspace(
      fx.a.workspaceId,
      (db) =>
        db.workspace.updateMany({
          where: { id: fx.b.workspaceId },
          data: { name: 'HIJACKED' },
        }),
      { prisma },
    );
    expect(result.count).toBe(0);

    const after = await withWorkspace(
      fx.b.workspaceId,
      (db) => db.workspace.findUniqueOrThrow({ where: { id: fx.b.workspaceId } }),
      { prisma },
    );
    expect(after.name).toBe(before.name);
    expect(after.name).not.toBe('HIJACKED');
  });

  it("A's delete of B's membership affects zero rows and B's row survives", async () => {
    const result = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.membership.deleteMany({ where: { id: fx.b.membershipId } }),
      { prisma },
    );
    expect(result.count).toBe(0);

    const survivor = await withWorkspace(
      fx.b.workspaceId,
      (db) => db.membership.findUnique({ where: { id: fx.b.membershipId } }),
      { prisma },
    );
    expect(survivor).not.toBeNull();
  });

  it('A cannot INSERT a row belonging to B (WITH CHECK)', async () => {
    await expect(
      withWorkspace(
        fx.a.workspaceId,
        (db) =>
          db.auditEvent.create({
            data: {
              workspaceId: fx.b.workspaceId,
              actorType: 'SYSTEM',
              action: 'forged.cross_tenant_write',
            },
          }),
        { prisma },
      ),
    ).rejects.toThrow();

    // And nothing landed in B.
    const forged = await withWorkspace(
      fx.b.workspaceId,
      (db) => db.auditEvent.findMany({ where: { action: 'forged.cross_tenant_write' } }),
      { prisma },
    );
    expect(forged).toHaveLength(0);
  });

  it("A cannot re-parent its own row into B's workspace", async () => {
    await expect(
      withWorkspace(
        fx.a.workspaceId,
        (db) =>
          db.membership.update({
            where: { id: fx.a.membershipId },
            data: { workspaceId: fx.b.workspaceId },
          }),
        { prisma },
      ),
    ).rejects.toThrow();
  });
});

describe('aggregates and counts', () => {
  it("A's counts exclude B entirely", async () => {
    const counts = await withWorkspace(
      fx.a.workspaceId,
      async (db) => ({
        workspaces: await db.workspace.count(),
        memberships: await db.membership.count(),
        audits: await db.auditEvent.count(),
      }),
      { prisma },
    );
    expect(counts.workspaces).toBe(1);
    expect(counts.memberships).toBe(1);
    // A's own fixture event only — not B's, and not the platform-only event.
    expect(counts.audits).toBe(1);
  });

  it('groupBy does not leak B through aggregation', async () => {
    const grouped = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.auditEvent.groupBy({ by: ['workspaceId'], _count: true }),
      { prisma },
    );
    expect(grouped.every((g) => g.workspaceId === fx.a.workspaceId)).toBe(true);
  });
});

describe('nullable tenant keys behave as designed', () => {
  it('system roles (workspaceId = null) ARE readable by every workspace', async () => {
    const fromA = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.role.findMany({ where: { workspaceId: null } }),
      { prisma },
    );
    expect(fromA.length).toBeGreaterThan(0);
  });

  it('platform-only audit events (workspaceId = null) are NOT readable by a tenant', async () => {
    const found = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.auditEvent.findUnique({ where: { id: fx.platformAuditEventId } }),
      { prisma },
    );
    expect(found).toBeNull();
  });

  it('a tenant cannot create a system role (workspaceId = null)', async () => {
    await expect(
      withWorkspace(
        fx.a.workspaceId,
        (db) =>
          db.role.create({
            data: {
              workspaceId: null,
              key: `forged_system_role_${Date.now()}`,
              realm: 'WORKSPACE',
              nameEn: 'Forged',
              nameAr: 'مزور',
              isSystem: true,
            },
          }),
        { prisma },
      ),
    ).rejects.toThrow();
  });
});

describe('fail-closed defaults', () => {
  it('with no tenant context, tenant-owned tables return nothing', async () => {
    const counts = await withoutTenantContext(
      async (db) => ({
        workspaces: await db.workspace.count(),
        memberships: await db.membership.count(),
        audits: await db.auditEvent.count(),
        support: await db.supportModeSession.count(),
      }),
      { prisma },
    );
    expect(counts.workspaces).toBe(0);
    expect(counts.memberships).toBe(0);
    expect(counts.audits).toBe(0);
    expect(counts.support).toBe(0);
  });

  it('a malformed workspace id is rejected before it reaches the database', async () => {
    await expect(
      withWorkspace('not-a-uuid', async (db) => db.workspace.count(), { prisma }),
    ).rejects.toThrow(/Invalid workspace id/);
  });

  it('an empty workspace id is rejected', async () => {
    await expect(withWorkspace('', async (db) => db.workspace.count(), { prisma })).rejects.toThrow(
      /Invalid workspace id/,
    );
  });
});

describe('tenant context does not leak between transactions', () => {
  it('a later call with no context cannot see the previous tenant', async () => {
    await withWorkspace(fx.a.workspaceId, (db) => db.workspace.count(), { prisma });
    const leaked = await withoutTenantContext((db) => db.workspace.count(), { prisma });
    expect(leaked).toBe(0);
  });

  it('switching context switches visibility, in both directions', async () => {
    const seenByA = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.workspace.findMany({ select: { id: true } }),
      { prisma },
    );
    const seenByB = await withWorkspace(
      fx.b.workspaceId,
      (db) => db.workspace.findMany({ select: { id: true } }),
      { prisma },
    );
    expect(seenByA.map((r) => r.id)).toEqual([fx.a.workspaceId]);
    expect(seenByB.map((r) => r.id)).toEqual([fx.b.workspaceId]);
  });
});
