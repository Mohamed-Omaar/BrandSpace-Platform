import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { TOTP, URI } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, ROLE_DEFINITIONS } from '@brandspace/shared';
import { bootstrapProductionOwner } from '../../packages/database/prisma/bootstrap-production-owner';
import { dropThrowawayDatabase } from './fixtures';

/**
 * Q12 — THE `notes.manage` MIGRATION, AS AN UPGRADE AND AS A FRESH INSTALL.
 *
 * Two throwaway databases, built two ways, must end with IDENTICAL role grants:
 *
 *   UPGRADED  every migration BEFORE `…_notes_manage_permission`, then the
 *             catalogue exactly as the previous release's seed/bootstrap wrote
 *             it (today's definitions without `notes.manage`), then the new
 *             migration — twice, because it must be idempotent.
 *   FRESH     every migration, then the real production bootstrap command,
 *             which synchronises the catalogue from today's definitions.
 *
 * If the migration and the definitions ever disagree — a role granted in one
 * and not the other — a deployed workspace and a new one would behave
 * differently, which is exactly what this suite exists to catch. It also pins
 * the Phase 2A boundary: the Viewer does NOT hold `content.read` yet, in either
 * database. Both databases are dropped afterwards.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const migrationsDir = path.join(repoRoot, 'packages', 'database', 'prisma', 'migrations');
const NOTES_MIGRATION = '20260926090000_notes_manage_permission';

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
 * The catalogue as the PREVIOUS release's seed and bootstrap wrote it: today's
 * definitions minus `notes.manage`, on the platform connection those commands
 * use.
 */
async function previousReleaseCatalogue(platform: Client): Promise<void> {
  const permissionIds = new Map<string, string>();
  for (const p of ALL_PERMISSIONS) {
    if (p.key === 'notes.manage') continue;
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
      if (key === 'notes.manage') continue;
      await platform.query(
        `INSERT INTO "role_permission" ("roleId", "permissionId") VALUES ($1, $2)`,
        [id, permissionIds.get(key)],
      );
    }
  }
}

/** Every system-role grant, as sorted `role:permission` strings. */
async function grants(platform: Client): Promise<string[]> {
  const { rows } = await platform.query<{ grant: string }>(
    `SELECT r."key" || ':' || p."key" AS "grant"
       FROM "role_permission" rp
       JOIN "role" r ON r."id" = rp."roleId" AND r."workspaceId" IS NULL
       JOIN "permission" p ON p."id" = rp."permissionId"
      ORDER BY 1`,
  );
  return rows.map((row) => row.grant);
}

async function notesManageRow(platform: Client) {
  const { rows } = await platform.query(
    `SELECT "key", "resource", "action", "minScope", "description"
       FROM "permission" WHERE "key" = 'notes.manage'`,
  );
  return rows;
}

describe('Q12 — notes.manage: an upgraded database and a fresh one grant the same', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const upgradedDb = `bs_q12_upgraded_${suffix}`;
  const freshDb = `bs_q12_fresh_${suffix}`;

  let admin: Client;
  let upgraded: Client;
  let fresh: Client;
  let freshPrisma: PrismaClient;

  beforeAll(async () => {
    admin = await connect(urlFor('migrator', 'postgres'));
    await admin.query(`CREATE DATABASE "${upgradedDb}"`);
    await admin.query(`CREATE DATABASE "${freshDb}"`);

    // UPGRADED: the previous release's schema and catalogue, then the new migration.
    const upgradedMigrator = urlFor('migrator', upgradedDb);
    const names = migrationNames();
    expect(names).toContain(NOTES_MIGRATION);
    for (const name of names) {
      if (name >= NOTES_MIGRATION) break;
      applyMigration(upgradedMigrator, name);
    }
    upgraded = await connect(urlFor('platform', upgradedDb));
    await previousReleaseCatalogue(upgraded);
    for (const name of names.filter((n) => n >= NOTES_MIGRATION)) {
      applyMigration(upgradedMigrator, name);
    }
    // Idempotent: a second run changes nothing (asserted below by equality).
    applyMigration(upgradedMigrator, NOTES_MIGRATION);

    // FRESH: every migration, then the real bootstrap command.
    const freshMigrator = urlFor('migrator', freshDb);
    for (const name of names) applyMigration(freshMigrator, name);
    freshPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: urlFor('platform', freshDb) }),
    });
    await bootstrapProductionOwner({
      prisma: freshPrisma,
      ownerEmail: `owner-zz-testfixture-${suffix}@brandspace.test`,
      password: 'a-real-owner-passphrase-q12-not-a-marker',
      log: () => undefined,
      confirmEnrolment: async ({ otpauthUri }) => {
        const totp = URI.parse(otpauthUri);
        if (!(totp instanceof TOTP)) throw new Error('not a TOTP URI');
        return totp.generate();
      },
    });
    fresh = await connect(urlFor('platform', freshDb));
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

  it('ends with identical role grants', async () => {
    const upgradedGrants = await grants(upgraded);
    expect(upgradedGrants.length).toBeGreaterThan(100);
    expect(upgradedGrants).toEqual(await grants(fresh));
  });

  it('describes notes.manage identically in both', async () => {
    const row = await notesManageRow(upgraded);
    expect(row).toHaveLength(1);
    expect(row).toEqual(await notesManageRow(fresh));
    expect(row[0]).toMatchObject({ resource: 'notes', action: 'manage', minScope: 'workspace' });
  });

  it('grants notes.manage to exactly the roles that hold content.read', async () => {
    for (const db of [upgraded, fresh]) {
      const all = await grants(db);
      const holders = (key: string) =>
        all.filter((g) => g.endsWith(`:${key}`)).map((g) => g.split(':')[0]);
      expect(holders('notes.manage')).toEqual(holders('content.read'));
      expect(holders('notes.manage')).toEqual(
        expect.arrayContaining(['workspace_owner', 'workspace_admin', 'analyst', 'approver']),
      );
    }
  });

  it('does NOT give the Viewer content.read in Phase 2A (a later release does)', async () => {
    for (const db of [upgraded, fresh]) {
      const viewer = (await grants(db)).filter((g) => g.startsWith('client_viewer:'));
      expect(viewer).toEqual(['client_viewer:workspace.read']);
    }
  });
});
