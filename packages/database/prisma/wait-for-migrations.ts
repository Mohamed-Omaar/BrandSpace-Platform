/**
 * WAIT, BEFORE A RELEASE STARTS, UNTIL THE DATABASE HOLDS EVERY MIGRATION THIS
 * BUILD NEEDS — the Railway PRE-DEPLOY command of dashboard, admin, api and
 * worker (docs/RAILWAY-DEPLOYMENT.md §4.5, GO-LIVE-RUNBOOK §4).
 *
 * THE RACE IT CLOSES. Every service deploys from the same commit at the same
 * time as the `migration` job. Each new release reports ready only once its
 * migrations are applied (the readiness gate, §4.4) — but Railway starts the
 * healthcheck clock (300 s) as soon as the container starts, so when the
 * migration job is still building, or its migrations take long, the release is
 * marked FAILED and has to be redeployed by hand. On the #80 deploy admin lost
 * that race.
 *
 * A PRE-DEPLOY COMMAND runs after the build and before the new deployment
 * starts, with the service's own variables and private network; the
 * healthcheck clock starts only after it succeeds, and if it fails the
 * deployment does not proceed and the previous release keeps serving. So this
 * waits HERE, where waiting costs nothing.
 *
 * IT NEVER MIGRATES. It reads `_prisma_migrations` with the service's OWN
 * runtime credential (`DATABASE_URL`, which may only SELECT that table —
 * migration 20261005090000), so the migrator credential stays on the migration
 * job alone. It logs migration NAMES only, never a URL or a credential.
 *
 * Bounded: `WAIT_FOR_MIGRATIONS_TIMEOUT_SECONDS` (default 1800). Past it, it
 * exits 1 naming what is still pending, the deployment stops, and nothing is
 * lost — redeploy once the migration job has finished.
 */
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { schemaReadinessFrom, type SchemaReadiness } from '../src/schema-readiness';

export interface WaitForMigrationsOptions {
  readonly read: () => Promise<SchemaReadiness>;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

/** True once ready; false when the deadline passes first. Never throws for a read error. */
export async function waitForMigrations(options: WaitForMigrationsOptions): Promise<boolean> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const intervalMs = options.intervalMs ?? 5_000;
  const deadline = now() + options.timeoutMs;
  let lastPending = '';
  for (;;) {
    try {
      const readiness = await options.read();
      if (readiness.ready) {
        log('wait-for-migrations: every migration this build needs is applied');
        return true;
      }
      const pending = readiness.pending.join(', ');
      if (pending !== lastPending) {
        log(`wait-for-migrations: waiting for ${readiness.pending.length}: ${pending}`);
        lastPending = pending;
      }
    } catch {
      // Unreachable or no history table yet: "could not tell" is "not yet".
      if (lastPending !== '(database not answering)') {
        log('wait-for-migrations: the database is not answering yet');
        lastPending = '(database not answering)';
      }
    }
    if (now() >= deadline) {
      log(`wait-for-migrations: gave up after ${Math.round(options.timeoutMs / 1000)} s`);
      return false;
    }
    await sleep(intervalMs);
  }
}

/** The timeout from the environment: a positive whole number of seconds, default 1800. */
export function timeoutSecondsFrom(value: string | undefined): number {
  const parsed = Number(value ?? '');
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1_800;
}

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL']?.trim();
  if (!connectionString) {
    console.error('wait-for-migrations: DATABASE_URL is required');
    process.exit(1);
  }
  const read = async (): Promise<SchemaReadiness> => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
    try {
      await client.connect();
      const result = await client.query<{ migration_name: string }>(
        `SELECT "migration_name" FROM "_prisma_migrations"
          WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
      );
      return schemaReadinessFrom(result.rows.map((row) => row.migration_name));
    } finally {
      await client.end().catch(() => undefined);
    }
  };
  const ready = await waitForMigrations({
    read,
    timeoutMs: timeoutSecondsFrom(process.env['WAIT_FOR_MIGRATIONS_TIMEOUT_SECONDS']) * 1_000,
  });
  process.exit(ready ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
