import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropThrowawayDatabase } from './fixtures';

/**
 * F6 — THE brandScope MIGRATION, AS AN UPGRADE, UNDER FORCE ROW-LEVEL SECURITY,
 * RUN BY THE NOBYPASSRLS MIGRATOR.
 *
 * A throwaway database is built from every migration BEFORE F6. NULL scopes are
 * planted the way they reach production — a membership inserted with the column
 * left out (onboarding) and an explicit NULL — through the platform role, with
 * FORCE on. Then:
 *
 *   1. a long transaction on `membership` makes F6 give up after its 5-second
 *      lock timeout (owner decision D1) and leave everything exactly as it was;
 *   2. F6 applies: no NULL left, restricted scopes untouched, NOT NULL and the
 *      default in place, FORCE restored — the migrator sees no row again;
 *   3. an older release that omits the column stores `{}`; an explicit NULL is
 *      refused; the tenant role reads the former NULL as an empty scope, which
 *      the recipient predicate now matches.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../packages/database/prisma/migrations');
const F6 = '20261013090000_brand_scope_not_null';

function urlFor(role: 'migrator' | 'app' | 'platform', database: string): string {
  const source =
    role === 'migrator'
      ? process.env['DATABASE_MIGRATION_URL']
      : role === 'app'
        ? process.env['DATABASE_URL']
        : process.env['DATABASE_PLATFORM_URL'];
  if (!source) throw new Error(`the ${role} connection URL is required for this suite`);
  const url = new URL(source);
  url.pathname = `/${database}`;
  url.search = '';
  return url.toString();
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

/** Apply one migration FILE with psql, as `prisma migrate deploy` would run its SQL. */
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
      url,
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  );
}

interface Column {
  readonly notNull: boolean;
  readonly defaultExpr: string | null;
  readonly rls: boolean;
  readonly force: boolean;
}

async function column(client: Client, table: 'membership' | 'invitation'): Promise<Column> {
  const { rows } = await client.query<{
    notnull: boolean;
    def: string | null;
    rls: boolean;
    force: boolean;
  }>(
    `SELECT a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def,
            c.relrowsecurity AS rls, c.relforcerowsecurity AS force
       FROM pg_class c
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'brandScope'
       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE c.oid = $1::regclass`,
    [table],
  );
  const row = rows[0]!;
  return { notNull: row.notnull, defaultExpr: row.def, rls: row.rls, force: row.force };
}

const database = `f6_upgrade_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
let admin: Client;
let migrator: Client;
let platform: Client;
let app: Client;

const ids = {
  workspace: randomUUID(),
  owner: randomUUID(),
  restrictedUser: randomUUID(),
  explicitNullUser: randomUUID(),
  emptyUser: randomUUID(),
  brand: randomUUID(),
  role: randomUUID(),
  ownerMembership: randomUUID(),
  restrictedMembership: randomUUID(),
  explicitNullMembership: randomUUID(),
  emptyMembership: randomUUID(),
  nullInvitation: randomUUID(),
  acceptedNullInvitation: randomUUID(),
  restrictedInvitation: randomUUID(),
};

async function nullCounts(): Promise<{ membership: number; invitation: number }> {
  const { rows } = await platform.query<{ membership: number; invitation: number }>(
    `SELECT (SELECT count(*)::int FROM "membership" WHERE "brandScope" IS NULL) AS membership,
            (SELECT count(*)::int FROM "invitation" WHERE "brandScope" IS NULL) AS invitation`,
  );
  return rows[0]!;
}

async function scopeOf(table: 'membership' | 'invitation', id: string): Promise<string | null> {
  const { rows } = await platform.query<{ scope: string | null }>(
    `SELECT "brandScope"::text AS scope FROM "${table}" WHERE "id" = $1`,
    [id],
  );
  return rows[0]?.scope ?? null;
}

beforeAll(async () => {
  admin = await connect(urlFor('migrator', 'postgres'));
  await admin.query(`CREATE DATABASE "${database}"`);
  const migratorUrl = urlFor('migrator', database);
  for (const name of migrationNames()) {
    if (name >= F6) break;
    applyMigration(migratorUrl, name);
  }
  migrator = await connect(migratorUrl);
  platform = await connect(urlFor('platform', database));
  app = await connect(urlFor('app', database));

  // THE STATE F6 UPGRADES FROM, written through the platform role with FORCE on.
  const q = (sql: string, params: unknown[]) => platform.query(sql, params);
  for (const [id, email] of [
    [ids.owner, 'owner'],
    [ids.restrictedUser, 'restricted'],
    [ids.explicitNullUser, 'explicit-null'],
    [ids.emptyUser, 'empty'],
  ] as const) {
    await q(
      `INSERT INTO "user" ("id", "email", "timezone", "updatedAt") VALUES ($1, $2, 'UTC', now())`,
      [id, `f6-${email}-${database.slice(-6)}@example.local`],
    );
  }
  await q(
    `INSERT INTO "workspace" ("id", "workspaceId", "slug", "name", "country", "defaultLocale",
                              "timezone", "currency", "ownerUserId", "updatedAt")
     VALUES ($1, $1, $2, 'F6 upgrade', 'EG', 'EN', 'UTC', 'USD', $3, now())`,
    [ids.workspace, `f6-${database.slice(-8)}`, ids.owner],
  );
  await q(
    `INSERT INTO "brand" ("id", "workspaceId", "slug", "name", "updatedAt")
     VALUES ($1, $2, 'house-brand', 'House brand', now())`,
    [ids.brand, ids.workspace],
  );
  await q(
    `INSERT INTO "role" ("id", "key", "nameEn", "nameAr", "updatedAt")
     VALUES ($1, $2, 'Owner', 'المالك', now())`,
    [ids.role, `f6_owner_${database.slice(-6)}`],
  );
  const membership = (id: string, userId: string, scopeSql: string) =>
    q(
      `INSERT INTO "membership" ("id", "workspaceId", "userId", "roleId", "status", ${
        scopeSql ? '"brandScope", ' : ''
      }"updatedAt")
       VALUES ($1, $2, $3, $4, 'ACTIVE', ${scopeSql ? `${scopeSql}, ` : ''}now())`,
      [id, ids.workspace, userId, ids.role],
    );
  // Onboarding's write: the column left out.
  await membership(ids.ownerMembership, ids.owner, '');
  await membership(ids.explicitNullMembership, ids.explicitNullUser, 'NULL');
  await membership(ids.restrictedMembership, ids.restrictedUser, `ARRAY['${ids.brand}']::uuid[]`);
  await membership(ids.emptyMembership, ids.emptyUser, `ARRAY[]::uuid[]`);
  const invitation = (id: string, status: string, scopeSql: string) =>
    q(
      `INSERT INTO "invitation" ("id", "workspaceId", "email", "roleId", "brandScope", "tokenHash",
                                 "status", "expiresAt", "invitedByUserId", "updatedAt")
       VALUES ($1, $2, $3, $4, ${scopeSql}, $5, '${status}', now() + interval '7 days', $6, now())`,
      [
        id,
        ids.workspace,
        `f6-invite-${id.slice(0, 8)}@example.local`,
        ids.role,
        `f6-${id}`,
        ids.owner,
      ],
    );
  await invitation(ids.nullInvitation, 'PENDING', 'NULL');
  // A terminal invitation: its trigger must still let the backfill through.
  await invitation(ids.acceptedNullInvitation, 'ACCEPTED', 'NULL');
  await invitation(ids.restrictedInvitation, 'PENDING', `ARRAY['${ids.brand}']::uuid[]`);
}, 240_000);

afterAll(async () => {
  await app?.end();
  await platform?.end();
  await migrator?.end();
  if (admin) {
    await dropThrowawayDatabase(admin, database);
    await admin.end();
  }
}, 60_000);

describe('F6 — brandScope never NULL, as an upgrade under FORCE', () => {
  it('before: NULL scopes exist, FORCE is on, and the migrator sees no row at all', async () => {
    expect(await nullCounts()).toEqual({ membership: 2, invitation: 2 });
    for (const table of ['membership', 'invitation'] as const) {
      expect(await column(migrator, table)).toEqual({
        notNull: false,
        defaultExpr: null,
        rls: true,
        force: true,
      });
    }
    // The owner, NOBYPASSRLS and without a policy: the reason FORCE is lifted.
    const { rows } = await migrator.query<{ n: number }>(
      `SELECT (SELECT count(*)::int FROM "membership") + (SELECT count(*)::int FROM "invitation") AS n`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('behind a long transaction it gives up after its lock timeout, and changes nothing', async () => {
    const holder = await connect(urlFor('platform', database));
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT count(*) FROM "membership"`);
      const started = Date.now();
      let failure = '';
      try {
        applyMigration(urlFor('migrator', database), F6);
      } catch (error) {
        failure = String((error as { stderr?: string }).stderr ?? error);
      }
      const waited = Date.now() - started;
      expect(failure).toMatch(/lock timeout/);
      expect(waited).toBeGreaterThanOrEqual(4_500);
      expect(waited).toBeLessThan(30_000);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    // Rolled back whole: FORCE never left lifted, nothing backfilled.
    expect(await nullCounts()).toEqual({ membership: 2, invitation: 2 });
    for (const table of ['membership', 'invitation'] as const) {
      expect(await column(migrator, table)).toMatchObject({ notNull: false, force: true });
    }
  }, 60_000);

  it('applies: no NULL left, restricted scopes untouched, NOT NULL, the default, FORCE back', async () => {
    applyMigration(urlFor('migrator', database), F6);

    expect(await nullCounts()).toEqual({ membership: 0, invitation: 0 });
    expect(await scopeOf('membership', ids.ownerMembership)).toBe('{}');
    expect(await scopeOf('membership', ids.explicitNullMembership)).toBe('{}');
    expect(await scopeOf('membership', ids.emptyMembership)).toBe('{}');
    expect(await scopeOf('membership', ids.restrictedMembership)).toBe(`{${ids.brand}}`);
    expect(await scopeOf('invitation', ids.nullInvitation)).toBe('{}');
    expect(await scopeOf('invitation', ids.acceptedNullInvitation)).toBe('{}');
    expect(await scopeOf('invitation', ids.restrictedInvitation)).toBe(`{${ids.brand}}`);

    for (const table of ['membership', 'invitation'] as const) {
      expect(await column(migrator, table)).toEqual({
        notNull: true,
        defaultExpr: 'ARRAY[]::uuid[]',
        rls: true,
        force: true,
      });
    }
    // FORCE really is back: the migrator is blind to tenant rows again.
    const { rows } = await migrator.query<{ n: number }>(
      `SELECT (SELECT count(*)::int FROM "membership") + (SELECT count(*)::int FROM "invitation") AS n`,
    );
    expect(rows[0]?.n).toBe(0);
  }, 60_000);

  it('an older release that omits the column stores {}; an explicit NULL is refused', async () => {
    const userId = randomUUID();
    await platform.query(
      `INSERT INTO "user" ("id", "email", "timezone", "updatedAt") VALUES ($1, $2, 'UTC', now())`,
      [userId, `f6-old-release-${database.slice(-6)}@example.local`],
    );
    const { rows } = await platform.query<{ scope: string }>(
      `INSERT INTO "membership" ("id", "workspaceId", "userId", "roleId", "status", "updatedAt")
       VALUES ($1, $2, $3, $4, 'ACTIVE', now())
       RETURNING "brandScope"::text AS scope`,
      [randomUUID(), ids.workspace, userId, ids.role],
    );
    expect(rows[0]?.scope).toBe('{}');

    await expect(
      platform.query(`UPDATE "membership" SET "brandScope" = NULL WHERE "id" = $1`, [
        ids.ownerMembership,
      ]),
    ).rejects.toMatchObject({ code: '23502' });
    await expect(
      platform.query(`UPDATE "invitation" SET "brandScope" = NULL WHERE "id" = $1`, [
        ids.nullInvitation,
      ]),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('the tenant reads the former NULL as an empty scope, which the recipient predicate matches', async () => {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.workspace_id', $1, true)`, [ids.workspace]);
      // `resolveRecipients`' scope arm: `isEmpty` OR `has`.
      const { rows } = await app.query<{ userId: string }>(
        `SELECT "userId" FROM "membership"
          WHERE "workspaceId" = $1 AND "status" = 'ACTIVE'
            AND (cardinality("brandScope") = 0 OR "brandScope" @> ARRAY[$2]::uuid[])`,
        [ids.workspace, ids.brand],
      );
      expect(rows.map((row) => row.userId)).toEqual(
        expect.arrayContaining([
          ids.owner,
          ids.explicitNullUser,
          ids.emptyUser,
          ids.restrictedUser,
        ]),
      );
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('running it again is harmless', async () => {
    applyMigration(urlFor('migrator', database), F6);
    expect(await nullCounts()).toEqual({ membership: 0, invitation: 0 });
    expect(await column(migrator, 'membership')).toMatchObject({ notNull: true, force: true });
  }, 60_000);
});
