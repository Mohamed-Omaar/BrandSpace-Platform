import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * F-01 — the two-pool database security model.
 *
 * Phase 1 granted cross-tenant access through `app.is_platform_mode()`, a
 * PostgreSQL session variable the application role could set itself. It was a
 * control against developer error, not against an attacker with arbitrary SQL.
 *
 * That is replaced by a separate database identity. Cross-tenant visibility is
 * now decided by WHICH ROLE CONNECTED — i.e. by which credential was used — and
 * RLS policies name the roles explicitly:
 *
 *   tenant_isolation  TO brandspace_app       workspace predicate only
 *   platform_access   TO brandspace_platform  full access
 *
 * These tests connect with raw `pg` as each role and prove the boundary at the
 * database, with no application code in the path.
 */

let prisma: PrismaClient;
let fx: IsolationFixtures;
let tenantSql: Client;
let platformSql: Client;

beforeAll(async () => {
  prisma = appRoleClient();
  fx = await createIsolationFixtures(prisma);

  tenantSql = new Client({ connectionString: process.env['DATABASE_URL'] });
  await tenantSql.connect();

  platformSql = new Client({ connectionString: process.env['DATABASE_PLATFORM_URL'] });
  await platformSql.connect();
});

afterAll(async () => {
  await tenantSql.end();
  await platformSql.end();
  await prisma.$disconnect();
});

async function inTenant<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
  await tenantSql.query('BEGIN');
  try {
    await tenantSql.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await run();
    await tenantSql.query('COMMIT');
    return result;
  } catch (e: unknown) {
    await tenantSql.query('ROLLBACK');
    throw e;
  }
}

describe('the two roles are genuinely distinct identities', () => {
  it('the tenant connection is brandspace_app', async () => {
    const r = await tenantSql.query<{ u: string }>('SELECT current_user AS u');
    expect(r.rows[0]?.u).toBe('brandspace_app');
  });

  it('the platform connection is brandspace_platform', async () => {
    const r = await platformSql.query<{ u: string }>('SELECT current_user AS u');
    expect(r.rows[0]?.u).toBe('brandspace_platform');
  });

  it('NEITHER role can bypass RLS or is a superuser', async () => {
    for (const [label, client] of [
      ['tenant', tenantSql],
      ['platform', platformSql],
    ] as const) {
      const r = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      expect(r.rows[0]?.rolsuper, `${label} must not be superuser`).toBe(false);
      // The platform role's access is a POLICY, evaluated normally, not a
      // privilege that skips evaluation. WITH CHECK still applies to it.
      expect(r.rows[0]?.rolbypassrls, `${label} must not have BYPASSRLS`).toBe(false);
    }
  });

  it('neither role owns the tenant tables', async () => {
    const r = await tenantSql.query<{ tableowner: string }>(
      `SELECT tableowner FROM pg_tables WHERE schemaname='public'
        AND tablename IN ('workspace','membership','audit_event')`,
    );
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.tableowner).not.toBe('brandspace_app');
      expect(row.tableowner).not.toBe('brandspace_platform');
    }
  });
});

describe('the tenant role cannot cross the boundary', () => {
  it('cannot read another workspace', async () => {
    const count = await inTenant(fx.a.workspaceId, async () => {
      const r = await tenantSql.query<{ c: string }>(
        'SELECT count(*)::text AS c FROM "workspace" WHERE id = $1',
        [fx.b.workspaceId],
      );
      return Number(r.rows[0]?.c);
    });
    expect(count).toBe(0);
  });

  it('cannot write to another workspace', async () => {
    const affected = await inTenant(fx.a.workspaceId, async () => {
      const r = await tenantSql.query('UPDATE "workspace" SET name = $1 WHERE id = $2', [
        'CROSS_TENANT_WRITE',
        fx.b.workspaceId,
      ]);
      return r.rowCount ?? 0;
    });
    expect(affected).toBe(0);

    const intact = await platformSql.query<{ name: string }>(
      'SELECT name FROM "workspace" WHERE id = $1',
      [fx.b.workspaceId],
    );
    expect(intact.rows[0]?.name).not.toBe('CROSS_TENANT_WRITE');
  });

  it('cannot INSERT into another workspace (WITH CHECK)', async () => {
    await expect(
      inTenant(fx.a.workspaceId, () =>
        tenantSql.query(
          `INSERT INTO "audit_event" (id, "workspaceId", "actorType", action)
           VALUES (gen_random_uuid(), $1, 'SYSTEM', 'cross.tenant.forged')`,
          [fx.b.workspaceId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('sees NOTHING with a NULL workspace context (fail-closed)', async () => {
    await tenantSql.query('BEGIN');
    await tenantSql.query("SELECT set_config('app.workspace_id', '', true)");
    for (const table of ['workspace', 'membership', 'audit_event', 'support_mode_session']) {
      const r = await tenantSql.query<{ c: string }>(`SELECT count(*)::text AS c FROM "${table}"`);
      expect(Number(r.rows[0]?.c), `${table} must be empty with no context`).toBe(0);
    }
    await tenantSql.query('COMMIT');
  });
});

describe('the tenant role cannot FORGE platform access', () => {
  it('setting the old platform GUC changes nothing', async () => {
    // This is the exact attack the previous design was vulnerable to.
    const count = await inTenant(fx.a.workspaceId, async () => {
      await tenantSql.query("SELECT set_config('app.platform_mode', 'on', true)");
      const r = await tenantSql.query<{ c: string }>('SELECT count(*)::text AS c FROM "workspace"');
      return Number(r.rows[0]?.c);
    });
    // Still only its own workspace, never both.
    expect(count).toBe(1);
  });

  it('the platform-mode function no longer exists at all', async () => {
    const r = await tenantSql.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname = 'is_platform_mode'`,
    );
    expect(Number(r.rows[0]?.c)).toBe(0);
  });

  it('calling the dropped function raises an error', async () => {
    await expect(tenantSql.query('SELECT app.is_platform_mode()')).rejects.toThrow(
      /does not exist/i,
    );
  });

  it('cannot SET ROLE into the platform identity', async () => {
    await expect(tenantSql.query('SET ROLE brandspace_platform')).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('is not a member of the platform role', async () => {
    const r = await tenantSql.query<{ member: boolean }>(
      "SELECT pg_has_role(current_user, 'brandspace_platform', 'MEMBER') AS member",
    );
    expect(r.rows[0]?.member).toBe(false);
  });

  it('is named by no platform policy', async () => {
    const r = await tenantSql.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM pg_policies
        WHERE schemaname='public' AND policyname='platform_access'
          AND roles::text LIKE '%brandspace_app%'`,
    );
    expect(Number(r.rows[0]?.c)).toBe(0);
  });

  it('cannot grant itself membership in the platform role', async () => {
    await expect(tenantSql.query('GRANT brandspace_platform TO brandspace_app')).rejects.toThrow();
  });

  it('cannot create a policy naming itself', async () => {
    await expect(
      tenantSql.query(`CREATE POLICY escalate ON "workspace" TO brandspace_app USING (true)`),
    ).rejects.toThrow();
  });

  it('cannot ALTER its own role attributes', async () => {
    await expect(tenantSql.query('ALTER ROLE brandspace_app BYPASSRLS')).rejects.toThrow();
  });
});

describe('the platform role has the access the tenant role does not', () => {
  it('sees BOTH workspaces', async () => {
    const r = await platformSql.query<{ id: string }>('SELECT id FROM "workspace"');
    const ids = r.rows.map((x) => x.id);
    expect(ids).toContain(fx.a.workspaceId);
    expect(ids).toContain(fx.b.workspaceId);
  });

  it('sees platform-only audit events that no tenant can', async () => {
    const r = await platformSql.query<{ c: string }>(
      'SELECT count(*)::text AS c FROM "audit_event" WHERE id = $1',
      [fx.platformAuditEventId],
    );
    expect(Number(r.rows[0]?.c)).toBe(1);
  });

  it('still cannot rewrite the audit trail', async () => {
    await expect(
      platformSql.query('UPDATE "audit_event" SET action = $1 WHERE id = $2', [
        'tampered',
        fx.a.auditEventId,
      ]),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      platformSql.query('DELETE FROM "audit_event" WHERE id = $1', [fx.a.auditEventId]),
    ).rejects.toThrow(/permission denied/i);
  });

  it('holds only SELECT and INSERT on audit_event', async () => {
    const r = await platformSql.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE grantee = 'brandspace_platform' AND table_name = 'audit_event'
        ORDER BY privilege_type`,
    );
    expect(r.rows.map((x) => x.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
  });
});

describe('policy shape is what the design claims', () => {
  it('every protected table has exactly one tenant policy and one platform policy', async () => {
    // pg_policies.roles is a PostgreSQL name[]; node-pg hands it back as the raw
    // array literal "{a,b}", so it is unwrapped rather than compared as-is.
    const r = await platformSql.query<{ tablename: string; policyname: string; roles: string }>(
      `SELECT tablename, policyname, roles::text AS roles
         FROM pg_policies WHERE schemaname='public'`,
    );
    const rolesOf = (raw: string | undefined): string[] =>
      (raw ?? '')
        .replace(/^\{|\}$/g, '')
        .split(',')
        .filter((x) => x !== '');
    const tables = [
      'workspace',
      'membership',
      'role',
      'audit_event',
      'support_mode_session',
      'user',
    ];
    for (const table of tables) {
      const forTable = r.rows.filter((x) => x.tablename === table);
      const tenant = forTable.find((x) => x.policyname === 'tenant_isolation');
      const platform = forTable.find((x) => x.policyname === 'platform_access');

      expect(tenant, `${table} must have a tenant policy`).toBeDefined();
      expect(platform, `${table} must have a platform policy`).toBeDefined();
      // The critical assertion: each policy names exactly one role, and they differ.
      expect(rolesOf(tenant?.roles)).toEqual(['brandspace_app']);
      expect(rolesOf(platform?.roles)).toEqual(['brandspace_platform']);
    }
  });

  it('no policy is granted to PUBLIC', async () => {
    const r = await platformSql.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM pg_policies
        WHERE schemaname='public' AND roles::text LIKE '%public%'`,
    );
    // A PUBLIC policy would apply to every role, collapsing the separation.
    expect(Number(r.rows[0]?.c)).toBe(0);
  });

  it('RLS remains enabled AND forced on every protected table', async () => {
    const r = await platformSql.query<{ relname: string; rls: boolean; forced: boolean }>(
      `SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS forced
         FROM pg_class WHERE relnamespace = 'public'::regnamespace
          AND relname IN ('workspace','membership','role','audit_event','support_mode_session','user')`,
    );
    expect(r.rows).toHaveLength(6);
    for (const row of r.rows) {
      expect(row.rls, `${row.relname} RLS enabled`).toBe(true);
      expect(row.forced, `${row.relname} RLS forced`).toBe(true);
    }
  });
});
