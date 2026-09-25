import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropThrowawayDatabase } from './fixtures';

/**
 * B-1 — THE STORAGE MIGRATION AS AN UPGRADE, with files already stored.
 *
 * The shared test database is always fully migrated and holds no pre-B-1
 * counters, so it cannot show the one thing this migration promises: that an
 * existing workspace does NOT start at 0 bytes. This suite builds a database at
 * the migration BEFORE B-1, stores files the way the product stored them —
 * including a pre-B-1 counter holding per-file gigabyte roundings — upgrades
 * it, and reads the counters back. The database is dropped afterwards.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const migrationsDir = path.join(repoRoot, 'packages', 'database', 'prisma', 'migrations');
const B1_MIGRATION = '20260925120000_storage_bytes_meter';
const B8_MIGRATION = '20260925130000_storage_bytes_brand_sources';
const EPOCH = '1970-01-01T00:00:00Z';
const MIB = 1_048_576;
const GB = 1024 * 1024 * 1024;

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

/** psql rejects Prisma's `?schema=` parameter; `public` is the default anyway. */
function libpqUrl(url: string): string {
  const parsed = new URL(url);
  parsed.search = '';
  return parsed.toString();
}

/** Applied with psql, statement by statement, exactly as `prisma migrate deploy` does. */
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

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function workspace(client: Client, slug: string): Promise<{ id: string; userId: string }> {
  const id = randomUUID();
  const userId = randomUUID();
  await client.query(
    `INSERT INTO "user" ("id", "email", "timezone", "updatedAt") VALUES ($1, $2, 'UTC', now())`,
    [userId, `owner-${slug}@example.local`],
  );
  await client.query(
    `INSERT INTO "workspace"
       ("id", "workspaceId", "slug", "name", "ownerUserId", "country", "currency",
        "defaultLocale", "timezone", "updatedAt")
     VALUES ($1, $1, $2, $3, $4, 'SA', 'SAR', 'EN', 'UTC', now())`,
    [id, slug, `Workspace ${slug}`, userId],
  );
  return { id, userId };
}

/** An asset and its versions. `storageKey: ''` is a PURGED asset — bytes gone. */
async function asset(
  client: Client,
  workspaceId: string,
  input: {
    storageKey: string;
    versions: ReadonlyArray<{ key: string; size: number }>;
    deleted?: boolean;
  },
): Promise<void> {
  const id = randomUUID();
  const head = input.versions[input.versions.length - 1] as { key: string; size: number };
  await client.query(
    `INSERT INTO "asset"
       ("id", "workspaceId", "name", "kind", "mimeType", "sizeBytes", "storageKey",
        "checksumSha256", "status", "currentVersion", "updatedAt", "deletedAt")
     VALUES ($1, $2, 'photo.png', 'IMAGE', 'image/png', $3, $4, $5, 'READY', $6, now(), $7)`,
    [
      id,
      workspaceId,
      head.size,
      input.storageKey,
      randomUUID(),
      input.versions.length,
      input.deleted ? new Date() : null,
    ],
  );
  for (const [index, version] of input.versions.entries()) {
    await client.query(
      `INSERT INTO "asset_version"
         ("id", "workspaceId", "assetId", "versionNumber", "storageKey", "checksumSha256",
          "mimeType", "sizeBytes")
       VALUES ($1, $2, $3, $4, $5, $6, 'image/png', $7)`,
      [randomUUID(), workspaceId, id, index + 1, version.key, randomUUID(), version.size],
    );
  }
}

async function session(
  client: Client,
  workspaceId: string,
  status: 'PENDING' | 'COMPLETED' | 'EXPIRED',
  size: number,
): Promise<void> {
  await client.query(
    `INSERT INTO "asset_upload_session"
       ("id", "workspaceId", "declaredFileName", "declaredMimeType", "declaredSizeBytes",
        "storageKey", "status", "idempotencyKey", "updatedAt", "expiresAt")
     VALUES ($1, $2, 'upload.png', 'image/png', $3, $4, $5, $6, now(), now() + interval '1 hour')`,
    [randomUUID(), workspaceId, size, `staging/${randomUUID()}`, status, randomUUID()],
  );
}

/** A pre-B-1 storage counter: per-file gigabyte roundings, and no bytes column yet. */
async function legacyCounter(client: Client, workspaceId: string, usedValue: number) {
  await client.query(
    `INSERT INTO "usage_counter"
       ("id", "workspaceId", "featureKey", "periodStart", "periodEnd", "usedValue", "updatedAt")
     VALUES ($1, $2, 'limit.storage_gb', $3, '9999-01-01T00:00:00Z', $4, now())`,
    [randomUUID(), workspaceId, EPOCH, usedValue],
  );
}

describe('B-1 migration: existing workspaces are backfilled, never left at 0 bytes', () => {
  const database = `b1_upgrade_${randomUUID().slice(0, 8)}`;
  let admin: Client;
  let migrator: Client;
  let platform: Client;
  let rich: { id: string; userId: string };
  let uncounted: { id: string; userId: string };
  let emptied: { id: string; userId: string };
  let big: { id: string; userId: string };

  beforeAll(async () => {
    admin = await connect(urlFor('migrator', 'postgres'));
    await admin.query(`CREATE DATABASE "${database}"`);
    const migratorUrl = urlFor('migrator', database);

    const names = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      if (name >= B1_MIGRATION) break;
      applyMigration(migratorUrl, name);
    }

    platform = await connect(urlFor('platform', database));

    // Five 1 MB photos, one of them with a restored version sharing its object,
    // a deleted-but-not-purged file, a purged one, and one pending upload. The
    // old counter charged a gigabyte for each: 7.
    rich = await workspace(platform, `b1-rich-${database.slice(-6)}`);
    for (let i = 0; i < 4; i += 1) {
      const key = `obj/${randomUUID()}`;
      await asset(platform, rich.id, { storageKey: key, versions: [{ key, size: MIB }] });
    }
    const shared = `obj/${randomUUID()}`;
    await asset(platform, rich.id, {
      storageKey: shared,
      versions: [
        { key: shared, size: MIB },
        { key: `obj/${randomUUID()}`, size: 2 * MIB },
        { key: shared, size: MIB }, // restore of v1: the same object
      ],
    });
    const deletedKey = `obj/${randomUUID()}`;
    await asset(platform, rich.id, {
      storageKey: deletedKey,
      versions: [{ key: deletedKey, size: 3 * MIB }],
      deleted: true,
    });
    await asset(platform, rich.id, {
      storageKey: '',
      versions: [{ key: `obj/${randomUUID()}`, size: 9 * MIB }],
      deleted: true,
    });
    await session(platform, rich.id, 'PENDING', 700);
    await session(platform, rich.id, 'COMPLETED', 11 * MIB);
    await session(platform, rich.id, 'EXPIRED', 13 * MIB);
    await legacyCounter(platform, rich.id, 7);

    // Files stored and no counter row at all.
    uncounted = await workspace(platform, `b1-none-${database.slice(-6)}`);
    const key = `obj/${randomUUID()}`;
    await asset(platform, uncounted.id, { storageKey: key, versions: [{ key, size: 1234 }] });

    // A counter whose files have all been purged.
    emptied = await workspace(platform, `b1-gone-${database.slice(-6)}`);
    await legacyCounter(platform, emptied.id, 3);

    // One byte past a gigabyte, split across two files.
    big = await workspace(platform, `b1-big-${database.slice(-6)}`);
    for (const size of [GB - 100, 101]) {
      const objectKey = `obj/${randomUUID()}`;
      await asset(platform, big.id, {
        storageKey: objectKey,
        versions: [{ key: objectKey, size }],
      });
    }

    applyMigration(migratorUrl, B1_MIGRATION);
    migrator = await connect(migratorUrl);
  }, 180_000);

  afterAll(async () => {
    await platform?.end();
    await migrator?.end();
    if (admin) {
      await dropThrowawayDatabase(admin, database);
      await admin.end();
    }
  }, 60_000);

  async function storage(workspaceId: string) {
    const { rows } = await platform.query<{ usedBytes: string; usedValue: number }>(
      `SELECT "usedBytes"::text AS "usedBytes", "usedValue"
         FROM "usage_counter"
        WHERE "workspaceId" = $1 AND "featureKey" = 'limit.storage_gb'`,
      [workspaceId],
    );
    return rows.map((r) => ({ usedBytes: BigInt(r.usedBytes), usedValue: r.usedValue }));
  }

  it('counts every distinct stored object and every pending upload, exactly', async () => {
    // 4 × 1 MB + (1 MB shared by v1/v3 + 2 MB v2) + 3 MB deleted-in-grace + 700 pending.
    const expected = BigInt(4 * MIB + MIB + 2 * MIB + 3 * MIB + 700);
    expect(await storage(rich.id)).toEqual([{ usedBytes: expected, usedValue: 1 }]);
  });

  it('creates the counter for a workspace that stored files without one', async () => {
    expect(await storage(uncounted.id)).toEqual([{ usedBytes: 1234n, usedValue: 1 }]);
  });

  it('zeroes a counter whose workspace no longer stores anything', async () => {
    expect(await storage(emptied.id)).toEqual([{ usedBytes: 0n, usedValue: 0 }]);
  });

  it('derives usedValue from the total with the product gigabyte (1024³), rounded up once', async () => {
    expect(await storage(big.id)).toEqual([{ usedBytes: BigInt(GB + 1), usedValue: 2 }]);
  });

  it('leaves row-level security ENABLED and FORCED on every table it touched', async () => {
    const { rows } = await migrator.query<{ relname: string; forced: boolean }>(
      `SELECT relname, (relrowsecurity AND relforcerowsecurity) AS forced
         FROM pg_class
        WHERE relkind = 'r'
          AND relname IN ('usage_counter', 'asset', 'asset_version', 'asset_upload_session')
        ORDER BY relname`,
    );
    expect(rows).toEqual([
      { relname: 'asset', forced: true },
      { relname: 'asset_upload_session', forced: true },
      { relname: 'asset_version', forced: true },
      { relname: 'usage_counter', forced: true },
    ]);
  });
});

/** A brand and one Brand Brain source document of `size` bytes. */
async function sourceDocument(
  client: Client,
  workspaceId: string,
  size: number,
  deleted = false,
): Promise<void> {
  const brandId = randomUUID();
  await client.query(
    `INSERT INTO "brand" ("id", "workspaceId", "slug", "name", "updatedAt")
     VALUES ($1, $2, $3, 'House Brand', now())`,
    [brandId, workspaceId, `brand-${brandId.slice(0, 8)}`],
  );
  await client.query(
    `INSERT INTO "brand_source_document"
       ("id", "workspaceId", "brandId", "fileName", "mimeType", "byteSize",
        "checksum", "storageKey", "status", "idempotencyKey", "updatedAt", "deletedAt")
     VALUES ($1, $2, $3, 'guidelines.pdf', 'application/pdf', $4, $5, $6, 'READY', $7, now(), $8)`,
    [
      randomUUID(),
      workspaceId,
      brandId,
      size,
      randomUUID(),
      `ws/${workspaceId}/${randomUUID()}`,
      randomUUID(),
      deleted ? new Date() : null,
    ],
  );
}

describe('B-8 migration: Brand Brain documents join every counter, recomputed', () => {
  const database = `b8_upgrade_${randomUUID().slice(0, 8)}`;
  let admin: Client;
  let migrator: Client;
  let platform: Client;
  let mixed: { id: string; userId: string };
  let brainOnly: { id: string; userId: string };

  beforeAll(async () => {
    admin = await connect(urlFor('migrator', 'postgres'));
    await admin.query(`CREATE DATABASE "${database}"`);
    const migratorUrl = urlFor('migrator', database);
    const names = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // Everything up to and including B-1, and not B-8.
    for (const name of names) {
      if (name >= B8_MIGRATION) break;
      applyMigration(migratorUrl, name);
    }
    platform = await connect(urlFor('platform', database));

    // Files B-1 already counted, plus documents nothing ever charged.
    mixed = await workspace(platform, `b8-mixed-${database.slice(-6)}`);
    const key = `obj/${randomUUID()}`;
    await asset(platform, mixed.id, { storageKey: key, versions: [{ key, size: 2 * MIB }] });
    await platform.query(
      `INSERT INTO "usage_counter"
         ("id", "workspaceId", "featureKey", "periodStart", "periodEnd",
          "usedValue", "usedBytes", "updatedAt")
       VALUES ($1, $2, 'limit.storage_gb', $3, '9999-01-01T00:00:00Z', 1, $4, now())`,
      [randomUUID(), mixed.id, EPOCH, 2 * MIB],
    );
    await sourceDocument(platform, mixed.id, 5_000);
    await sourceDocument(platform, mixed.id, 9_000, true); // deleted: not stored

    brainOnly = await workspace(platform, `b8-brain-${database.slice(-6)}`);
    await sourceDocument(platform, brainOnly.id, 123_456);

    applyMigration(migratorUrl, B8_MIGRATION);
    migrator = await connect(migratorUrl);
  }, 180_000);

  afterAll(async () => {
    await platform?.end();
    await migrator?.end();
    if (admin) {
      await dropThrowawayDatabase(admin, database);
      await admin.end();
    }
  }, 60_000);

  async function storage(workspaceId: string) {
    const { rows } = await platform.query<{ usedBytes: string; usedValue: number }>(
      `SELECT "usedBytes"::text AS "usedBytes", "usedValue"
         FROM "usage_counter"
        WHERE "workspaceId" = $1 AND "featureKey" = 'limit.storage_gb'`,
      [workspaceId],
    );
    return rows.map((r) => ({ usedBytes: BigInt(r.usedBytes), usedValue: r.usedValue }));
  }

  it('adds live documents to what was already counted, once, and ignores deleted ones', async () => {
    expect(await storage(mixed.id)).toEqual([{ usedBytes: BigInt(2 * MIB + 5_000), usedValue: 1 }]);
  });

  it('creates the counter for a workspace whose only storage is Brand Brain', async () => {
    expect(await storage(brainOnly.id)).toEqual([{ usedBytes: 123_456n, usedValue: 1 }]);
  });

  it('leaves row-level security ENABLED and FORCED on every table it touched', async () => {
    const { rows } = await migrator.query<{ relname: string; forced: boolean }>(
      `SELECT relname, (relrowsecurity AND relforcerowsecurity) AS forced
         FROM pg_class
        WHERE relkind = 'r'
          AND relname IN ('usage_counter', 'asset', 'asset_version', 'asset_upload_session',
                          'brand_source_document')
        ORDER BY relname`,
    );
    expect(rows.every((row) => row.forced)).toBe(true);
    expect(rows).toHaveLength(5);
  });
});
