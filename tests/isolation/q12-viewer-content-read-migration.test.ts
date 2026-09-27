import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { TOTP, URI } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, CREDIT_SPENDING_PERMISSION, ROLE_DEFINITIONS } from '@brandspace/shared';
import { bootstrapProductionOwner } from '../../packages/database/prisma/bootstrap-production-owner';
import { dropThrowawayDatabase } from './fixtures';

/**
 * Q12, SECOND RELEASE — `content.read` FOR THE VIEWER, AS A MIGRATION.
 *
 * Three throwaway databases:
 *
 *   UPGRADED  every migration BEFORE `…_q12_viewer_content_read`, then the
 *             catalogue exactly as Phase 2A left it — `notes.manage` present and
 *             granted, the Viewer at `workspace.read` only — plus the rows the
 *             system catalogue does not cover: a WORKSPACE-SCOPED
 *             `client_viewer` (`workspaceId` set; the schema, the `role` RLS
 *             policy and the D-112 trigger all permit a custom role), a
 *             workspace-scoped role of another key, and a PLATFORM-realm row
 *             that happens to carry the Viewer's key. Then the new migration,
 *             twice.
 *   EMPTY     every migration on a new database, and nothing else: the
 *             migration must not seed a partial catalogue into it.
 *   FRESH     that same database after the real production bootstrap, which
 *             writes the catalogue from `ROLE_DEFINITIONS`.
 *
 * All three are dropped afterwards.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const migrationsDir = path.join(repoRoot, 'packages', 'database', 'prisma', 'migrations');
const VIEWER_MIGRATION = '20260927090000_q12_viewer_content_read';

/**
 * What the Viewer must still never hold after this release: every note
 * mutation, every content mutation, publishing, integrations, the Copilot (the
 * one credit-spending permission, `CREDIT_SPENDING_PERMISSION`), campaigns and
 * credits. Each key is checked to EXIST below, so the list cannot rot into
 * assertions about names nobody grants.
 */
const NEVER_FOR_THE_VIEWER = [
  'notes.manage',
  'content.create',
  'content.edit',
  'content.submit',
  'content.approve',
  'content.schedule',
  'content.archive',
  'content.delete',
  'publishing.manage',
  'integrations.manage',
  CREDIT_SPENDING_PERMISSION,
  'campaigns.manage',
  'platform.credit.adjust',
] as const;

function urlFor(role: 'migrator' | 'platform', database: string): string {
  const source =
    role === 'migrator'
      ? process.env['DATABASE_MIGRATION_URL']
      : process.env['DATABASE_PLATFORM_URL'];
  if (!source) throw new Error(`the ${role} connection URL is required for this suite`);
  const url = new URL(source);
  url.pathname = `/${database}`;
  return url.toString();
}

function libpqUrl(url: string): string {
  const parsed = new URL(url);
  parsed.search = '';
  return parsed.toString();
}

/** Applied with psql, exactly as `prisma migrate deploy` applies a file. */
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

function migrationNames(): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/**
 * The catalogue as Phase 2A's seed and bootstrap wrote it: today's definitions
 * with `notes.manage`, and without the one grant this release adds.
 */
async function phase2ACatalogue(platform: Client): Promise<Map<string, string>> {
  const permissionIds = new Map<string, string>();
  for (const p of ALL_PERMISSIONS) {
    const id = randomUUID();
    permissionIds.set(p.key, id);
    await platform.query(
      `INSERT INTO "permission" ("id", "key", "resource", "action", "minScope", "description")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, p.key, p.resource, p.action, p.minScope, p.description],
    );
  }
  for (const role of ROLE_DEFINITIONS) {
    const id = randomUUID();
    await platform.query(
      `INSERT INTO "role" ("id", "workspaceId", "key", "realm", "nameEn", "nameAr", "isSystem", "updatedAt")
       VALUES ($1, NULL, $2, $3, $4, $5, true, now())`,
      [
        id,
        role.key,
        role.realm === 'platform' ? 'PLATFORM' : 'WORKSPACE',
        role.nameEn,
        role.nameAr,
      ],
    );
    for (const key of role.permissionKeys) {
      if (role.key === 'client_viewer' && key === 'content.read') continue;
      await platform.query(
        `INSERT INTO "role_permission" ("roleId", "permissionId") VALUES ($1, $2)`,
        [id, permissionIds.get(key)],
      );
    }
  }
  return permissionIds;
}

/** A role row outside the system catalogue, with the grants it is given. */
async function extraRole(
  platform: Client,
  permissionIds: Map<string, string>,
  input: {
    key: string;
    workspaceId: string | null;
    realm: 'WORKSPACE' | 'PLATFORM';
    grants: readonly string[];
  },
): Promise<void> {
  const id = randomUUID();
  await platform.query(
    `INSERT INTO "role" ("id", "workspaceId", "key", "realm", "nameEn", "nameAr", "isSystem", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $5, false, now())`,
    [id, input.workspaceId, input.key, input.realm, `Custom ${input.key}`],
  );
  for (const key of input.grants) {
    await platform.query(
      `INSERT INTO "role_permission" ("roleId", "permissionId") VALUES ($1, $2)`,
      [id, permissionIds.get(key)],
    );
  }
}

async function workspace(platform: Client, slug: string): Promise<string> {
  const id = randomUUID();
  const userId = randomUUID();
  await platform.query(
    `INSERT INTO "user" ("id", "email", "timezone", "updatedAt") VALUES ($1, $2, 'UTC', now())`,
    [userId, `owner-${slug}@example.local`],
  );
  await platform.query(
    `INSERT INTO "workspace"
       ("id", "workspaceId", "slug", "name", "ownerUserId", "country", "currency",
        "defaultLocale", "timezone", "updatedAt")
     VALUES ($1, $1, $2, $3, $4, 'SA', 'SAR', 'EN', 'UTC', now())`,
    [id, slug, `Workspace ${slug}`, userId],
  );
  return id;
}

/**
 * Every grant, as sorted `scope/realm/role:permission` strings, where scope is
 * `system` for `workspaceId IS NULL` and `workspace` otherwise.
 */
async function everyGrant(platform: Client): Promise<string[]> {
  const { rows } = await platform.query<{ grant: string }>(
    `SELECT CASE WHEN r."workspaceId" IS NULL THEN 'system' ELSE 'workspace' END
            || '/' || r."realm" || '/' || r."key" || ':' || p."key" AS "grant"
       FROM "role_permission" rp
       JOIN "role" r ON r."id" = rp."roleId"
       JOIN "permission" p ON p."id" = rp."permissionId"
      ORDER BY 1`,
  );
  return rows.map((row) => row.grant);
}

/** The system catalogue's grants, as sorted `role:permission` strings. */
async function systemGrants(platform: Client): Promise<string[]> {
  const { rows } = await platform.query<{ grant: string }>(
    `SELECT r."key" || ':' || p."key" AS "grant"
       FROM "role_permission" rp
       JOIN "role" r ON r."id" = rp."roleId" AND r."workspaceId" IS NULL
       JOIN "permission" p ON p."id" = rp."permissionId"
      ORDER BY 1`,
  );
  return rows.map((row) => row.grant);
}

async function rowCount(client: Client, table: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`);
  return Number(rows[0]?.n ?? '0');
}

describe('Q12, second release — every client_viewer row gains content.read, and only that', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const upgradedDb = `bs_q12v_upgraded_${suffix}`;
  const freshDb = `bs_q12v_fresh_${suffix}`;

  let admin: Client;
  let upgraded: Client;
  let fresh: Client;
  let freshPrisma: PrismaClient;
  let before: string[];
  let afterFirstRun: string[];
  let rowsAfterFirstRun: number;
  let emptyCounts: Record<string, number>;

  beforeAll(async () => {
    admin = await connect(urlFor('migrator', 'postgres'));
    await admin.query(`CREATE DATABASE "${upgradedDb}"`);
    await admin.query(`CREATE DATABASE "${freshDb}"`);
    const names = migrationNames();
    expect(names).toContain(VIEWER_MIGRATION);
    // NOTHING LATER RE-RUNS PHASE 2A. It used to be enough that the Viewer grant
    // was the newest migration; later phases add their own, so the invariant is
    // now asserted directly: no migration after this one mentions
    // `notes.manage`, which is the grant that must never be replayed once the
    // Viewer holds `content.read` (docs/OPERATIONS.md §6.1).
    for (const later of names.filter((name) => name > VIEWER_MIGRATION)) {
      const sql = readFileSync(path.join(migrationsDir, later, 'migration.sql'), 'utf8');
      expect(sql, later).not.toContain('notes.manage');
    }

    // UPGRADED: Phase 2A's schema and catalogue, the extra role rows, then the grant.
    const upgradedMigrator = urlFor('migrator', upgradedDb);
    for (const name of names) {
      if (name >= VIEWER_MIGRATION) break;
      applyMigration(upgradedMigrator, name);
    }
    upgraded = await connect(urlFor('platform', upgradedDb));
    const permissionIds = await phase2ACatalogue(upgraded);
    const workspaceId = await workspace(upgraded, `q12v-${suffix}`);
    await extraRole(upgraded, permissionIds, {
      key: 'client_viewer',
      workspaceId,
      realm: 'WORKSPACE',
      grants: ['workspace.read'],
    });
    await extraRole(upgraded, permissionIds, {
      key: 'brand_reviewer',
      workspaceId,
      realm: 'WORKSPACE',
      grants: ['workspace.read'],
    });
    await extraRole(upgraded, permissionIds, {
      key: 'client_viewer',
      workspaceId: null,
      realm: 'PLATFORM',
      grants: [],
    });
    before = await everyGrant(upgraded);

    applyMigration(upgradedMigrator, VIEWER_MIGRATION);
    afterFirstRun = await everyGrant(upgraded);
    rowsAfterFirstRun = await rowCount(upgraded, 'role_permission');
    // Idempotent: a second run must change nothing (asserted below).
    applyMigration(upgradedMigrator, VIEWER_MIGRATION);

    // EMPTY, then FRESH: every migration, counted, then the real bootstrap command.
    const freshMigrator = urlFor('migrator', freshDb);
    for (const name of names) applyMigration(freshMigrator, name);
    fresh = await connect(urlFor('platform', freshDb));
    emptyCounts = {
      role: await rowCount(fresh, 'role'),
      permission: await rowCount(fresh, 'permission'),
      role_permission: await rowCount(fresh, 'role_permission'),
    };
    freshPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: urlFor('platform', freshDb) }),
    });
    await bootstrapProductionOwner({
      prisma: freshPrisma,
      ownerEmail: `owner-zz-testfixture-${suffix}@brandspace.test`,
      password: 'a-real-owner-passphrase-q12v-not-a-marker',
      log: () => undefined,
      confirmEnrolment: async ({ otpauthUri }) => {
        const totp = URI.parse(otpauthUri);
        if (!(totp instanceof TOTP)) throw new Error('not a TOTP URI');
        return totp.generate();
      },
    });
  }, 600_000);

  afterAll(async () => {
    await freshPrisma?.$disconnect();
    await upgraded?.end();
    await fresh?.end();
    if (admin) {
      await dropThrowawayDatabase(admin, upgradedDb);
      await dropThrowawayDatabase(admin, freshDb);
      await admin.end();
    }
  }, 120_000);

  it('starts from Phase 2A: no Viewer row holds content.read, and notes.manage exists', () => {
    expect(before.filter((g) => g.includes('/client_viewer:content.read'))).toEqual([]);
    expect(before).toContain('system/WORKSPACE/workspace_owner:notes.manage');
  });

  it('adds content.read to the SYSTEM and the WORKSPACE-SCOPED client_viewer, and nothing else', () => {
    const added = afterFirstRun.filter((g) => !before.includes(g));
    expect(added).toEqual([
      'system/WORKSPACE/client_viewer:content.read',
      'workspace/WORKSPACE/client_viewer:content.read',
    ]);
    // Additive: nothing that was there has gone.
    expect(before.filter((g) => !afterFirstRun.includes(g))).toEqual([]);
  });

  it('gives no other role a new grant — another key, or the Viewer key in the platform realm', () => {
    const otherRoles = (grants: string[]) =>
      grants.filter((g) => !/WORKSPACE\/client_viewer:/.test(g));
    expect(otherRoles(afterFirstRun)).toEqual(otherRoles(before));
    expect(
      afterFirstRun.filter((g) => g.startsWith('workspace/WORKSPACE/brand_reviewer:')),
    ).toEqual(['workspace/WORKSPACE/brand_reviewer:workspace.read']);
    expect(afterFirstRun.filter((g) => g.startsWith('system/PLATFORM/client_viewer:'))).toEqual([]);
  });

  it('is idempotent: a second run adds no row and duplicates nothing', async () => {
    expect(await everyGrant(upgraded)).toEqual(afterFirstRun);
    expect(await rowCount(upgraded, 'role_permission')).toBe(rowsAfterFirstRun);
  });

  it('names only permissions that exist', () => {
    const catalogue = ALL_PERMISSIONS.map((p) => p.key);
    for (const key of NEVER_FOR_THE_VIEWER) expect(catalogue, key).toContain(key);
  });

  it('every Viewer row holds workspace.read and content.read, and none of the mutations', async () => {
    const all = await everyGrant(upgraded);
    for (const scope of ['system', 'workspace']) {
      const viewer = all
        .filter((g) => g.startsWith(`${scope}/WORKSPACE/client_viewer:`))
        .map((g) => g.split(':')[1]);
      expect(viewer, scope).toEqual(['content.read', 'workspace.read']);
      for (const key of NEVER_FOR_THE_VIEWER) expect(viewer, `${scope} ${key}`).not.toContain(key);
    }
  });

  it('restores FORCE row-level security on role', async () => {
    const { rows } = await upgraded.query<{ force: boolean; enabled: boolean }>(
      `SELECT relforcerowsecurity AS force, relrowsecurity AS enabled
         FROM pg_class WHERE oid = '"role"'::regclass`,
    );
    expect(rows[0]).toEqual({ force: true, enabled: true });
  });

  it('inserts nothing into a freshly migrated, empty database', () => {
    expect(emptyCounts).toEqual({ role: 0, permission: 0, role_permission: 0 });
  });

  it('an upgraded database and a freshly bootstrapped one end with identical system grants', async () => {
    const upgradedGrants = await systemGrants(upgraded);
    expect(upgradedGrants.length).toBeGreaterThan(100);
    expect(upgradedGrants).toEqual(await systemGrants(fresh));
    expect(upgradedGrants.filter((g) => g.startsWith('client_viewer:'))).toEqual([
      'client_viewer:content.read',
      'client_viewer:workspace.read',
    ]);
  });
});
