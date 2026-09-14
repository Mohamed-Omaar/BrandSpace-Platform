import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * F-80 — THE MIGRATION ITSELF, AS AN UPGRADE.
 *
 * The rest of the F-80 coverage runs against the shared test database, which is
 * always fully migrated. That proves the END STATE is right and says nothing
 * about the JOURNEY, and the journey is where a corrective migration goes
 * wrong: it is applied to a database that already holds rows, and those rows
 * are somebody's brand guidelines and somebody's chat history.
 *
 * So this suite builds a database at CURRENT MAIN — every migration up to and
 * including `20260914120000_phase_5b_asset_library`, and not the F-80 one —
 * fills it with Brand Brain data, and then upgrades it. Four properties, in the
 * order they matter:
 *
 *   1. THE DEFECT IS REAL AT MAIN, demonstrated rather than cited. A message is
 *      posted, through the application role and under A's workspace context,
 *      into ANOTHER workspace's conversation. It succeeds. That is F-80, and
 *      the same insert is refused after the upgrade.
 *
 *   2. THE MIGRATION REFUSES TO RUN WHILE SUCH A ROW EXISTS, and leaves the
 *      database EXACTLY as it found it — no constraint added, no row deleted.
 *      A corrective migration that quietly removed the evidence of a
 *      cross-tenant write would be destroying the only record of an incident.
 *
 *   3. EVERY VALID ROW SURVIVES. Counts and ids are compared across the
 *      upgrade, not sampled.
 *
 *   4. A MIGRATIONS-ONLY DATABASE MATCHES THE PRISMA SCHEMA. Drift is checked
 *      against a database built only from the migration files, because a schema
 *      and a migration directory that disagree produce a defect that appears
 *      only on the next developer's machine.
 *
 * Each database this suite creates is dropped afterwards.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const databasePackage = path.join(repoRoot, 'packages', 'database');
const migrationsDir = path.join(databasePackage, 'prisma', 'migrations');

/** The migration this task adds. Everything before it is "current main". */
const F80_MIGRATION = '20260914200000_f80_brand_brain_composite_foreign_keys';

/** Rewrite a connection URL to point at a different database on the same server. */
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
  return url.toString();
}

/**
 * The same URL with Prisma's own query parameters removed.
 *
 * `?schema=public` is a Prisma extension, not part of libpq's URI syntax, and
 * `psql` rejects it outright. `public` is the default search path anyway, so
 * dropping the parameter changes nothing about where the migration lands.
 */
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

/** Every migration directory, in the order Prisma applies them. */
function migrationNames(): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Apply one migration's SQL the way Prisma applies it.
 *
 * WHY `psql` AND NOT `pg`. Prisma does NOT wrap a migration file in a
 * transaction — it runs the statements one after another, which is the only
 * reason `20260902200000_phase_2b_customers_workspaces` can add an enum value
 * and then use it. `pg` sends a multi-statement string through the simple query
 * protocol, which DOES wrap it, and that migration fails outright under it.
 * Replaying main through `pg` would therefore be replaying something main never
 * does. `psql` runs each statement in its own implicit transaction, exactly as
 * Prisma's engine does, and `ON_ERROR_STOP=1` stops at the first failure the
 * same way `migrate deploy` does.
 *
 * The all-or-nothing property this suite asserts of the F-80 migration
 * therefore comes from the explicit `BEGIN`/`COMMIT` inside that file, not from
 * the tool running it — which is the point of putting it there.
 */
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

/** Names of the foreign keys on one table, with their definitions. */
async function foreignKeys(client: Client, table: string): Promise<Record<string, string>> {
  const { rows } = await client.query<{ conname: string; definition: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE contype = 'f' AND conrelid = $1::regclass
      ORDER BY conname`,
    [table],
  );
  return Object.fromEntries(rows.map((r) => [r.conname, r.definition]));
}

/**
 * Two tenants' worth of Brand Brain data, written as the PLATFORM role — the
 * one identity RLS grants cross-tenant visibility, which is how production
 * provisions across workspaces. Returns the ids, so preservation can be
 * asserted by identity rather than by count alone.
 */
interface Tenant {
  workspaceId: string;
  userId: string;
  brandId: string;
  documentId: string;
  chunkIds: string[];
  jobId: string;
  conversationId: string;
  messageIds: string[];
}

async function seedTenant(client: Client, slug: string): Promise<Tenant> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const brandId = randomUUID();
  const documentId = randomUUID();
  const conversationId = randomUUID();
  const chunkIds = [randomUUID(), randomUUID()];
  const jobId = randomUUID();
  const messageIds = [randomUUID(), randomUUID()];

  await client.query(`INSERT INTO "user" ("id", "email", "updatedAt") VALUES ($1, $2, now())`, [
    userId,
    `owner-${slug}@example.local`,
  ]);
  await client.query(
    `INSERT INTO "workspace" ("id", "workspaceId", "slug", "name", "ownerUserId", "updatedAt")
     VALUES ($1, $1, $2, $3, $4, now())`,
    [workspaceId, slug, `Workspace ${slug}`, userId],
  );
  await client.query(
    `INSERT INTO "brand" ("id", "workspaceId", "slug", "name", "updatedAt")
     VALUES ($1, $2, 'house-brand', $3, now())`,
    [brandId, workspaceId, `House Brand ${slug}`],
  );
  await client.query(
    `INSERT INTO "brand_source_document"
       ("id", "workspaceId", "brandId", "fileName", "mimeType", "byteSize",
        "checksum", "storageKey", "status", "idempotencyKey", "chunkCount", "updatedAt")
     VALUES ($1, $2, $3, 'guidelines.pdf', 'application/pdf', 24000,
             $4, $5, 'READY', $6, 2, now())`,
    [
      documentId,
      workspaceId,
      brandId,
      `checksum-${slug}`,
      `ws/${workspaceId}/guidelines.pdf`,
      `upload-${slug}`,
    ],
  );
  for (const [index, chunkId] of chunkIds.entries()) {
    await client.query(
      `INSERT INTO "brand_source_chunk"
         ("id", "workspaceId", "brandId", "sourceDocumentId", "chunkIndex", "text", "locator")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        chunkId,
        workspaceId,
        brandId,
        documentId,
        index,
        `Confidential positioning for ${slug}, chunk ${index}.`,
        `page ${index + 1}`,
      ],
    );
  }
  await client.query(
    `INSERT INTO "brand_ingestion_job"
       ("id", "workspaceId", "brandId", "sourceDocumentId", "stage", "attempts", "chunksCreated")
     VALUES ($1, $2, $3, $4, 'COMPLETED', 1, 2)`,
    [jobId, workspaceId, brandId, documentId],
  );
  await client.query(
    `INSERT INTO "brand_brain_conversation"
       ("id", "workspaceId", "brandId", "title", "startedByUserId")
     VALUES ($1, $2, $3, $4, $5)`,
    [conversationId, workspaceId, brandId, `Conversation ${slug}`, userId],
  );
  for (const [index, messageId] of messageIds.entries()) {
    await client.query(
      `INSERT INTO "brand_brain_message"
         ("id", "workspaceId", "brandId", "conversationId", "role", "body", "idempotencyKey")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        messageId,
        workspaceId,
        brandId,
        conversationId,
        index === 0 ? 'user' : 'assistant',
        `Message ${index} for ${slug}.`,
        `message-${slug}-${index}`,
      ],
    );
  }

  return { workspaceId, userId, brandId, documentId, chunkIds, jobId, conversationId, messageIds };
}

// ---------------------------------------------------------------------------

describe('the F-80 migration as an upgrade from current main', () => {
  const database = `f80_upgrade_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  let admin: Client;
  let migrator: Client;
  let migratorUrl: string;
  let platform: Client;
  let app: Client;
  let a: Tenant;
  let b: Tenant;
  /** The cross-workspace message that only exists because F-80 was real. */
  let smuggledMessageId: string;

  beforeAll(async () => {
    admin = await connect(urlFor('migrator', 'postgres'));
    await admin.query(`CREATE DATABASE "${database}"`);

    migratorUrl = urlFor('migrator', database);

    // CURRENT MAIN: everything except the migration under test.
    for (const name of migrationNames()) {
      if (name === F80_MIGRATION) continue;
      applyMigration(migratorUrl, name);
    }

    migrator = await connect(migratorUrl);

    platform = await connect(urlFor('platform', database));
    a = await seedTenant(platform, `f80-a-${database.slice(-6)}`);
    b = await seedTenant(platform, `f80-b-${database.slice(-6)}`);

    app = await connect(urlFor('app', database));
  }, 180_000);

  afterAll(async () => {
    await app?.end();
    await platform?.end();
    await migrator?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.end();
    }
  }, 60_000);

  it('main really does hold three PLAIN foreign keys', async () => {
    // The finding, read out of the database rather than taken on trust.
    expect(
      (await foreignKeys(migrator, 'brand_source_chunk'))[
        'brand_source_chunk_sourceDocumentId_fkey'
      ],
    ).toContain('FOREIGN KEY ("sourceDocumentId")');
    expect(
      (await foreignKeys(migrator, 'brand_ingestion_job'))[
        'brand_ingestion_job_sourceDocumentId_fkey'
      ],
    ).toContain('FOREIGN KEY ("sourceDocumentId")');
    expect(
      (await foreignKeys(migrator, 'brand_brain_message'))[
        'brand_brain_message_conversationId_fkey'
      ],
    ).toContain('FOREIGN KEY ("conversationId")');
  });

  it('F-80 is real at main: A posts into B conversation and it SUCCEEDS', async () => {
    /*
     * THE DEMONSTRATION, NOT THE CITATION.
     *
     * The application role, NOBYPASSRLS, under A's workspace context. The row
     * carries A's OWN workspaceId, so the tenant policy admits it; the plain
     * foreign key is then evaluated with RLS bypassed and happily resolves B's
     * conversation. The message lands in a conversation A cannot read.
     */
    smuggledMessageId = randomUUID();
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.workspace_id', $1, true)`, [a.workspaceId]);
    await app.query(
      `INSERT INTO "brand_brain_message"
         ("id", "workspaceId", "brandId", "conversationId", "role", "body")
       VALUES ($1, $2, $3, $4, 'user', 'smuggled across the tenant boundary')`,
      [smuggledMessageId, a.workspaceId, a.brandId, b.conversationId],
    );
    await app.query('COMMIT');

    const { rows } = await platform.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "brand_brain_message" WHERE "id" = $1`,
      [smuggledMessageId],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('the migration REFUSES while that row exists, and changes nothing', async () => {
    const before = {
      chunks: await foreignKeys(migrator, 'brand_source_chunk'),
      jobs: await foreignKeys(migrator, 'brand_ingestion_job'),
      messages: await foreignKeys(migrator, 'brand_brain_message'),
      messageCount: (
        await platform.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "brand_brain_message"`,
        )
      ).rows[0]?.count,
    };

    expect(() => applyMigration(migratorUrl, F80_MIGRATION)).toThrow(/F-80 migration refused/);

    /*
     * FAIL SAFELY MEANS FAIL WITHOUT SIDE EFFECTS. The constraints are still
     * the old ones, the new unique indexes were not created, and — the part
     * that matters most — the offending row is still there. A migration that
     * "cleaned up" cross-tenant rows on its own would be deleting the evidence
     * of a security incident before anyone had looked at it.
     */
    expect(await foreignKeys(migrator, 'brand_source_chunk')).toEqual(before.chunks);
    expect(await foreignKeys(migrator, 'brand_ingestion_job')).toEqual(before.jobs);
    expect(await foreignKeys(migrator, 'brand_brain_message')).toEqual(before.messages);

    const { rows: indexes } = await migrator.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE indexname IN ('brand_source_document_workspaceId_id_key',
                            'brand_brain_conversation_workspaceId_id_key')`,
    );
    expect(indexes).toEqual([]);

    const after = (
      await platform.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "brand_brain_message"`,
      )
    ).rows[0]?.count;
    expect(after).toBe(before.messageCount);
  });

  it('once the operator has dealt with the row, the migration applies', async () => {
    // The decision a human makes after looking, which the migration refused to
    // make for them.
    await platform.query(`DELETE FROM "brand_brain_message" WHERE "id" = $1`, [smuggledMessageId]);

    expect(() => applyMigration(migratorUrl, F80_MIGRATION)).not.toThrow();

    expect(
      (await foreignKeys(migrator, 'brand_source_chunk'))['brand_source_chunk_document_fkey'],
    ).toContain('FOREIGN KEY ("workspaceId", "sourceDocumentId")');
    expect(
      (await foreignKeys(migrator, 'brand_ingestion_job'))['brand_ingestion_job_document_fkey'],
    ).toContain('FOREIGN KEY ("workspaceId", "sourceDocumentId")');
    expect(
      (await foreignKeys(migrator, 'brand_brain_message'))['brand_brain_message_conversation_fkey'],
    ).toContain('FOREIGN KEY ("workspaceId", "conversationId")');

    // And the plain keys are gone, not merely joined by composite ones.
    expect(
      (await foreignKeys(migrator, 'brand_source_chunk'))[
        'brand_source_chunk_sourceDocumentId_fkey'
      ],
    ).toBeUndefined();
    expect(
      (await foreignKeys(migrator, 'brand_brain_message'))[
        'brand_brain_message_conversationId_fkey'
      ],
    ).toBeUndefined();
  });

  it('every valid row survived the upgrade, by id', async () => {
    for (const tenant of [a, b]) {
      const document = await platform.query(
        `SELECT "id" FROM "brand_source_document" WHERE "id" = $1`,
        [tenant.documentId],
      );
      expect(document.rowCount).toBe(1);

      const chunks = await platform.query<{ id: string }>(
        `SELECT "id" FROM "brand_source_chunk" WHERE "sourceDocumentId" = $1 ORDER BY "chunkIndex"`,
        [tenant.documentId],
      );
      expect(chunks.rows.map((r) => r.id).sort()).toEqual([...tenant.chunkIds].sort());

      const job = await platform.query(`SELECT "id" FROM "brand_ingestion_job" WHERE "id" = $1`, [
        tenant.jobId,
      ]);
      expect(job.rowCount).toBe(1);

      const messages = await platform.query<{ id: string }>(
        `SELECT "id" FROM "brand_brain_message" WHERE "conversationId" = $1`,
        [tenant.conversationId],
      );
      expect(messages.rows.map((r) => r.id).sort()).toEqual([...tenant.messageIds].sort());
    }
  });

  it('the same cross-workspace insert is now refused', async () => {
    // The before-and-after that gives the whole exercise its meaning: the exact
    // statement that succeeded in the second test, run again on the upgraded
    // database.
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.workspace_id', $1, true)`, [a.workspaceId]);
    await expect(
      app.query(
        `INSERT INTO "brand_brain_message"
           ("id", "workspaceId", "brandId", "conversationId", "role", "body")
         VALUES ($1, $2, $3, $4, 'user', 'smuggled across the tenant boundary')`,
        [randomUUID(), a.workspaceId, a.brandId, b.conversationId],
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'brand_brain_message_conversation_fkey' });
    await app.query('ROLLBACK');
  });

  it('a legitimate message in the same workspace still inserts', async () => {
    // The upgrade must not have made the product stop working, which a
    // refusal-only suite could never notice.
    const id = randomUUID();
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.workspace_id', $1, true)`, [a.workspaceId]);
    await app.query(
      `INSERT INTO "brand_brain_message"
         ("id", "workspaceId", "brandId", "conversationId", "role", "body")
       VALUES ($1, $2, $3, $4, 'user', 'legitimate')`,
      [id, a.workspaceId, a.brandId, a.conversationId],
    );
    await app.query('COMMIT');

    const { rowCount } = await platform.query(
      `SELECT 1 FROM "brand_brain_message" WHERE "id" = $1`,
      [id],
    );
    expect(rowCount).toBe(1);
  });

  it('RLS is still enabled and forced after the upgrade', async () => {
    const { rows } = await migrator.query<{ relname: string; ok: boolean }>(
      `SELECT relname, (relrowsecurity AND relforcerowsecurity) AS ok
         FROM pg_class
        WHERE relname IN ('brand_source_document', 'brand_source_chunk',
                          'brand_ingestion_job', 'brand_brain_conversation',
                          'brand_brain_message')`,
    );
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.ok, row.relname).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('a migrations-only database matches the Prisma schema', () => {
  const database = `f80_drift_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  let admin: Client;

  beforeAll(async () => {
    admin = await connect(urlFor('migrator', 'postgres'));
    await admin.query(`CREATE DATABASE "${database}"`);
  }, 60_000);

  afterAll(async () => {
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.end();
    }
  }, 60_000);

  it('has no drift', () => {
    /*
     * WHY THIS IS A TEST AND NOT A NOTE IN A PULL REQUEST.
     *
     * The migration is hand-written SQL and the schema is hand-edited Prisma;
     * nothing makes them agree except care. A disagreement does not fail
     * anything today — the shared test database is migrated, so every other
     * assertion passes — and then surfaces as an inexplicable diff the next
     * time somebody runs `prisma migrate dev`. Building a database from the
     * migration FILES ONLY and diffing it against the schema is the only check
     * that catches it, and it costs one database.
     *
     * `prisma migrate deploy` and `prisma migrate diff` are run as child
     * processes because that is the only interface Prisma offers for either.
     */
    const url = urlFor('migrator', database);
    const env = { ...process.env, NODE_ENV: 'test', DATABASE_MIGRATION_URL: url };

    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: databasePackage,
      env,
      stdio: 'pipe',
    });

    const diff = execFileSync(
      'pnpm',
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        './prisma/schema.prisma',
      ],
      { cwd: databasePackage, env, encoding: 'utf8' },
    );

    expect(diff).toContain('No difference detected.');
  }, 180_000);
});
