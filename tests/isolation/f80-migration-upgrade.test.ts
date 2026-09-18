import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropThrowawayDatabase } from './fixtures';

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
  // F-83.
  itemId: string;
  conflictingItemId: string;
  versionId: string;
  candidateId: string;
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
  const itemId = randomUUID();
  const conflictingItemId = randomUUID();
  const versionId = randomUUID();
  const candidateId = randomUUID();

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

  // --- F-83: the knowledge graph, with every shape the five keys care about.
  //
  // `conflictingItemId` points at `itemId` through the SELF-reference, the
  // candidate targets `itemId`, the item cites the document, and the version
  // belongs to the item — so all five relationships carry real rows across the
  // upgrade rather than being asserted on an empty table.
  await client.query(
    `INSERT INTO "brand_knowledge_item"
       ("id", "workspaceId", "brandId", "area", "itemKey", "title", "body",
        "sourceDocumentId", "updatedAt")
     VALUES ($1, $2, $3, 'IDENTITY', 'identity.positioning', $4, $5, $6, now())`,
    [
      itemId,
      workspaceId,
      brandId,
      JSON.stringify({ en: 'Positioning', ar: 'التموضع' }),
      JSON.stringify({ en: `${slug} positioning`, ar: `تموضع ${slug}` }),
      documentId,
    ],
  );
  await client.query(
    `INSERT INTO "brand_knowledge_item"
       ("id", "workspaceId", "brandId", "area", "itemKey", "title", "body",
        "conflictsWithItemId", "updatedAt")
     VALUES ($1, $2, $3, 'IDENTITY', 'identity.positioning.rival', $4, $5, $6, now())`,
    [
      conflictingItemId,
      workspaceId,
      brandId,
      JSON.stringify({ en: 'Rival positioning', ar: 'تموضع منافس' }),
      JSON.stringify({ en: `${slug} rival`, ar: `منافس ${slug}` }),
      itemId,
    ],
  );
  // THE VERSION BELONGS TO THE *CONFLICTING* ITEM, and that is deliberate.
  //
  // `brand_knowledge_version` is append-only: UPDATE and DELETE are revoked and
  // a trigger refuses both. An item that has recorded history therefore cannot
  // be deleted at all — the ON DELETE CASCADE reaches the version table and the
  // trigger stops it. That is Phase 5A behaviour this migration preserves
  // exactly, and it is asserted below rather than worked around. It also means
  // the item the SET NULL tests delete must be one WITHOUT history, so the
  // history is seeded against the other item.
  await client.query(
    `INSERT INTO "brand_knowledge_version"
       ("id", "workspaceId", "brandId", "knowledgeItemId", "version", "area",
        "memory", "origin", "status", "title", "body", "changeKind")
     VALUES ($1, $2, $3, $4, 1, 'IDENTITY', 'CANONICAL', 'HUMAN', 'ACTIVE', $5, $6, 'created')`,
    [
      versionId,
      workspaceId,
      brandId,
      conflictingItemId,
      JSON.stringify({ en: 'Rival positioning', ar: 'تموضع منافس' }),
      JSON.stringify({ en: `${slug} rival`, ar: `منافس ${slug}` }),
    ],
  );
  await client.query(
    `INSERT INTO "brand_knowledge_candidate"
       ("id", "workspaceId", "brandId", "sourceDocumentId", "targetItemId", "area",
        "itemKey", "extractedTitle", "extractedBody", "confidenceMilli", "evidence")
     VALUES ($1, $2, $3, $4, $5, 'IDENTITY', 'identity.mission', $6, $7, 720, $8)`,
    [
      candidateId,
      workspaceId,
      brandId,
      documentId,
      itemId,
      JSON.stringify({ en: 'Mission', ar: 'الرسالة' }),
      JSON.stringify({ en: `${slug} mission`, ar: `رسالة ${slug}` }),
      JSON.stringify([]),
    ],
  );

  return {
    workspaceId,
    userId,
    brandId,
    documentId,
    chunkIds,
    jobId,
    conversationId,
    messageIds,
    itemId,
    conflictingItemId,
    versionId,
    candidateId,
  };
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
  /** The cross-workspace candidate that only exists because F-83 was real. */
  let smuggledCandidateId: string;

  beforeAll(async () => {
    admin = await connect(urlFor('migrator', 'postgres'));
    await admin.query(`CREATE DATABASE "${database}"`);

    migratorUrl = urlFor('migrator', database);

    /*
     * THE STATE THIS MIGRATION UPGRADES FROM: everything BEFORE it, and nothing
     * after.
     *
     * "Everything except the one under test" was the same set while F-80 was the
     * newest migration, and stopped being so the moment a later migration
     * existed. It matters because a LATER migration may legitimately depend on
     * a constraint F-80 adds — Phase 7's `insight_evidence_knowledge_fkey`
     * references `brand_knowledge_item(workspaceId, id)`, which is F-80's own
     * composite unique — so applying it first fails on a dependency that is not
     * missing in any deployment, only in the test's artificial ordering.
     *
     * No deployment ever applies migrations out of order, so the upgrade path
     * this test exists to prove is the one that stops here.
     */
    for (const name of migrationNames()) {
      if (name >= F80_MIGRATION) break;
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
      await dropThrowawayDatabase(admin, database);
      await admin.end();
    }
  }, 60_000);

  it('main really does hold EIGHT plain foreign keys', async () => {
    /*
     * THE FINDING, READ OUT OF THE DATABASE RATHER THAN TAKEN ON TRUST — and
     * counted across the WHOLE module, which is how F-83 came to light. F-80
     * named three because three tables were looked at.
     */
    const { rows } = await migrator.query<{ relation: string }>(
      `SELECT c.conrelid::regclass || '.' || c.conname AS relation
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'f'
          AND t.relname LIKE 'brand%'
          AND cardinality(c.conkey) = 1
          AND c.confrelid <> 'workspace'::regclass
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.relation)).toEqual([
      'brand_brain_message.brand_brain_message_conversationId_fkey',
      'brand_ingestion_job.brand_ingestion_job_sourceDocumentId_fkey',
      'brand_knowledge_candidate.brand_knowledge_candidate_sourceDocumentId_fkey',
      'brand_knowledge_candidate.brand_knowledge_candidate_targetItemId_fkey',
      'brand_knowledge_item.brand_knowledge_item_conflictsWithItemId_fkey',
      'brand_knowledge_item.brand_knowledge_item_sourceDocumentId_fkey',
      'brand_knowledge_version.brand_knowledge_version_knowledgeItemId_fkey',
      'brand_source_chunk.brand_source_chunk_sourceDocumentId_fkey',
    ]);
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

  it("F-83 is real at main too: A's candidate TARGETS B's approved item and it SUCCEEDS", async () => {
    /*
     * THE SAME DEFECT AT THE GOVERNANCE BOUNDARY (D-65).
     *
     * `targetItemId` names the approved knowledge item a candidate would EDIT
     * once a reviewer accepts it. Pointed at another tenant's item, the review
     * screen diffs against knowledge A has never been allowed to see — and an
     * acceptance would write a version against it.
     *
     * This is why F-83 could not be left for later: it is the one key of the
     * eight whose misuse reaches a WRITE on another tenant's canonical data.
     */
    smuggledCandidateId = randomUUID();
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.workspace_id', $1, true)`, [a.workspaceId]);
    await app.query(
      `INSERT INTO "brand_knowledge_candidate"
         ("id", "workspaceId", "brandId", "sourceDocumentId", "targetItemId", "area",
          "itemKey", "extractedTitle", "extractedBody", "confidenceMilli", "evidence")
       VALUES ($1, $2, $3, $4, $5, 'IDENTITY', 'identity.smuggled', $6, $7, 500, $8)`,
      [
        smuggledCandidateId,
        a.workspaceId,
        a.brandId,
        a.documentId,
        b.itemId,
        JSON.stringify({ en: 'smuggled', ar: 'smuggled' }),
        JSON.stringify({ en: 'smuggled', ar: 'smuggled' }),
        JSON.stringify([]),
      ],
    );
    await app.query('COMMIT');

    const { rows } = await platform.query<{ targetItemId: string }>(
      `SELECT "targetItemId" FROM "brand_knowledge_candidate" WHERE "id" = $1`,
      [smuggledCandidateId],
    );
    expect(rows[0]?.targetItemId).toBe(b.itemId);
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

    /*
     * ONE REFUSAL COVERING BOTH FINDINGS. The message names every relationship
     * with its own count, so an operator sees which of the eight is affected
     * without running anything — and sees COUNTS, never ids.
     */
    expect(() => applyMigration(migratorUrl, F80_MIGRATION)).toThrow(
      /F-80\/F-83 migration refused/,
    );
    expect(() => applyMigration(migratorUrl, F80_MIGRATION)).toThrow(
      /brand_brain_message\.conversationId=1/,
    );
    expect(() => applyMigration(migratorUrl, F80_MIGRATION)).toThrow(
      /brand_knowledge_candidate\.targetItemId=1/,
    );
    // Counts only: no uuid may appear anywhere in what the operator is shown.
    try {
      applyMigration(migratorUrl, F80_MIGRATION);
      throw new Error('the migration was ACCEPTED');
    } catch (error) {
      const text = String((error as { stderr?: unknown }).stderr ?? (error as Error).message);
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }

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
    // make for them — for BOTH cross-tenant rows.
    await platform.query(`DELETE FROM "brand_brain_message" WHERE "id" = $1`, [smuggledMessageId]);
    await platform.query(`DELETE FROM "brand_knowledge_candidate" WHERE "id" = $1`, [
      smuggledCandidateId,
    ]);

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

    expect(
      (await foreignKeys(migrator, 'brand_knowledge_candidate'))[
        'brand_knowledge_candidate_target_fkey'
      ],
    ).toContain('FOREIGN KEY ("workspaceId", "targetItemId")');
    expect(
      (await foreignKeys(migrator, 'brand_knowledge_item'))['brand_knowledge_item_conflict_fkey'],
    ).toContain('FOREIGN KEY ("workspaceId", "conflictsWithItemId")');
    expect(
      (await foreignKeys(migrator, 'brand_knowledge_version'))['brand_knowledge_version_item_fkey'],
    ).toContain('FOREIGN KEY ("workspaceId", "knowledgeItemId")');

    // And NOT ONE plain key is left anywhere in the module — the same query
    // that listed eight before the upgrade.
    const { rows } = await migrator.query<{ relation: string }>(
      `SELECT c.conrelid::regclass || '.' || c.conname AS relation
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'f'
          AND t.relname LIKE 'brand%'
          AND cardinality(c.conkey) = 1
          AND c.confrelid <> 'workspace'::regclass`,
    );
    expect(rows.map((r) => r.relation)).toEqual([]);
  });

  it('the referential actions survived, column lists included', async () => {
    /*
     * PRESERVED EXACTLY is an assertion, not a claim in a commit message. The
     * SET NULL keys additionally have to name their OWN column: a bare
     * composite SET NULL nulls `workspaceId` too, and since that column is NOT
     * NULL the parent delete would fail rather than null the reference.
     */
    const { rows } = await migrator.query<{ conname: string; definition: string }>(
      `SELECT c.conname::text AS conname, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'f' AND t.relname LIKE 'brand%'
          AND c.conname LIKE '%_fkey' AND cardinality(c.conkey) = 2
          AND c.confrelid <> 'brand'::regclass
        ORDER BY c.conname`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.conname, r.definition]));

    expect(byName['brand_source_chunk_document_fkey']).toContain('ON DELETE CASCADE');
    expect(byName['brand_ingestion_job_document_fkey']).toContain('ON DELETE CASCADE');
    expect(byName['brand_brain_message_conversation_fkey']).toContain('ON DELETE CASCADE');
    expect(byName['brand_knowledge_candidate_document_fkey']).toContain('ON DELETE CASCADE');
    expect(byName['brand_knowledge_version_item_fkey']).toContain('ON DELETE CASCADE');

    expect(byName['brand_knowledge_candidate_target_fkey']).toContain(
      'ON DELETE SET NULL ("targetItemId")',
    );
    expect(byName['brand_knowledge_item_source_fkey']).toContain(
      'ON DELETE SET NULL ("sourceDocumentId")',
    );
    expect(byName['brand_knowledge_item_conflict_fkey']).toContain(
      'ON DELETE SET NULL ("conflictsWithItemId")',
    );
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

      // F-83's rows, and the REFERENCES they carry — a migration that dropped a
      // reference while keeping the row would pass a bare existence check.
      const item = await platform.query<{ sourceDocumentId: string | null }>(
        `SELECT "sourceDocumentId" FROM "brand_knowledge_item" WHERE "id" = $1`,
        [tenant.itemId],
      );
      expect(item.rowCount).toBe(1);
      expect(item.rows[0]?.sourceDocumentId).toBe(tenant.documentId);

      const conflicting = await platform.query<{ conflictsWithItemId: string | null }>(
        `SELECT "conflictsWithItemId" FROM "brand_knowledge_item" WHERE "id" = $1`,
        [tenant.conflictingItemId],
      );
      expect(conflicting.rows[0]?.conflictsWithItemId).toBe(tenant.itemId);

      const version = await platform.query<{ knowledgeItemId: string }>(
        `SELECT "knowledgeItemId" FROM "brand_knowledge_version" WHERE "id" = $1`,
        [tenant.versionId],
      );
      expect(version.rows[0]?.knowledgeItemId).toBe(tenant.conflictingItemId);

      const candidate = await platform.query<{
        sourceDocumentId: string;
        targetItemId: string | null;
      }>(
        `SELECT "sourceDocumentId", "targetItemId" FROM "brand_knowledge_candidate" WHERE "id" = $1`,
        [tenant.candidateId],
      );
      expect(candidate.rows[0]?.sourceDocumentId).toBe(tenant.documentId);
      expect(candidate.rows[0]?.targetItemId).toBe(tenant.itemId);
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

  it("F-83: the candidate can no longer target another tenant's item", async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.workspace_id', $1, true)`, [a.workspaceId]);
    await expect(
      app.query(
        `INSERT INTO "brand_knowledge_candidate"
           ("id", "workspaceId", "brandId", "sourceDocumentId", "targetItemId", "area",
            "itemKey", "extractedTitle", "extractedBody", "confidenceMilli", "evidence")
         VALUES ($1, $2, $3, $4, $5, 'IDENTITY', 'identity.smuggled', $6, $7, 500, $8)`,
        [
          randomUUID(),
          a.workspaceId,
          a.brandId,
          a.documentId,
          b.itemId,
          JSON.stringify({ en: 'smuggled', ar: 'smuggled' }),
          JSON.stringify({ en: 'smuggled', ar: 'smuggled' }),
          JSON.stringify([]),
        ],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'brand_knowledge_candidate_target_fkey',
    });
    await app.query('ROLLBACK');
  });

  it('F-83: deleting a source document nulls the reference and KEEPS workspaceId', async () => {
    /*
     * THE DATA-LOSS-SHAPED REGRESSION THIS MIGRATION HAD TO AVOID, asserted on
     * a database that came through the upgrade rather than a fresh one.
     *
     * `brand_knowledge_item.sourceDocumentId` nulled on parent delete before,
     * and must go on nulling. Written as a composite `ON DELETE SET NULL` with
     * no column list, PostgreSQL would null `workspaceId` too, hit its NOT NULL
     * and REFUSE the delete — so a customer removing an uploaded document would
     * get an error, on a path that worked the day before.
     */
    const { rows: before } = await platform.query<{ workspaceId: string }>(
      `SELECT "workspaceId" FROM "brand_knowledge_item" WHERE "id" = $1`,
      [a.itemId],
    );
    expect(before[0]?.workspaceId).toBe(a.workspaceId);

    // Deleting the document also cascades away A's chunks, job and candidate —
    // which is the behaviour those keys already had. This is the last test to
    // touch A's document.
    await platform.query(`DELETE FROM "brand_source_document" WHERE "id" = $1`, [a.documentId]);

    const { rows: after } = await platform.query<{
      workspaceId: string;
      brandId: string;
      sourceDocumentId: string | null;
    }>(
      `SELECT "workspaceId", "brandId", "sourceDocumentId"
         FROM "brand_knowledge_item" WHERE "id" = $1`,
      [a.itemId],
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.sourceDocumentId).toBeNull();
    expect(after[0]?.workspaceId).toBe(a.workspaceId);
    expect(after[0]?.brandId).toBe(a.brandId);
  });

  it("F-83: deleting an item nulls the conflict reference and KEEPS the other item's workspaceId", async () => {
    await platform.query(`DELETE FROM "brand_knowledge_item" WHERE "id" = $1`, [a.itemId]);

    const { rows } = await platform.query<{
      workspaceId: string;
      conflictsWithItemId: string | null;
    }>(
      `SELECT "workspaceId", "conflictsWithItemId"
         FROM "brand_knowledge_item" WHERE "id" = $1`,
      [a.conflictingItemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.conflictsWithItemId).toBeNull();
    expect(rows[0]?.workspaceId).toBe(a.workspaceId);

    // B is untouched throughout: its item, its conflict link and its version
    // are exactly where they were.
    const { rows: bRows } = await platform.query<{ conflictsWithItemId: string | null }>(
      `SELECT "conflictsWithItemId" FROM "brand_knowledge_item" WHERE "id" = $1`,
      [b.conflictingItemId],
    );
    expect(bRows[0]?.conflictsWithItemId).toBe(b.itemId);
  });

  it('an item WITH recorded history still cannot be deleted — append-only wins', async () => {
    /*
     * A PHASE 5A GUARANTEE THE NEW KEY HAD TO LEAVE ALONE.
     *
     * `brand_knowledge_version.knowledgeItemId` cascades, so deleting an item
     * reaches its history — where the append-only trigger (D-65) refuses the
     * DELETE and takes the whole statement with it. The composite key kept
     * ON DELETE CASCADE exactly, so this still behaves as it did: the item
     * survives, and so does every version of it.
     *
     * Asserted because "preserved the referential action exactly" is easy to
     * say and this is what it actually means at runtime.
     */
    await expect(
      platform.query(`DELETE FROM "brand_knowledge_item" WHERE "id" = $1`, [a.conflictingItemId]),
    ).rejects.toThrow(/append-only/i);

    const { rowCount: itemRows } = await platform.query(
      `SELECT 1 FROM "brand_knowledge_item" WHERE "id" = $1`,
      [a.conflictingItemId],
    );
    expect(itemRows).toBe(1);

    const { rowCount: versionRows } = await platform.query(
      `SELECT 1 FROM "brand_knowledge_version" WHERE "id" = $1`,
      [a.versionId],
    );
    expect(versionRows).toBe(1);
  });

  it('RLS is still enabled and forced after the upgrade', async () => {
    const { rows } = await migrator.query<{ relname: string; ok: boolean }>(
      `SELECT relname, (relrowsecurity AND relforcerowsecurity) AS ok
         FROM pg_class
        WHERE relname IN ('brand_source_document', 'brand_source_chunk',
                          'brand_ingestion_job', 'brand_brain_conversation',
                          'brand_brain_message', 'brand_knowledge_item',
                          'brand_knowledge_version', 'brand_knowledge_candidate')`,
    );
    expect(rows).toHaveLength(8);
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
      await dropThrowawayDatabase(admin, database);
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
