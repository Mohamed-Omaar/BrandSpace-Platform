import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * THE D-131 MIGRATION'S PRE-FLIGHT, AND THE REALM IT ORIGINALLY MISSED.
 *
 * A trigger only guards FUTURE writes. `20260915235000` therefore refuses to
 * install while any existing membership or invitation already names a role it
 * would forbid — and it REFUSES rather than repairing, because rebinding
 * somebody's role changes who can do what and that is a product decision.
 *
 * ITS FIRST VERSION ASKED THE WRONG QUESTION. It looked for
 * `role."workspaceId" <> m."workspaceId"` and treated a NULL workspace as a
 * shared system role. Every PLATFORM role carries a NULL workspace too, so a
 * membership already bound to `platform_owner` would have sailed through the
 * pre-flight, and the trigger installed behind it would then have declared that
 * database clean for ever after.
 *
 * So this plants exactly that row — before the trigger exists, which is the
 * only moment it can be planted — and asks the migration what it does.
 *
 * The database it creates is dropped afterwards.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const migrationsDir = path.join(repoRoot, 'packages', 'database', 'prisma', 'migrations');

const MIGRATION = '20260915235000_d112_role_reference_is_workspace_scoped';

function urlFor(database: string): string {
  const source = process.env['DATABASE_MIGRATION_URL'];
  if (!source) throw new Error('the migrator connection URL is required for this suite');
  const url = new URL(source);
  url.pathname = `/${database}`;
  return url.toString();
}

/** `psql` rejects Prisma's `?schema=` extension; `public` is the default anyway. */
function libpqUrl(url: string): string {
  const parsed = new URL(url);
  parsed.search = '';
  return parsed.toString();
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

function migrationNames(): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Applied the way Prisma applies it: statement by statement, no outer transaction. */
function applyMigration(url: string, name: string): void {
  execFileSync(
    'psql',
    [
      '-v',
      'ON_ERROR_STOP=1',
      '--quiet',
      '--no-psqlrc',
      '-f',
      path.join(migrationsDir, name, 'migration.sql'),
      libpqUrl(url),
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  );
}

/**
 * Drop the throwaway database, WITHOUT `WITH (FORCE)`.
 *
 * FORCE terminates every backend attached to the database — including an
 * AUTOVACUUM WORKER, which after 29 migrations of writes is entirely likely to
 * be attached and is owned by the superuser. The migrator cannot signal it, so
 * the drop fails with "permission denied to terminate process" and the failure
 * lands in `afterAll`, turning a passing suite red for a reason that has
 * nothing to do with what it asserts. Every connection this suite opened is
 * closed by the time this runs, so a plain DROP is the correct instrument; the
 * short retry covers a backend still winding down.
 */
async function dropDatabase(admin: Client, name: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

const GUARDED = ['membership', 'invitation', 'role'] as const;

async function rlsState(
  client: Client,
): Promise<Record<string, { enabled: boolean; forced: boolean }>> {
  const { rows } = await client.query<{ relname: string; enabled: boolean; forced: boolean }>(
    `SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
       FROM pg_class WHERE relname = ANY($1::text[])`,
    [[...GUARDED]],
  );
  return Object.fromEntries(rows.map((r) => [r.relname, { enabled: r.enabled, forced: r.forced }]));
}

describe('the D-131 migration refuses to install over a role binding it would forbid', () => {
  const database = `bs_d131_preflight_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Client;
  let migratorUrl: string;
  let migrator: Client;

  const workspaceId = randomUUID();
  const userId = randomUUID();
  const platformRoleId = randomUUID();
  const systemRoleId = randomUUID();

  beforeAll(async () => {
    admin = await connect(urlFor('postgres'));
    await admin.query(`CREATE DATABASE "${database}"`);
    migratorUrl = urlFor(database);

    for (const name of migrationNames()) {
      if (name === MIGRATION) break;
      applyMigration(migratorUrl, name);
    }
    migrator = await connect(migratorUrl);

    /*
     * The "before" state. Roles and memberships come from the seed rather than
     * from a migration, so this builds the minimum by hand, with FORCE lifted —
     * every one of these tables is ENABLE + FORCE and the migrator is subject
     * to its own policies.
     */
    for (const table of ['user', 'workspace', 'role', 'membership'] as const) {
      await migrator.query(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`);
    }
    await migrator.query(
      `INSERT INTO "user" ("id","email","updatedAt") VALUES ($1::uuid,$2,now())`,
      [userId, `d131-preflight-${database.slice(-6)}@example.local`],
    );
    await migrator.query(
      `INSERT INTO "workspace" ("id","workspaceId","slug","name","ownerUserId","updatedAt")
       VALUES ($1::uuid,$1::uuid,$2,$3,$4::uuid,now())`,
      [workspaceId, `d131-${database.slice(-6)}`, 'D-131 pre-flight', userId],
    );
    await migrator.query(
      `INSERT INTO "role" ("id","workspaceId","key","realm","nameEn","nameAr","isSystem","updatedAt")
       VALUES ($1::uuid, NULL, 'platform_owner', 'PLATFORM', 'Platform Owner', 'مالك المنصة', true, now()),
              ($2::uuid, NULL, 'owner',          'WORKSPACE','Owner',          'المالك',      true, now())`,
      [platformRoleId, systemRoleId],
    );
    // The offending row. Nothing about it is malformed: a NULL workspace on a
    // role the first pre-flight would have read as "shared by everyone".
    await migrator.query(
      `INSERT INTO "membership" ("id","workspaceId","userId","roleId","status","updatedAt")
       VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,'ACTIVE',now())`,
      [workspaceId, userId, platformRoleId],
    );
    for (const table of ['user', 'workspace', 'role', 'membership'] as const) {
      await migrator.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
  }, 240_000);

  afterAll(async () => {
    await migrator?.end();
    if (admin) {
      await dropDatabase(admin, database);
      await admin.end();
    }
  }, 60_000);

  it('REFUSES while a membership names a PLATFORM-realm role, and leaves FORCE RLS intact', async () => {
    let refused = false;
    try {
      applyMigration(migratorUrl, MIGRATION);
    } catch (error: unknown) {
      refused = true;
      const output = String((error as { stderr?: unknown }).stderr ?? error);
      expect(output).toContain('membership.roleId');
      expect(output).toContain('platform-realm role');
      // Counts, never identifiers — a migration log is not a place customer
      // data belongs.
      expect(output).not.toContain(userId);
      expect(output).not.toContain(workspaceId);
      expect(output).not.toContain(platformRoleId);
    }
    expect(refused, 'the migration must refuse while the offending row exists').toBe(true);

    // And it failed ATOMICALLY: the NO FORCE statements did not survive.
    const after = await rlsState(migrator);
    for (const table of GUARDED) {
      expect(after[table], `${table} after the FAILED migration`).toEqual({
        enabled: true,
        forced: true,
      });
    }
    const { rows } = await migrator.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgname = 'membership_role_is_workspace_scoped'`,
    );
    expect(rows, 'no half-installed trigger may be left behind').toEqual([]);
  }, 120_000);

  it('APPLIES once the binding is resolved by a human decision, not by the migration', async () => {
    await migrator.query('ALTER TABLE "membership" NO FORCE ROW LEVEL SECURITY');
    await migrator.query(
      `UPDATE "membership" SET "roleId" = $1::uuid WHERE "workspaceId" = $2::uuid`,
      [systemRoleId, workspaceId],
    );
    await migrator.query('ALTER TABLE "membership" FORCE ROW LEVEL SECURITY');

    applyMigration(migratorUrl, MIGRATION);

    const after = await rlsState(migrator);
    for (const table of GUARDED) {
      expect(after[table], `${table} after the SUCCESSFUL migration`).toEqual({
        enabled: true,
        forced: true,
      });
    }
    const { rows } = await migrator.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgname LIKE '%role_is_workspace_scoped' ORDER BY tgname`,
    );
    expect(rows.map((r) => r.tgname)).toEqual([
      'invitation_role_is_workspace_scoped',
      'membership_role_is_workspace_scoped',
    ]);
  }, 120_000);
});
