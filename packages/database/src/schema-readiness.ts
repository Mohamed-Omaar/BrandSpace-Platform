import { EXPECTED_MIGRATIONS } from './migration-manifest';

/**
 * IS THE DATABASE AT LEAST AS NEW AS THIS RELEASE? (docs/RAILWAY-DEPLOYMENT.md §4.4)
 *
 * WHY THIS EXISTS. Migrations run as a separate job (`migration-staging`, §4.1)
 * and nothing made the application services wait for it. When PR #47 merged,
 * the api, worker and dashboard went live about ninety seconds before the job
 * finished; every publishing and automation sweep in that window failed with
 * "column `deletionScheduledFor` does not exist", and every dashboard request
 * that resolved a session would have too.
 *
 * WHAT "READY" MEANS. Every migration this build was made with
 * (`EXPECTED_MIGRATIONS`) is recorded in `_prisma_migrations` as finished and
 * not rolled back. A migration that is still running, or failed half-way, has
 * no `finished_at`, so it counts as pending.
 *
 * A NEWER DATABASE IS READY. Migrations the database has and this build does
 * not know are ignored, never a reason to refuse: that is exactly the state of
 * a code rollback (Railway reverts code, not schema — §4.2), and every migration
 * here is written to be compatible with the release before it. Refusing it
 * would turn a rollback into an outage.
 *
 * NOTHING HERE WRITES, and the runtime roles cannot: they hold SELECT on the
 * history table and nothing else (migration
 * `20261005090000_runtime_roles_read_migration_history`).
 */
export interface SchemaReadiness {
  readonly ready: boolean;
  /**
   * The migrations this build expects that the database has not finished.
   * OPERATOR DETAIL — logged, never put in a public response.
   */
  readonly pending: readonly string[];
}

/** The pure decision, separated so it can be tested without a database. */
export function schemaReadinessFrom(
  applied: Iterable<string>,
  expected: readonly string[] = EXPECTED_MIGRATIONS,
): SchemaReadiness {
  const done = new Set(applied);
  const pending = expected.filter((name) => !done.has(name));
  return { ready: pending.length === 0, pending };
}

/** Anything that can run a raw query — the tenant and the platform clients both can. */
export interface RawQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<T>;
}

/**
 * Read the history table and decide. Throws when the database cannot be read at
 * all (unreachable, or no history table yet); the callers turn that into "not
 * ready", which is the only safe reading of "could not tell".
 */
export async function readSchemaReadiness(
  client: RawQueryClient,
  expected: readonly string[] = EXPECTED_MIGRATIONS,
): Promise<SchemaReadiness> {
  const rows = await client.$queryRaw<{ migration_name: string }[]>`
    SELECT "migration_name"
      FROM "_prisma_migrations"
     WHERE "finished_at" IS NOT NULL
       AND "rolled_back_at" IS NULL`;
  return schemaReadinessFrom(
    rows.map((row) => row.migration_name),
    expected,
  );
}

/** What a readiness endpoint reports: two named states, no detail. */
export interface DatabaseReadinessProbe {
  readonly database: 'ok' | 'down';
  /** `unknown` when the database could not be asked at all. */
  readonly schema: 'ok' | 'pending' | 'unknown';
  readonly ready: boolean;
  readonly pending: readonly string[];
  readonly latencyMs: number;
}

/**
 * One bounded round trip that answers both questions a readiness endpoint asks:
 * is the database there, and is it new enough for this code.
 *
 * BOUNDED AND NEVER THROWS, for the reason `apps/api/src/routes/health.ts`
 * gives: a readiness endpoint that can hang takes the fleet out when a
 * dependency is slow rather than dead.
 */
export async function probeDatabaseReadiness(
  client: RawQueryClient,
  options: { readonly deadlineMs?: number; readonly expected?: readonly string[] } = {},
): Promise<DatabaseReadinessProbe> {
  const startedAt = Date.now();
  try {
    const readiness = await withDeadline(
      readSchemaReadiness(client, options.expected),
      options.deadlineMs ?? 2_000,
    );
    return {
      database: 'ok',
      schema: readiness.ready ? 'ok' : 'pending',
      ready: readiness.ready,
      pending: readiness.pending,
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    return {
      database: 'down',
      schema: 'unknown',
      ready: false,
      pending: [],
      latencyMs: Date.now() - startedAt,
    };
  }
}

export interface WaitForSchemaOptions {
  /** How to ask. Injected so the wait can be tested without a database. */
  readonly read: () => Promise<SchemaReadiness>;
  /** Called once per pass while waiting — the caller's logger. */
  readonly onWaiting?: (state: { pending: readonly string[]; error?: unknown }) => void;
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Stops waiting (process shutdown). Resolves `false` when it fires. */
  readonly signal?: AbortSignal;
}

/**
 * Wait until the database has every migration this build needs.
 *
 * FOR BACKGROUND WORK, NOT REQUESTS. The api's maintenance scheduler and the
 * worker's queue consumers start only after this resolves `true`; request
 * traffic is held back by the readiness endpoints instead, because Railway
 * routes to a new deployment only once its healthcheck passes.
 *
 * IT WAITS FOR EVER. There is no deadline here on purpose: the deployment's own
 * healthcheck timeout decides when a release that never becomes ready is
 * abandoned, and a background loop that gave up would leave a running process
 * that silently does nothing.
 */
export async function waitForSchema(options: WaitForSchemaOptions): Promise<boolean> {
  const intervalMs = options.intervalMs ?? 5_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    if (options.signal?.aborted) return false;
    try {
      const readiness = await options.read();
      if (readiness.ready) return true;
      options.onWaiting?.({ pending: readiness.pending });
    } catch (error) {
      options.onWaiting?.({ pending: [], error });
    }
    await sleep(intervalMs);
  }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('probe deadline exceeded')), ms).unref?.(),
    ),
  ]);
}
