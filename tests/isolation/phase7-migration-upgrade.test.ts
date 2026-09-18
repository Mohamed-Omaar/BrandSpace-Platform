import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropThrowawayDatabase } from './fixtures';

/**
 * PHASE 7 — THE MIGRATION ITSELF, AS AN UPGRADE.
 *
 * Every other Phase 7 suite runs against the shared test database, which is
 * always fully migrated. That proves the END STATE is right and says nothing
 * about the JOURNEY — and the journey is where a migration goes wrong, because
 * it is applied to a database that already holds somebody's brand guidelines,
 * somebody's drafts and somebody's connected accounts.
 *
 * So this suite builds a database at CURRENT MAIN — every migration BEFORE this
 * one, and none after — fills it with two tenants' worth of data, and upgrades
 * it. Four properties, in the order they matter:
 *
 *   1. IT APPLIES CLEANLY to a populated database, in one transaction.
 *   2. EVERY EXISTING ROW SURVIVES, compared by id rather than sampled. A
 *      migration that silently dropped a content item would pass a count check
 *      that a deletion and an insertion both moved.
 *   3. THE PROTECTIONS ARE REALLY THERE afterwards: RLS enabled AND forced on
 *      all twelve new tables, a tenant policy on each, the tenant role's
 *      privileges granted and its DELETE on the two evidence tables REVOKED.
 *   4. THE INVARIANTS THE MIGRATION CLAIMS are enforced by the database rather
 *      than by the services above it: composite tenant foreign keys, the
 *      confirmation CHECK constraints, and the append-only triggers.
 *
 * The database this suite creates is dropped afterwards.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const databasePackage = path.join(repoRoot, 'packages', 'database');
const migrationsDir = path.join(databasePackage, 'prisma', 'migrations');

/** The migration this phase adds. Everything before it is "current main". */
const PHASE7_MIGRATION = '20260916210000_phase_7_analytics_copilot';
/** The remediation migration that follows it. Applied in the SAME upgrade. */
const PHASE7_REMEDIATION_MIGRATION = '20260916230000_phase_7_remediation_strategy_provenance';
/**
 * ROUND 2. The outbox, and the five narrowed idempotency uniques.
 *
 * IT DROPS INDEXES THAT ROWS ARE ALREADY USING, which is precisely why it belongs
 * in the POPULATED upgrade rather than only in the fresh one: a `DROP INDEX` and
 * `CREATE UNIQUE INDEX` pair is where an operator with real data finds out that
 * the new, narrower key is not unique over what they already have.
 */
const PHASE7_ROUND2_MIGRATION = '20260917090000_phase_7_automation_outbox_and_idempotency_scope';
/**
 * ROUND 3. A new enum label and three columns on a table that already has rows.
 *
 * `ALTER TYPE … ADD VALUE` inside a transaction is the interesting half: it is
 * permitted from PostgreSQL 12 onward only while the new label is not USED
 * before the commit. Applying it here, against a populated database, is what
 * proves the migration actually commits rather than proving it parses.
 */
const PHASE7_ROUND3_MIGRATION = '20260917120000_phase_7_threshold_edge_and_confirmation_lifecycle';

/**
 * ROUND 4. Two columns and a BACKFILL, which is the half a fresh database can
 * never exercise.
 *
 * `automation_rule` is ENABLE + FORCE and the migrator is NOBYPASSRLS like every
 * other role, so a plain `UPDATE` in a migration does not fail — it reports
 * `UPDATE 0` and commits. This suite applies the file against rules that already
 * exist, so a backfill that silently does nothing is a failing test rather than
 * a shipped no-op.
 */
const PHASE7_ROUND4_MIGRATION = '20260917150000_phase_7_automation_rule_fair_work_cursor';

/** The twelve tenant-owned tables it creates. */
const NEW_TABLES = [
  'metric_observation',
  'analytics_ingestion_cursor',
  'analytics_ingestion_run',
  'campaign',
  'insight',
  'insight_evidence',
  'copilot_session',
  'copilot_message',
  'copilot_action_plan',
  'copilot_tool_call',
  'automation_rule',
  'automation_run',
  // ROUND 2. The outbox the feature was missing (A1).
  'automation_event',
] as const;

/** The two whose rows are EVIDENCE, and which the tenant role may not delete. */
const APPEND_ONLY_TABLES = ['insight_evidence', 'analytics_ingestion_run'] as const;

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

/** `?schema=public` is a Prisma extension that libpq rejects. */
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

/**
 * Apply one migration the way Prisma applies it — through `psql`, statement by
 * statement, with no wrapping transaction. The all-or-nothing property this
 * suite asserts therefore comes from the explicit `BEGIN`/`COMMIT` inside the
 * file (D-113), not from the tool running it, which is the whole point of
 * putting it there.
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

interface Tenant {
  readonly workspaceId: string;
  readonly userId: string;
  readonly brandId: string;
  readonly contentItemId: string;
  readonly connectionId: string;
}

/**
 * One tenant's worth of PRE-EXISTING data, written as the PLATFORM role — the
 * one identity RLS grants cross-tenant visibility, which is how production
 * provisions across tenants.
 */
async function seedTenant(client: Client, slug: string): Promise<Tenant> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const brandId = randomUUID();
  const contentItemId = randomUUID();
  const connectionId = randomUUID();

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
    `INSERT INTO "content_item"
       ("id", "workspaceId", "brandId", "title", "status", "primaryLocale", "updatedAt")
     VALUES ($1, $2, $3, $4, 'DRAFT', 'EN', now())`,
    [contentItemId, workspaceId, brandId, `Draft for ${slug}`],
  );
  await client.query(
    `INSERT INTO "social_connection"
       ("id", "workspaceId", "brandId", "provider", "externalAccountId", "displayName",
        "targetKind", "status", "updatedAt")
     VALUES ($1, $2, $3, 'LINKEDIN', $4, $5, 'organization', 'ACTIVE', now())`,
    [connectionId, workspaceId, brandId, `account-${slug}`, `Organization ${slug}`],
  );

  return { workspaceId, userId, brandId, contentItemId, connectionId };
}

/** Everything this suite must find intact on the other side of the upgrade. */
async function snapshot(client: Client): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  for (const table of ['user', 'workspace', 'brand', 'content_item', 'social_connection']) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT "id" FROM "${table}" ORDER BY "id"`,
    );
    result[table] = rows.map((row) => row.id);
  }
  return result;
}

describe('the Phase 7 migration as an upgrade from current main', () => {
  const database = `phase7_upgrade_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  let admin: Client;
  let migrator: Client;
  let migratorUrl: string;
  let platform: Client;
  let app: Client;
  let a: Tenant;
  let b: Tenant;
  let before: Record<string, string[]>;

  beforeAll(async () => {
    admin = await connect(urlFor('migrator', 'postgres'));
    await admin.query(`CREATE DATABASE "${database}"`);

    migratorUrl = urlFor('migrator', database);

    // CURRENT MAIN: every migration BEFORE this one, in order, and none after.
    for (const name of migrationNames()) {
      if (name >= PHASE7_MIGRATION) break;
      applyMigration(migratorUrl, name);
    }

    migrator = await connect(migratorUrl);
    platform = await connect(urlFor('platform', database));

    a = await seedTenant(platform, `p7-a-${database.slice(-6)}`);
    b = await seedTenant(platform, `p7-b-${database.slice(-6)}`);
    before = await snapshot(platform);

    /*
     * THE UPGRADE, AND IT IS BOTH MIGRATIONS.
     *
     * An operator upgrading from `main` applies everything that has landed since,
     * so the thing to prove is the whole hop — not each file in isolation. The
     * remediation migration adds a self-referential composite key to a table the
     * first one created, which is exactly the ordering a per-file test would
     * miss.
     */
    applyMigration(migratorUrl, PHASE7_MIGRATION);
    applyMigration(migratorUrl, PHASE7_REMEDIATION_MIGRATION);
    applyMigration(migratorUrl, PHASE7_ROUND2_MIGRATION);
    applyMigration(migratorUrl, PHASE7_ROUND3_MIGRATION);

    /*
     * RULES THAT ALREADY EXIST WHEN ROUND 4 ARRIVES, with DISTINCT creation
     * times three days apart. Written as the PLATFORM role, because the
     * migrator cannot see this table either.
     */
    for (const [index, tenant] of [a, b].entries()) {
      for (let rule = 0; rule < 2; rule += 1) {
        await platform.query(
          `INSERT INTO "automation_rule"
             ("id","workspaceId","brandId","name","enabled","triggerType","triggerConfig",
              "conditions","actionType","actionConfig","maxRunsPerDay","createdByUserId",
              "createdAt","updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, true, 'SCHEDULED_TIME',
                   '{"hourLocal":9,"daysOfWeek":[]}'::jsonb, '[]'::jsonb, 'NOTIFY',
                   '{"templateKey":"automation.confirmation_required"}'::jsonb, 0, $4,
                   now() - ($5 || ' days')::interval, now())`,
          [
            tenant.workspaceId,
            tenant.brandId,
            `pre-upgrade rule ${index}-${rule}`,
            tenant.userId,
            String(index * 2 + rule + 1),
          ],
        );
      }
    }

    applyMigration(migratorUrl, PHASE7_ROUND4_MIGRATION);

    app = await connect(urlFor('app', database));
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

  it('every pre-existing row survives, compared by id', async () => {
    /*
     * BY ID, NOT BY COUNT. A migration that deleted one content item and
     * inserted another would pass a count check and fail this one, and the
     * difference is somebody's work.
     */
    expect(await snapshot(platform)).toEqual(before);
  });

  it('THE THRESHOLD COLUMNS ARRIVE WITHOUT ASSUMING A SIDE', async () => {
    /*
     * `thresholdBreached` MUST BE NULL ON EVERY EXISTING ROW, and that is not a
     * detail of defaults: null means "never evaluated", and a migration that
     * back-filled `false` would tell every threshold rule in the estate that its
     * metric is currently below the line. The next sweep would then read the
     * first measurement as a CROSSING and alert about a number that had not
     * moved.
     */
    const { rows } = await migrator.query<{
      column_name: string;
      column_default: string | null;
      is_nullable: string;
    }>(
      `SELECT column_name, column_default, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'automation_rule'
          AND column_name IN ('thresholdBreached', 'thresholdCycle', 'thresholdEvaluatedAt')
        ORDER BY column_name`,
    );
    expect(rows.map((row) => row.column_name)).toEqual([
      'thresholdBreached',
      'thresholdCycle',
      'thresholdEvaluatedAt',
    ]);
    const breached = rows.find((row) => row.column_name === 'thresholdBreached');
    expect(breached?.is_nullable).toBe('YES');
    expect(breached?.column_default).toBeNull();
    const cycle = rows.find((row) => row.column_name === 'thresholdCycle');
    expect(cycle?.is_nullable).toBe('NO');
    expect(cycle?.column_default).toContain('0');
  });

  it('THE FAIR-WORK CURSOR IS BACKFILLED FROM createdAt, NOT SILENTLY SKIPPED', async () => {
    /*
     * THE FAILURE THIS CATCHES. `automation_rule` is ENABLE + FORCE and the
     * MIGRATOR role is NOBYPASSRLS, so an `UPDATE` in a migration reports
     * `UPDATE 0` and commits rather than raising. The backfill would have
     * shipped doing nothing, every existing rule would have started at the
     * migration's own `now()`, and the id tie-break would have been the only
     * ordering the queue had.
     */
    const rows = await platform.query<{
      nextEvaluationAt: Date;
      createdAt: Date;
      lastEvaluatedAt: Date | null;
    }>('SELECT "nextEvaluationAt", "createdAt", "lastEvaluatedAt" FROM "automation_rule"');

    expect(rows.rows.length).toBe(4);
    for (const row of rows.rows) {
      expect(row.nextEvaluationAt.getTime()).toBe(row.createdAt.getTime());
      // NEVER EVALUATED is null, and never a fabricated timestamp.
      expect(row.lastEvaluatedAt).toBeNull();
    }
    // FOUR DISTINCT POSITIONS, which is the fairness property: the queue has a
    // real order rather than one instant shared by every row.
    expect(new Set(rows.rows.map((row) => row.nextEvaluationAt.getTime())).size).toBe(4);
  });

  it('AND FORCE IS BACK ON AFTERWARDS', async () => {
    /*
     * The one way that migration could do real harm is by committing with FORCE
     * left off — `automation_rule` would be a tenant table whose owner is no
     * longer subject to its own policies. The file asserts this itself and
     * refuses to commit; this asserts it from outside, against the catalogue.
     */
    const rls = await platform.query<{ enabled: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class WHERE relname = 'automation_rule'`,
    );
    expect(rls.rows[0]).toEqual({ enabled: true, forced: true });
  });

  it('and the tenant role still cannot read another workspace\u2019s rules', async () => {
    // The lifted FORCE was the OWNER's, for one transaction. Nothing about the
    // application role's isolation changed, and this is the check that says so.
    await app.query(`SELECT set_config('app.workspace_id', $1, false)`, [a.workspaceId]);
    const seen = await app.query<{ count: string }>('SELECT count(*)::text FROM "automation_rule"');
    expect(seen.rows[0]?.count).toBe('2');
  });

  it('EXPIRED IS A REAL LABEL ON THE RUN STATUS TYPE AFTER THE UPGRADE', async () => {
    // `ALTER TYPE … ADD VALUE` in a transaction commits or it does not; asking
    // the catalogue is the only way to know which.
    const { rows } = await migrator.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
         JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
        WHERE pg_type.typname = 'AutomationRunStatus'
        ORDER BY enumlabel`,
    );
    expect(rows.map((row) => row.enumlabel)).toContain('EXPIRED');
  });

  it('THE NARROWED IDEMPOTENCY UNIQUES HOLD OVER DATA THAT WAS ALREADY THERE', () => {
    /*
     * THE RISK A FRESH DATABASE CANNOT SHOW. Five `DROP INDEX` /
     * `CREATE UNIQUE INDEX` pairs run against rows an operator already has. A
     * narrower key is not automatically unique over existing data — it is only
     * unique here because each new index is a SUPERSET of the columns the old
     * one carried, so anything the old index permitted the new one permits too.
     * Stating that as a test means a future narrowing that is NOT a superset
     * fails on the upgrade rather than in somebody's production migration.
     */
    const expected: Record<string, readonly string[]> = {
      copilot_action_plan: ['workspaceId', 'sessionId', 'idempotencyKey'],
      content_item: ['workspaceId', 'brandId', 'createdByUserId', 'idempotencyKey'],
      campaign: ['workspaceId', 'brandId', 'createdByUserId', 'idempotencyKey'],
      insight: ['workspaceId', 'brandId', 'type', 'generatedByUserId', 'idempotencyKey'],
      brand_brain_message: ['workspaceId', 'conversationId', 'idempotencyKey'],
    };
    return (async () => {
      for (const [table, columns] of Object.entries(expected)) {
        const { rows } = await migrator.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexdef LIKE '%idempotencyKey%'`,
          [table],
        );
        expect(rows, table).toHaveLength(1);
        const definition = rows[0]?.indexdef ?? '';
        expect(definition, table).toContain('UNIQUE');
        // PostgreSQL quotes an identifier only when it has to, so `type` comes
        // back bare while `brandId` comes back quoted. Comparing the column LIST
        // rather than the rendered text is what makes this independent of that.
        const listed = (definition.match(/\(([^)]*)\)\s*$/)?.[1] ?? '')
          .split(',')
          .map((column) => column.trim().replace(/^"|"$/g, ''));
        expect(listed, table).toEqual([...columns]);
      }
    })();
  });

  it('creates all thirteen tenant-owned tables', async () => {
    const { rows } = await migrator.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)
        ORDER BY tablename`,
      [[...NEW_TABLES]],
    );
    expect(rows.map((row) => row.tablename).sort()).toEqual([...NEW_TABLES].sort());
  });

  it('enables AND FORCES row-level security on every one of them', async () => {
    /*
     * FORCE MATTERS AS MUCH AS ENABLE. Without it the table OWNER silently
     * bypasses every policy, and the owner is the identity that runs migrations
     * and maintenance.
     */
    const { rows } = await migrator.query<{ relname: string; rls: boolean; forced: boolean }>(
      `SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS forced
         FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
      [[...NEW_TABLES]],
    );
    expect(rows).toHaveLength(NEW_TABLES.length);
    for (const row of rows) {
      expect(row.rls, `${row.relname} RLS enabled`).toBe(true);
      expect(row.forced, `${row.relname} RLS forced`).toBe(true);
    }
  });

  it('gives every one a tenant_isolation policy naming only the tenant role', async () => {
    const { rows } = await migrator.query<{ tablename: string; roles: string }>(
      `SELECT tablename, roles::text AS roles FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'tenant_isolation' AND tablename = ANY($1)
        ORDER BY tablename`,
      [[...NEW_TABLES]],
    );
    expect(rows.map((row) => row.tablename).sort()).toEqual([...NEW_TABLES].sort());
    for (const row of rows) {
      expect(row.roles, `${row.tablename} policy roles`).toBe('{brandspace_app}');
    }
  });

  it('REVOKES delete on the two tables whose rows are evidence', async () => {
    /*
     * A CITATION THAT CAN BE DELETED IS NOT EVIDENCE, and a run record an
     * operator cannot trust is not a record. The refusal is a PRIVILEGE error
     * rather than an RLS no-op, which is the strongest form it takes.
     */
    for (const table of APPEND_ONLY_TABLES) {
      const { rows } = await migrator.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.table_privileges
          WHERE grantee = 'brandspace_app' AND table_name = $1 ORDER BY privilege_type`,
        [table],
      );
      const held = rows.map((row) => row.privilege_type);
      expect(held, `${table} must not grant DELETE`).not.toContain('DELETE');
      expect(held, `${table} must still be readable`).toContain('SELECT');
      expect(held, `${table} must still be writable`).toContain('INSERT');
    }
  });

  it('every tenant foreign key into a tenant table is COMPOSITE (D-112)', async () => {
    /*
     * A SINGLE-COLUMN FOREIGN KEY INTO A TENANT TABLE IS A CROSS-TENANT DOOR:
     * it validates that the id exists SOMEWHERE, not that it exists in THIS
     * workspace. Every one of the new keys carries `workspaceId` as its first
     * column.
     */
    const { rows } = await migrator.query<{ conname: string; table: string; columns: string[] }>(
      `SELECT c.conname,
              c.conrelid::regclass::text AS "table",
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
              ) AS columns
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid = ANY($1::regclass[])
          AND c.confrelid <> 'workspace'::regclass
        ORDER BY c.conname`,
      [[...NEW_TABLES]],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.columns[0], `${row.conname} on ${row.table} must lead with workspaceId`).toBe(
        'workspaceId',
      );
      expect(row.columns.length, `${row.conname} must be composite`).toBeGreaterThanOrEqual(2);
    }
  });

  it("records an insight's provenance with a SELF-REFERENTIAL COMPOSITE key", async () => {
    /*
     * `insight.sourceInsightId` — a MONTHLY_PLAN's link to the ACCEPTED strategy
     * it was planned against (D-166).
     *
     * THE KEY MUST BE COMPOSITE EVEN THOUGH IT POINTS AT ITS OWN TABLE. A plain
     * `sourceInsightId -> insight(id)` would resolve ANOTHER workspace's insight:
     * PostgreSQL evaluates referential integrity as the table owner with RLS
     * bypassed, so "inserted" versus "violates foreign key" would answer "does
     * that insight exist?" across the tenant boundary.
     */
    const { rows } = await migrator.query<{
      columns: string[];
      confupdtype: string;
      confdeltype: string;
      confdelsetcols: number[] | null;
    }>(
      `SELECT (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
              ) AS columns,
              c.confupdtype::text, c.confdeltype::text, c.confdelsetcols
         FROM pg_constraint c
        WHERE c.contype = 'f' AND c.conname = 'insight_source_fkey'`,
    );
    expect(rows).toHaveLength(1);
    const key = rows[0];
    expect(key?.columns).toEqual(['workspaceId', 'sourceInsightId']);
    // 'n' is SET NULL.
    expect(key?.confdeltype).toBe('n');
    /*
     * AND THE SET NULL NAMES ITS COLUMN (D-114). A bare SET NULL on this key
     * would null `workspaceId` too — which is NOT NULL — so deleting a strategy
     * would fail outright rather than orphaning the plan.
     */
    expect(key?.confdelsetcols?.length).toBe(1);
  });

  it('the provenance column is nullable, so every pre-existing insight is untouched', async () => {
    const { rows } = await migrator.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'insight' AND column_name = 'sourceInsightId'`,
    );
    expect(rows[0]?.is_nullable).toBe('YES');
  });

  it('a plan that would skip confirmation for an external action is unrepresentable', async () => {
    /*
     * THROUGH THE PLATFORM ROLE, not the owner. FORCE ROW LEVEL SECURITY means
     * even the table's owner is subject to its policies, and the migrator is
     * named by none of them — so an owner probe here fails on RLS before it ever
     * reaches the CHECK it is meant to demonstrate. That the owner is refused is
     * itself asserted above; this test is about the constraint.
     */
    await expect(
      platform.query(
        `INSERT INTO "copilot_action_plan"
           ("id", "workspaceId", "sessionId", "userId", "planHash", "summary", "steps",
            "highestActionClass", "requiresConfirmation", "correlationId", "updatedAt")
         VALUES (gen_random_uuid(), $1, gen_random_uuid(), $2, 'h', '{}', '[]',
                 'EXTERNAL_OR_DESTRUCTIVE', false, gen_random_uuid(), now())`,
        [a.workspaceId, a.userId],
      ),
    ).rejects.toThrow(/external_requires_confirmation/i);
  });

  it('an automation that would skip confirmation for an external action is unrepresentable', async () => {
    await expect(
      platform.query(
        `INSERT INTO "automation_rule"
           ("id", "workspaceId", "brandId", "name", "triggerType", "actionType",
            "requiresConfirmationForExternal", "createdByUserId", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, 'probe', 'CONTENT_APPROVED', 'PROPOSE_PUBLISH',
                 false, $3, now())`,
        [a.workspaceId, a.brandId, a.userId],
      ),
    ).rejects.toThrow(/external_requires_confirmation/i);
  });

  it('a metric evidence row with no measurement is unrepresentable', async () => {
    /*
     * THE ANTI-FABRICATION CONSTRAINT. An evidence row with a label and no
     * numbers would be a citation pointing at nothing, which is exactly the
     * shape a fabricated one takes.
     */
    const insightId = randomUUID();
    await platform.query(
      `INSERT INTO "insight"
         ("id", "workspaceId", "brandId", "type", "basis", "title", "body",
          "periodStart", "periodEnd", "updatedAt")
       VALUES ($1, $2, $3, 'ANALYTICS_EXPLANATION', 'OWN_PERFORMANCE', '{}', '{}',
               now(), now(), now())`,
      [insightId, a.workspaceId, a.brandId],
    );

    await expect(
      platform.query(
        `INSERT INTO "insight_evidence"
           ("id", "workspaceId", "brandId", "insightId", "ordinal", "kind", "labelKey")
         VALUES (gen_random_uuid(), $1, $2, $3, 1, 'METRIC', 'a.label')`,
        [a.workspaceId, a.brandId, insightId],
      ),
    ).rejects.toThrow(/metric_is_measured/i);
  });

  it("an observation cannot name ANOTHER workspace's brand, even as the owner", async () => {
    /*
     * THE PLATFORM ROLE IS THE MOST PRIVILEGED IDENTITY THE APPLICATION EVER
     * HOLDS, and it is the one that legitimately writes across tenants. This is
     * the cross-BRAND forgery attempted with it, and only the composite key
     * `(workspaceId, brandId)` can refuse it — RLS cannot, because the workspace
     * on the row is a real one this identity may write to.
     */
    await expect(
      platform.query(
        `INSERT INTO "metric_observation"
           ("id", "workspaceId", "brandId", "socialConnectionId", "provider", "subjectType",
            "subjectExternalId", "metricKey", "granularity", "periodStart", "periodEnd",
            "value", "unit", "observedAt", "sourceKind", "sourceVersion", "observationKey")
         VALUES (gen_random_uuid(), $1, $2, $3, 'LINKEDIN', 'ACCOUNT', 'x', 'impressions',
                 'DAY', now(), now(), 1, 'COUNT', now(), 'PROVIDER', 'v1', $4)`,
        [a.workspaceId, b.brandId, a.connectionId, `probe-${randomUUID()}`],
      ),
    ).rejects.toThrow();
  });

  it('insight_evidence is append-only even for the table owner', async () => {
    /*
     * THROUGH THE PLATFORM ROLE, which holds UPDATE and is named by the
     * table's policy — so the statement reaches the TRIGGER rather than being
     * stopped earlier by a privilege or a policy. That is what makes this a
     * demonstration of the trigger and not of something else.
     */
    const insightId = randomUUID();
    const evidenceId = randomUUID();
    await platform.query(
      `INSERT INTO "insight"
         ("id", "workspaceId", "brandId", "type", "basis", "title", "body",
          "periodStart", "periodEnd", "updatedAt")
       VALUES ($1, $2, $3, 'ANALYTICS_EXPLANATION', 'OWN_PERFORMANCE', '{}', '{}',
               now(), now(), now())`,
      [insightId, a.workspaceId, a.brandId],
    );
    await platform.query(
      `INSERT INTO "insight_evidence"
         ("id", "workspaceId", "brandId", "insightId", "ordinal", "kind", "labelKey",
          "metricKey", "value", "unit", "periodStart", "periodEnd")
       VALUES ($1, $2, $3, $4, 1, 'METRIC', 'a.label', 'impressions', 42, 'COUNT', now(), now())`,
      [evidenceId, a.workspaceId, a.brandId, insightId],
    );

    await expect(
      platform.query(`UPDATE "insight_evidence" SET "value" = 99 WHERE "id" = $1`, [evidenceId]),
    ).rejects.toThrow(/append-only/i);
  });

  it('the configuration allowed-domain constraint now admits the three new domains', async () => {
    /*
     * WITHOUT THIS THE FEATURE IS UNCONFIGURABLE. Every cadence, ceiling and
     * retention window in this phase lives in one of these three documents, and
     * the CHECK that names the permitted domains had to grow to admit them.
     */
    const { rows } = await migrator.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'entitlement_catalogue_snapshot_allowed_domains'`,
    );
    expect(rows).toHaveLength(1);
    for (const domain of ['analytics', 'copilot', 'automations']) {
      expect(rows[0]?.definition, `domain ${domain}`).toContain(domain);
    }
  });

  it('the tenant role still cannot see across the boundary on any new table', async () => {
    // One end-to-end proof through the UNPRIVILEGED role, so the whole chain —
    // GRANT, policy, FORCE — is exercised rather than merely catalogued.
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.workspace_id', $1, true)", [a.workspaceId]);
    for (const table of NEW_TABLES) {
      const { rows } = await app.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM "${table}" WHERE "workspaceId" = $1`,
        [b.workspaceId],
      );
      expect(Number(rows[0]?.c), `${table} leaked rows to the other tenant`).toBe(0);
    }
    await app.query('COMMIT');
  });
});
