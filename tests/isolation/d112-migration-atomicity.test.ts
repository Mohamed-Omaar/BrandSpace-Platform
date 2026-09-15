import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * THE MIGRATION'S FAILURE PATH — D-113.
 *
 * `20260915234500` lifts FORCE ROW LEVEL SECURITY on six tables so its
 * pre-flight can see real rows, and restores it at the end. Between those two
 * points the migrator can read every tenant's rows outside RLS, which is fine
 * for the duration of one transaction and a tenant-isolation REGRESSION if the
 * migration dies halfway.
 *
 * PRISMA DOES NOT WRAP A MIGRATION FILE IN A TRANSACTION. It applies the
 * statements one at a time — which is what lets an earlier migration add an
 * enum value and use it in the same file — so atomicity has to be asked for
 * with an explicit `BEGIN`/`COMMIT`. `20260914200000` §0 records this, and the
 * first draft of `20260915234500` was written without it while its own comments
 * claimed a RAISE would "leave the database exactly as it was". It would not
 * have: the `NO FORCE` statements would have committed individually.
 *
 * SO THIS SUITE MAKES THE MIGRATION FAIL ON PURPOSE and asks the catalogue what
 * survived. It is the only assertion that can tell a migration which is atomic
 * from one which merely says it is.
 *
 * The database it creates is dropped afterwards.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const migrationsDir = path.join(repoRoot, 'packages', 'database', 'prisma', 'migrations');

/** The migration under test. Everything before it is the "before" state. */
const MIGRATION = '20260915234500_d112_credit_and_ai_composite_foreign_keys';

/** Every table it lifts FORCE on. */
const GUARDED = [
  'credit_wallet',
  'credit_transaction',
  'credit_grant',
  'credit_reservation',
  'ai_request',
  'ai_usage_ledger',
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

/**
 * Apply one migration exactly as Prisma does: statement by statement, stopping
 * at the first error. Any all-or-nothing behaviour therefore comes from the
 * `BEGIN`/`COMMIT` inside the FILE, never from this runner — which is the whole
 * point of putting it there.
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

/** ENABLE and FORCE, straight from the catalogue. */
async function rlsState(
  client: Client,
): Promise<Record<string, { enabled: boolean; forced: boolean }>> {
  const { rows } = await client.query<{ relname: string; enabled: boolean; forced: boolean }>(
    `SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
       FROM pg_class
      WHERE relname = ANY($1::text[])`,
    [[...GUARDED]],
  );
  return Object.fromEntries(rows.map((r) => [r.relname, { enabled: r.enabled, forced: r.forced }]));
}

describe('the D-112 migration is atomic, including on its own failure path', () => {
  const database = `bs_d112_atomic_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Client;
  let migratorUrl: string;
  let migrator: Client;

  beforeAll(async () => {
    admin = await connect(urlFor('migrator', 'postgres'));
    await admin.query(`CREATE DATABASE "${database}"`);
    migratorUrl = urlFor('migrator', database);

    // Everything up to, but not including, the migration under test.
    for (const name of migrationNames()) {
      if (name === MIGRATION) break;
      applyMigration(migratorUrl, name);
    }
    migrator = await connect(migratorUrl);
  }, 240_000);

  afterAll(async () => {
    await migrator?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.end();
    }
  }, 60_000);

  it('starts from a state where every guarded table is ENABLE + FORCE', async () => {
    const before = await rlsState(migrator);
    for (const table of GUARDED) {
      expect(before[table], `${table} must exist before the migration`).toBeDefined();
      expect(before[table], `${table} before the migration`).toEqual({
        enabled: true,
        forced: true,
      });
    }
  });

  it('REFUSES when an offending row exists, and leaves FORCE RLS intact', async () => {
    /*
     * An offending row of exactly the shape the pre-flight looks for: a credit
     * transaction in workspace A naming workspace B's wallet. It is written as
     * the MIGRATOR with FORCE lifted, because the plain key this migration
     * replaces is what allowed it in the first place — the point is the
     * migration's behaviour, not how the row got there.
     */
    const wsA = randomUUID();
    const wsB = randomUUID();
    await migrator.query('ALTER TABLE "workspace" NO FORCE ROW LEVEL SECURITY');
    await migrator.query('ALTER TABLE "credit_wallet" NO FORCE ROW LEVEL SECURITY');
    await migrator.query('ALTER TABLE "credit_transaction" NO FORCE ROW LEVEL SECURITY');
    await migrator.query('ALTER TABLE "user" NO FORCE ROW LEVEL SECURITY');
    for (const [id, slug] of [
      [wsA, 'atomic-a'],
      [wsB, 'atomic-b'],
    ] as const) {
      const ownerId = randomUUID();
      await migrator.query(
        `INSERT INTO "user" ("id","email","updatedAt") VALUES ($1::uuid,$2,now())`,
        [ownerId, `${slug}-${database.slice(-6)}@example.local`],
      );
      // `workspace` carries its own `workspaceId` so RLS can be uniform.
      await migrator.query(
        `INSERT INTO "workspace" ("id","workspaceId","slug","name","ownerUserId","updatedAt")
         VALUES ($1::uuid,$1::uuid,$2,$3,$4::uuid,now())`,
        [id, `${slug}-${database.slice(-6)}`, `Workspace ${slug}`, ownerId],
      );
    }
    await migrator.query('ALTER TABLE "user" FORCE ROW LEVEL SECURITY');
    const walletB = randomUUID();
    await migrator.query(
      `INSERT INTO "credit_wallet" ("id","workspaceId","updatedAt") VALUES ($1::uuid,$2::uuid,now())`,
      [walletB, wsB],
    );
    const walletA = randomUUID();
    await migrator.query(
      `INSERT INTO "credit_wallet" ("id","workspaceId","updatedAt") VALUES ($1::uuid,$2::uuid,now())`,
      [walletA, wsA],
    );
    // The cross-workspace row. Only possible because the key is still plain.
    await migrator.query(
      `INSERT INTO "credit_transaction"
         ("id","workspaceId","walletId","type","amountMilliCredits","balanceAfterMilliCredits",
          "reason","idempotencyKey","actorType","occurredAt")
       VALUES (gen_random_uuid(),$1::uuid,$2::uuid,'PLAN_GRANT',1,1,'atomicity probe',$3,'SYSTEM',now())`,
      [wsA, walletB, `atomic-${randomUUID()}`],
    );
    await migrator.query('ALTER TABLE "workspace" FORCE ROW LEVEL SECURITY');
    await migrator.query('ALTER TABLE "credit_wallet" FORCE ROW LEVEL SECURITY');
    await migrator.query('ALTER TABLE "credit_transaction" FORCE ROW LEVEL SECURITY');

    // The migration must refuse.
    let refused = false;
    try {
      applyMigration(migratorUrl, MIGRATION);
    } catch (error: unknown) {
      refused = true;
      const output = String((error as { stderr?: unknown }).stderr ?? error);
      expect(output).toContain('credit_transaction.walletId');
      // Counts, never identifiers.
      expect(output).not.toContain(walletB);
      expect(output).not.toContain(wsA);
    }
    expect(refused, 'the migration must refuse while an offending row exists').toBe(true);

    /*
     * THE ASSERTION THAT MATTERS. Without the explicit transaction, the six
     * `NO FORCE` statements would each have committed before the pre-flight
     * raised, leaving every one of these tables readable by its owner outside
     * RLS — a tenant-isolation regression introduced by a tenant-isolation fix,
     * and one no later migration could repair.
     */
    const after = await rlsState(migrator);
    for (const table of GUARDED) {
      expect(after[table], `${table} after the FAILED migration`).toEqual({
        enabled: true,
        forced: true,
      });
    }

    // And nothing else was left behind: no new constraint, no new index.
    const { rows: constraints } = await migrator.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'credit_transaction_wallet_fkey'`,
    );
    expect(constraints).toEqual([]);
    const { rows: indexes } = await migrator.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'credit_wallet_workspaceId_id_key'`,
    );
    expect(indexes).toEqual([]);
  }, 120_000);

  it('APPLIES once the offending row is resolved, and FORCE is restored', async () => {
    // Resolve the offence the way an operator would: by dealing with the row,
    // not by having the migration delete it. `credit_transaction` is
    // append-only, so its trigger is lifted for this cleanup exactly as the
    // retention path would.
    await migrator.query('ALTER TABLE "credit_transaction" NO FORCE ROW LEVEL SECURITY');
    await migrator.query('ALTER TABLE "credit_transaction" DISABLE TRIGGER USER');
    await migrator.query(`DELETE FROM "credit_transaction" WHERE "reason" = 'atomicity probe'`);
    await migrator.query('ALTER TABLE "credit_transaction" ENABLE TRIGGER USER');
    await migrator.query('ALTER TABLE "credit_transaction" FORCE ROW LEVEL SECURITY');

    applyMigration(migratorUrl, MIGRATION);

    const after = await rlsState(migrator);
    for (const table of GUARDED) {
      expect(after[table], `${table} after the SUCCESSFUL migration`).toEqual({
        enabled: true,
        forced: true,
      });
    }

    const { rows } = await migrator.query<{ conname: string; definition: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint WHERE conname = 'credit_transaction_wallet_fkey'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.definition).toContain('"workspaceId", "walletId"');
  }, 120_000);
});
