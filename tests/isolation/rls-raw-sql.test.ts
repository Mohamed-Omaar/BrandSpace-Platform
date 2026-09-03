import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IDENTITY_MODELS_WITH_POLICY,
  MODEL_TABLE_NAMES,
  NULLABLE_TENANT_MODELS,
  STRICT_TENANT_MODELS,
} from '@brandspace/database';
import { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Raw-SQL RLS proof.
 *
 * These tests deliberately bypass Prisma, the tenant-scoped client, and every other
 * line of application code. They open a plain `pg` connection as the APPLICATION
 * role and issue SQL directly.
 *
 * That is the point: docs/SECURITY.md §2 promises isolation is enforced in two
 * INDEPENDENT layers, and that layer 2 holds "even if the application layer is
 * completely bypassed". A test that goes through the ORM cannot demonstrate that.
 * These tests are what makes the second layer a verified claim rather than a
 * design intention.
 */

let prisma: PrismaClient;
let fx: IsolationFixtures;
let sql: Client;

beforeAll(async () => {
  prisma = appRoleClient();
  fx = await createIsolationFixtures(prisma);

  sql = new Client({ connectionString: process.env['DATABASE_URL'] });
  await sql.connect();
});

afterAll(async () => {
  await sql.end();
  await prisma.$disconnect();
});

/** Run SQL inside a transaction with a tenant context, exactly as the app would. */
async function inTenant<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
  await sql.query('BEGIN');
  try {
    await sql.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await run();
    await sql.query('COMMIT');
    return result;
  } catch (e: unknown) {
    await sql.query('ROLLBACK');
    throw e;
  }
}

async function countIn(workspaceId: string, table: string, where = ''): Promise<number> {
  return inTenant(workspaceId, async () => {
    const r = await sql.query<{ c: string }>(`SELECT count(*)::text AS c FROM "${table}" ${where}`);
    return Number(r.rows[0]?.c ?? '-1');
  });
}

describe('the connection under test', () => {
  it('is not a superuser and cannot bypass RLS', async () => {
    const r = await sql.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
      'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(r.rows[0]?.rolsuper).toBe(false);
    expect(r.rows[0]?.rolbypassrls).toBe(false);
  });

  it('does not own the tenant tables', async () => {
    const r = await sql.query<{ tablename: string; tableowner: string }>(
      `SELECT tablename, tableowner FROM pg_tables
        WHERE schemaname = 'public' AND tablename IN ('workspace','membership','audit_event')`,
    );
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.tableowner).not.toBe('brandspace_app');
    }
  });
});

describe('RLS is enabled AND forced on every protected table', () => {
  it('reports rowsecurity and forcerowsecurity for each', async () => {
    const r = await sql.query<{ relname: string; rls: boolean; forced: boolean }>(
      `SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS forced
         FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN ('workspace','membership','role','audit_event','support_mode_session','user')`,
    );
    expect(r.rows).toHaveLength(6);
    for (const row of r.rows) {
      expect(row.rls, `${row.relname} must have RLS enabled`).toBe(true);
      // FORCE matters: without it the table owner silently bypasses every policy.
      expect(row.forced, `${row.relname} must have RLS forced`).toBe(true);
    }
  });

  it('each protected table carries a tenant_isolation policy', async () => {
    // DERIVED from the tenancy registry, not hard-coded. A hard-coded list has
    // to be edited every time a model is added, and the edit is exactly what
    // gets forgotten — so the assertion silently stops covering the new table.
    // Reading the registry means a new tenant-owned or identity model is
    // checked here automatically.
    const expected = [
      ...STRICT_TENANT_MODELS,
      ...NULLABLE_TENANT_MODELS,
      ...IDENTITY_MODELS_WITH_POLICY,
    ]
      .map((model) => MODEL_TABLE_NAMES[model])
      .filter((table): table is string => typeof table === 'string')
      .sort();

    const r = await sql.query<{ tablename: string }>(
      `SELECT tablename FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'tenant_isolation'`,
    );
    const tables = r.rows.map((x) => x.tablename).sort();

    expect(expected.length).toBeGreaterThan(6);
    expect(tables).toEqual(expected);
  });

  it('the session-scoped policies exist and name only the tenant role', async () => {
    // The two reads that precede any workspace context (docs/SECURITY.md §20.1).
    // Asserted here so the widening stays visible and stays narrow: SELECT only,
    // tenant role only.
    const r = await sql.query<{ tablename: string; roles: string; cmd: string }>(
      `SELECT tablename, roles::text AS roles, cmd FROM pg_policies
        WHERE schemaname = 'public'
          AND policyname IN ('session_membership', 'session_workspace')
        ORDER BY tablename`,
    );
    expect(r.rows.map((x) => x.tablename)).toEqual(['membership', 'workspace']);
    for (const row of r.rows) {
      expect(row.roles).toBe('{brandspace_app}');
      expect(row.cmd).toBe('SELECT');
    }
  });

  it('the invitation-token policy is SELECT-only, tenant-only, and one row wide', async () => {
    // The third and last context-less read (docs/SECURITY.md §20.1). Redemption
    // needs to see one invitation before any workspace exists to bind; nothing
    // else about this policy may widen.
    const r = await sql.query<{
      tablename: string;
      roles: string;
      cmd: string;
      qual: string;
      with_check: string | null;
    }>(
      `SELECT tablename, roles::text AS roles, cmd, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'invitation_by_token'`,
    );
    expect(r.rows).toHaveLength(1);
    const policy = r.rows[0]!;
    expect(policy.tablename).toBe('invitation');
    expect(policy.roles).toBe('{brandspace_app}');
    expect(policy.cmd).toBe('SELECT');
    // No WITH CHECK at all: this policy grants no write of any kind.
    expect(policy.with_check).toBeNull();
    // Inert without a token, inert inside a workspace, and pending-only — so a
    // spent link cannot even confirm the invitation existed.
    expect(policy.qual).toContain('current_workspace_id');
    expect(policy.qual).toContain('current_invitation_token_hash');
    expect(policy.qual).toContain('PENDING');
  });
});

describe('raw SELECT cannot cross the tenant boundary', () => {
  it("A's raw select sees exactly one workspace: its own", async () => {
    const rows = await inTenant(fx.a.workspaceId, async () => {
      const r = await sql.query<{ id: string }>('SELECT id FROM "workspace"');
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(fx.a.workspaceId);
  });

  it("a raw select explicitly naming B's id returns zero rows", async () => {
    const count = await inTenant(fx.a.workspaceId, async () => {
      const r = await sql.query<{ c: string }>(
        'SELECT count(*)::text AS c FROM "workspace" WHERE id = $1',
        [fx.b.workspaceId],
      );
      return Number(r.rows[0]?.c);
    });
    expect(count).toBe(0);
  });

  it('an OR-TRUE predicate cannot widen visibility (RLS is not a WHERE clause)', async () => {
    const count = await inTenant(fx.a.workspaceId, async () => {
      const r = await sql.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM "workspace" WHERE 1=1 OR "workspaceId" IS NOT NULL`,
      );
      return Number(r.rows[0]?.c);
    });
    expect(count).toBe(1);
  });

  it('a JOIN cannot pull B rows in through a related table', async () => {
    const count = await inTenant(fx.a.workspaceId, async () => {
      const r = await sql.query<{ c: string }>(
        `SELECT count(*)::text AS c
           FROM "membership" m
           JOIN "workspace" w ON w.id = m."workspaceId"`,
      );
      return Number(r.rows[0]?.c);
    });
    expect(count).toBe(1);
  });

  it('a subquery cannot exfiltrate B rows', async () => {
    const count = await inTenant(fx.a.workspaceId, async () => {
      const r = await sql.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM "audit_event"
          WHERE "workspaceId" IN (SELECT id FROM "workspace")`,
      );
      return Number(r.rows[0]?.c);
    });
    expect(count).toBe(1);
  });

  it('memberships, audit events and support sessions are all scoped', async () => {
    expect(await countIn(fx.a.workspaceId, 'membership')).toBe(1);
    expect(await countIn(fx.a.workspaceId, 'audit_event')).toBe(1);
    expect(await countIn(fx.a.workspaceId, 'support_mode_session')).toBe(1);
    expect(await countIn(fx.b.workspaceId, 'membership')).toBe(1);
  });
});

describe('raw writes cannot cross the tenant boundary', () => {
  it("A's raw UPDATE of B's workspace affects zero rows", async () => {
    const affected = await inTenant(fx.a.workspaceId, async () => {
      const r = await sql.query('UPDATE "workspace" SET name = $1 WHERE id = $2', [
        'RAW_HIJACK',
        fx.b.workspaceId,
      ]);
      return r.rowCount ?? 0;
    });
    expect(affected).toBe(0);

    const stillIntact = await inTenant(fx.b.workspaceId, async () => {
      const r = await sql.query<{ name: string }>('SELECT name FROM "workspace" WHERE id = $1', [
        fx.b.workspaceId,
      ]);
      return r.rows[0]?.name;
    });
    expect(stillIntact).not.toBe('RAW_HIJACK');
  });

  it("A's raw DELETE of B's rows affects zero rows", async () => {
    const affected = await inTenant(fx.a.workspaceId, async () => {
      const r = await sql.query('DELETE FROM "membership" WHERE id = $1', [fx.b.membershipId]);
      return r.rowCount ?? 0;
    });
    expect(affected).toBe(0);
    expect(await countIn(fx.b.workspaceId, 'membership')).toBe(1);
  });

  it("A's raw INSERT into B's workspace is rejected by WITH CHECK", async () => {
    await expect(
      inTenant(fx.a.workspaceId, () =>
        sql.query(
          `INSERT INTO "audit_event" (id, "workspaceId", "actorType", action)
           VALUES (gen_random_uuid(), $1, 'SYSTEM', 'raw.forged')`,
          [fx.b.workspaceId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('fail-closed with no tenant context', () => {
  it('every tenant-owned table returns zero rows', async () => {
    await sql.query('BEGIN');
    await sql.query("SELECT set_config('app.workspace_id', '', true)");
    for (const table of ['workspace', 'membership', 'audit_event', 'support_mode_session']) {
      const r = await sql.query<{ c: string }>(`SELECT count(*)::text AS c FROM "${table}"`);
      expect(Number(r.rows[0]?.c), `${table} must be empty with no context`).toBe(0);
    }
    await sql.query('COMMIT');
  });
});

describe('audit immutability at the database level', () => {
  it('the app role holds only SELECT and INSERT on audit_event', async () => {
    const r = await sql.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE grantee = 'brandspace_app' AND table_name = 'audit_event'
        ORDER BY privilege_type`,
    );
    expect(r.rows.map((x) => x.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
  });

  it('UPDATE on audit_event is refused', async () => {
    await expect(
      inTenant(fx.a.workspaceId, () =>
        sql.query('UPDATE "audit_event" SET action = $1 WHERE id = $2', [
          'tampered',
          fx.a.auditEventId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('DELETE on audit_event is refused', async () => {
    await expect(
      inTenant(fx.a.workspaceId, () =>
        sql.query('DELETE FROM "audit_event" WHERE id = $1', [fx.a.auditEventId]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the audit event still exists after both attempts', async () => {
    expect(await countIn(fx.a.workspaceId, 'audit_event')).toBe(1);
  });
});

describe('structural invariants', () => {
  it('Workspace.workspaceId is constrained to equal Workspace.id', async () => {
    const r = await sql.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'workspace_tenant_key_matches_id'`,
    );
    expect(r.rows).toHaveLength(1);
  });

  it('the tenant context is transaction-local and does not survive COMMIT', async () => {
    await inTenant(fx.a.workspaceId, async () => {
      const r = await sql.query<{ v: string }>(
        "SELECT current_setting('app.workspace_id', true) AS v",
      );
      expect(r.rows[0]?.v).toBe(fx.a.workspaceId);
    });
    // Same physical connection, after COMMIT: the setting must be gone.
    const after = await sql.query<{ v: string | null }>(
      "SELECT current_setting('app.workspace_id', true) AS v",
    );
    expect(after.rows[0]?.v ?? '').toBe('');
  });
});
