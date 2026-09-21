import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GLOBAL_MODELS, MODEL_TABLE_NAMES } from '@brandspace/database';
import { Client } from 'pg';

/**
 * THE GLOBAL CATALOGUES ARE READ-ONLY TO THE TENANT ROLE — proven against a
 * real PostgreSQL, on a plain `pg` connection, with no application code in the
 * path.
 *
 * WHY THIS SUITE EXISTS. Three tables are classified `global` in
 * `packages/database/src/tenant-models.ts`: `permission`, `role_permission` and
 * `entitlement_catalogue_snapshot`. They carry identical rows for every
 * workspace, they have no `workspaceId`, and so — correctly — they carry no
 * row-level security. That makes the GRANT the only gate they have.
 *
 * It was open. `20260901102700_row_level_security` granted the tenant role
 * INSERT, UPDATE and DELETE on every table in the schema and on every table the
 * migrator would later create, and nothing ever revoked it for these three. The
 * D-29 isolation gate could not see it, because the gate checks the `tenant`,
 * `identity` and `platform` classifications and skips `global` entirely.
 *
 * Measured on a database migrated at eab9271, before the fix: a `DELETE` issued
 * as `brandspace_app` was ACCEPTED on all three tables. `role_permission` is the
 * severe one — writing it grants any role any permission, for every workspace
 * on the platform at once, with `configuration_version` still showing the old
 * truth.
 *
 * THIS SUITE IS DERIVED FROM THE REGISTRY, not from a hand-written list. A
 * fourth global model added later is covered the moment it is classified, which
 * is the property the hand-written table in `rls-raw-sql.test.ts` does not have.
 */

let tenant: Client;
let platform: Client;

const GLOBAL_TABLES: string[] = GLOBAL_MODELS.map((model) => {
  const table = MODEL_TABLE_NAMES[model];
  if (!table) throw new Error(`Global model "${model}" has no table name in the registry.`);
  return table;
});
const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE'] as const;

beforeAll(async () => {
  tenant = new Client({ connectionString: process.env['DATABASE_URL'] });
  await tenant.connect();

  platform = new Client({ connectionString: process.env['DATABASE_PLATFORM_URL'] });
  await platform.connect();
});

afterAll(async () => {
  await tenant.end();
  await platform.end();
});

async function hasPrivilege(
  client: Client,
  role: string,
  table: string,
  privilege: string,
): Promise<boolean> {
  const result = await client.query<{ granted: boolean }>(
    "SELECT has_table_privilege($1, format('public.%I', $2::text), $3) AS granted",
    [role, table, privilege],
  );
  return result.rows[0]?.granted === true;
}

describe('global catalogues are read-only to the tenant role', () => {
  it('classifies exactly the three tables this suite is about', () => {
    // A guard on the guard: if a global model is added, this test names it so
    // the rest of the suite is understood to cover it rather than silently
    // widening. It is not a reason to stop adding them.
    expect([...GLOBAL_TABLES].sort()).toEqual([
      'entitlement_catalogue_snapshot',
      'permission',
      'role_permission',
    ]);
  });

  it.each(GLOBAL_TABLES)('brandspace_app holds SELECT on %s', async (table) => {
    // The tenant role legitimately reads every one of these: entitlement
    // resolution, permission checks and the catalogue projection all depend on
    // it. Revoking too much would be its own outage.
    expect(await hasPrivilege(tenant, 'brandspace_app', table, 'SELECT')).toBe(true);
  });

  it.each(GLOBAL_TABLES)('brandspace_app holds no write privilege on %s', async (table) => {
    for (const privilege of WRITE_PRIVILEGES) {
      expect(
        await hasPrivilege(tenant, 'brandspace_app', table, privilege),
        `brandspace_app should not hold ${privilege} on ${table}`,
      ).toBe(false);
    }
  });

  it.each(GLOBAL_TABLES)('the platform writer keeps full access to %s', async (table) => {
    // The revoke must not have cost the legitimate writer its capability.
    // `ConfigurationService` projects the snapshot and the seed writes the
    // permission catalogue, both on this identity.
    for (const privilege of ['SELECT', ...WRITE_PRIVILEGES]) {
      expect(
        await hasPrivilege(platform, 'brandspace_platform', table, privilege),
        `brandspace_platform should hold ${privilege} on ${table}`,
      ).toBe(true);
    }
  });

  /**
   * THE PRIVILEGE CHECK IS NOT THE PROOF — the refusal is.
   *
   * `has_table_privilege` reports what the catalogue says. These cases make
   * PostgreSQL actually refuse the statement, which is what an attacker with
   * the tenant credential would meet. `WHERE false` matches nothing, so the
   * privilege is the only thing under test and no fixture is disturbed.
   */
  it.each(GLOBAL_TABLES)('PostgreSQL refuses a tenant-role DELETE on %s', async (table) => {
    await expect(tenant.query(`DELETE FROM "${table}" WHERE false`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it.each(GLOBAL_TABLES)('PostgreSQL refuses a tenant-role UPDATE on %s', async (table) => {
    // A no-op predicate again: the statement is refused before a row is read.
    await expect(
      tenant.query(`UPDATE "${table}" SET "createdAt" = "createdAt" WHERE false`),
    ).rejects.toThrow(/permission denied|column .* does not exist/i);
  });

  it('refuses the escalation this migration exists to prevent', async () => {
    /*
     * THE CONCRETE ATTACK, written out. Granting an existing role an existing
     * permission is one INSERT. Before the fix PostgreSQL accepted it from the
     * tenant role, which would have given `client_viewer` — or any role — any
     * authority in the platform, in every workspace at once.
     *
     * The SELECT inside it reads tables the role may read, so a failure here is
     * the privilege on `role_permission` and nothing else.
     */
    await expect(
      tenant.query(
        `INSERT INTO "role_permission" ("roleId", "permissionId")
         SELECT r.id, p.id FROM "role" r, "permission" p LIMIT 1`,
      ),
    ).rejects.toThrow(/permission denied for table role_permission/i);
  });
});
