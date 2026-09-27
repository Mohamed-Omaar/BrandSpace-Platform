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
 *             catalogue exactly as the release BEFORE Phase 2A wrote it (no
 *             `notes.manage`, and a Viewer with `workspace.read` only), then the
 *             notes migration — twice, because it must be idempotent — then
 *             every later migration, the Q12 Viewer grant among them.
 *   FRESH     every migration, then the real production bootstrap command,
 *             which synchronises the catalogue from today's definitions.
 *
 * If the migrations and the definitions ever disagree — a role granted in one
 * and not the other — a deployed workspace and a new one would behave
 * differently, which is exactly what this suite exists to catch.
 *
 * It also pins the PHASE 2A BOUNDARY, on the upgraded database as it stood
 * right after the notes migration and before the Viewer's: `notes.manage` went
 * to exactly the roles that held `content.read`, and the Viewer held neither.
 * The second release's own proofs are in `q12-viewer-content-read-migration`.
 * Both databases are dropped afterwards.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const migrationsDir = path.join(repoRoot, 'packages', 'database', 'prisma', 'migrations');
const NOTES_MIGRATION = '20260926090000_notes_manage_permission';
const VIEWER_MIGRATION = '20260927090000_q12_viewer_content_read';

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
 * Permissions a LATER migration adds to a live database, so the simulated old
 * catalogue must not already hold them: `notes.manage` (Phase 2A) and
 * `workspace.security.manage` (Phase 2B-1, D-333). With them left out, the
 * equality below proves each migration grants exactly what the definitions do.
 */
const LATER_PERMISSIONS: readonly string[] = ['notes.manage', 'workspace.security.manage'];

/**
 * The catalogue as the release BEFORE Phase 2A wrote it, on the platform
 * connection its seed and bootstrap used: today's definitions without
 * `notes.manage` (Phase 2A added it) and without the Viewer's `content.read`
 * (the second Q12 release added it). Leaving the Viewer's grant in would hand
 * the simulated old database the very grant a later migration is meant to add.
 */
function inPreviousRelease(roleKey: string, permissionKey: string): boolean {
  if (LATER_PERMISSIONS.includes(permissionKey)) return false;
  if (roleKey === 'client_viewer' && permissionKey === 'content.read') return false;
  return true;
}

async function previousReleaseCatalogue(platform: Client): Promise<void> {
  const permissionIds = new Map<string, string>();
  for (const p of ALL_PERMISSIONS) {
    if (LATER_PERMISSIONS.includes(p.key)) continue;
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
      if (!inPreviousRelease(role.key, key)) continue;
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
  /** The upgraded database's grants right after Phase 2A, before the Viewer's. */
  let atPhase2A: string[];
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
    expect(names).toContain(VIEWER_MIGRATION);
    upgraded = await connect(urlFor('platform', upgradedDb));
    await previousReleaseCatalogue(upgraded);
    applyMigration(upgradedMigrator, NOTES_MIGRATION);
    /*
     * Idempotent: a second run changes nothing (asserted below by equality).
     * Re-run HERE, as it stood when Phase 2A shipped — not after the Viewer's
     * grant. The notes migration grants `notes.manage` to every holder of
     * `content.read`, so running it again once the Viewer holds `content.read`
     * would hand the Viewer `notes.manage`. Prisma never re-applies a recorded
     * migration, and this ordering is the deployed one.
     */
    applyMigration(upgradedMigrator, NOTES_MIGRATION);
    atPhase2A = await grants(upgraded);
    for (const name of names.filter((n) => n > NOTES_MIGRATION)) {
      applyMigration(upgradedMigrator, name);
    }

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

  it('grants workspace.security.manage to the Owner alone, described identically in both (D-333)', async () => {
    for (const db of [upgraded, fresh]) {
      const all = await grants(db);
      expect(all.filter((g) => g.endsWith(':workspace.security.manage'))).toEqual([
        'workspace_owner:workspace.security.manage',
      ]);
    }
    const describe = (db: Client) =>
      db.query(
        `SELECT "key", "resource", "action", "minScope", "description"
           FROM "permission" WHERE "key" = 'workspace.security.manage'`,
      );
    const [upgradedRow, freshRow] = [(await describe(upgraded)).rows, (await describe(fresh)).rows];
    expect(upgradedRow).toHaveLength(1);
    expect(upgradedRow).toEqual(freshRow);
  });

  it('describes notes.manage identically in both', async () => {
    const row = await notesManageRow(upgraded);
    expect(row).toHaveLength(1);
    expect(row).toEqual(await notesManageRow(fresh));
    expect(row[0]).toMatchObject({ resource: 'notes', action: 'manage', minScope: 'workspace' });
  });

  it('grants notes.manage to exactly the roles that hold content.read, EXCEPT client_viewer', async () => {
    const holders = (all: string[], key: string) =>
      all.filter((g) => g.endsWith(`:${key}`)).map((g) => g.split(':')[0]);
    for (const db of [upgraded, fresh]) {
      const all = await grants(db);
      // The Viewer reads content (Q12, second release) and may only comment.
      expect(holders(all, 'content.read')).toContain('client_viewer');
      expect(holders(all, 'notes.manage')).not.toContain('client_viewer');
      expect(holders(all, 'notes.manage')).toEqual(
        holders(all, 'content.read').filter((role) => role !== 'client_viewer'),
      );
      expect(holders(all, 'notes.manage')).toEqual(
        expect.arrayContaining(['workspace_owner', 'workspace_admin', 'analyst', 'approver']),
      );
    }
    // At the Phase 2A boundary the rule held with no exception at all.
    expect(holders(atPhase2A, 'notes.manage')).toEqual(holders(atPhase2A, 'content.read'));
  });

  it('Phase 2A alone gave the Viewer neither content.read nor notes.manage', () => {
    expect(atPhase2A.filter((g) => g.startsWith('client_viewer:'))).toEqual([
      'client_viewer:workspace.read',
    ]);
  });

  it('after the second release the Viewer holds workspace.read and content.read only', async () => {
    for (const db of [upgraded, fresh]) {
      const viewer = (await grants(db)).filter((g) => g.startsWith('client_viewer:'));
      expect(viewer).toEqual(['client_viewer:content.read', 'client_viewer:workspace.read']);
    }
  });
});
