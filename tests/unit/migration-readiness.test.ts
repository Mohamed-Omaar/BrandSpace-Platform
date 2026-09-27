import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_MIGRATIONS,
  probeDatabaseReadiness,
  schemaReadinessFrom,
  waitForSchema,
  type RawQueryClient,
} from '@brandspace/database';

/**
 * THE MIGRATION READINESS GATE (docs/RAILWAY-DEPLOYMENT.md §4.4).
 *
 * When PR #47 merged, the api, worker and dashboard went live about ninety
 * seconds before `migration-staging` finished, and every publishing and
 * automation sweep failed until it had. These are the rules that stop that as
 * rules; the database half (the grants, and the check reading a real history
 * table as each runtime role) is `tests/isolation/migration-readiness.test.ts`.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const migrationsDir = path.join(root, 'packages/database/prisma/migrations');

function folders(): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** A client whose history table holds `applied`, or which fails. */
function historyClient(applied: string[] | Error, delayMs = 0): RawQueryClient {
  return {
    $queryRaw: <T>() =>
      new Promise<T>((resolve, reject) => {
        setTimeout(() => {
          if (applied instanceof Error) reject(applied);
          else resolve(applied.map((migration_name) => ({ migration_name })) as T);
        }, delayMs);
      }),
  };
}

describe('the manifest is exactly the migration folders', () => {
  it('lists every folder, in the order Prisma applies them — run `pnpm db:manifest` when this fails', () => {
    expect([...EXPECTED_MIGRATIONS]).toEqual(folders());
  });
});

describe('the decision', () => {
  const expected = ['a_first', 'b_second', 'c_third'];

  it('is ready when every expected migration has finished', () => {
    expect(schemaReadinessFrom(expected, expected)).toEqual({ ready: true, pending: [] });
  });

  it('is not ready while any is missing, and names the missing ones in order', () => {
    expect(schemaReadinessFrom(['a_first'], expected)).toEqual({
      ready: false,
      pending: ['b_second', 'c_third'],
    });
    expect(schemaReadinessFrom([], expected).ready).toBe(false);
  });

  it('is ready on a NEWER database — a code rollback must not become an outage', () => {
    expect(schemaReadinessFrom([...expected, 'd_from_the_next_release'], expected)).toEqual({
      ready: true,
      pending: [],
    });
  });
});

describe('the probe', () => {
  it('reports ok / ok when the history holds everything', async () => {
    const probe = await probeDatabaseReadiness(historyClient(['m1', 'm2']), {
      expected: ['m1', 'm2'],
    });
    expect(probe).toMatchObject({ database: 'ok', schema: 'ok', ready: true, pending: [] });
  });

  it('reports the schema pending while a migration is missing', async () => {
    const probe = await probeDatabaseReadiness(historyClient(['m1']), { expected: ['m1', 'm2'] });
    expect(probe).toMatchObject({
      database: 'ok',
      schema: 'pending',
      ready: false,
      pending: ['m2'],
    });
  });

  it('never throws: an unreadable database is down and the schema unknown', async () => {
    const probe = await probeDatabaseReadiness(historyClient(new Error('connection refused')), {
      expected: ['m1'],
    });
    expect(probe).toMatchObject({ database: 'down', schema: 'unknown', ready: false });
  });

  it('is bounded: a database slower than the deadline is down, not a hung probe', async () => {
    const probe = await probeDatabaseReadiness(historyClient(['m1'], 200), {
      expected: ['m1'],
      deadlineMs: 20,
    });
    expect(probe).toMatchObject({ database: 'down', ready: false });
  });
});

describe('the wait for background work', () => {
  it('keeps asking until the schema is current, reporting each pass', async () => {
    const answers = [
      { ready: false, pending: ['m2', 'm3'] },
      { ready: false, pending: ['m3'] },
      { ready: true, pending: [] },
    ];
    const waiting: number[] = [];
    const slept: number[] = [];
    const current = await waitForSchema({
      read: async () => answers.shift() ?? { ready: true, pending: [] },
      onWaiting: ({ pending }) => waiting.push(pending.length),
      intervalMs: 7,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(current).toBe(true);
    expect(waiting).toEqual([2, 1]);
    expect(slept).toEqual([7, 7]);
  });

  it('treats a failed read as "not yet", never as ready', async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const current = await waitForSchema({
      read: async () => {
        calls += 1;
        if (calls === 1) throw new Error('relation "_prisma_migrations" does not exist');
        return { ready: true, pending: [] };
      },
      onWaiting: ({ error }) => errors.push(error),
      sleep: async () => {},
    });
    expect(current).toBe(true);
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
  });

  it('stops when the process is shutting down, reporting that it never became current', async () => {
    const stopping = new AbortController();
    const current = await waitForSchema({
      read: async () => ({ ready: false, pending: ['m1'] }),
      signal: stopping.signal,
      sleep: async () => {
        stopping.abort();
      },
    });
    expect(current).toBe(false);
  });
});

describe('every application service is gated', () => {
  it('api: /health/ready carries a required schema check, and the sweeps start only after the wait', () => {
    const health = read('apps/api/src/routes/health.ts');
    expect(health).toContain('probeDatabaseReadiness(getPrisma())');
    expect(health).toContain("name: 'schema'");

    const server = read('apps/api/src/server.ts');
    const listen = server.indexOf('await app.listen(');
    const wait = server.indexOf('await waitForSchema(');
    const start = server.indexOf('await scheduler.start()');
    expect(listen).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(listen);
    expect(start).toBeGreaterThan(wait);
    expect(server).toContain('if (!current) return;');
  });

  it('worker: the health server listens first and no queue is consumed before the wait', () => {
    const main = read('apps/worker/src/main.ts');
    const listen = main.indexOf("health.listen(port, '0.0.0.0')");
    const wait = main.indexOf('await waitForSchema(');
    const firstConsumer = main.indexOf('new Worker(');
    expect(listen).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(listen);
    expect(firstConsumer).toBeGreaterThan(wait);
    expect(main).toContain("'waiting_for_migrations'");
  });

  it.each([
    ['dashboard', 'getPrisma()'],
    ['admin', 'getPlatformClient()'],
  ])(
    '%s: /api/health/ready answers 503 until ready, outside the locale redirect',
    (app, client) => {
      const route = read(`apps/${app}/src/app/api/health/ready/route.ts`);
      expect(route).toContain(`probeDatabaseReadiness(${client})`);
      expect(route).toContain('status: probe.ready ? 200 : 503');
      expect(route).not.toContain('probe.pending,');

      const middleware = read(`apps/${app}/src/middleware.ts`);
      expect(middleware).toContain("if (pathname.startsWith('/api/')) return secured(request);");
    },
  );
});

describe('the grant migration', () => {
  const sql = read(
    'packages/database/prisma/migrations/20261005090000_runtime_roles_read_migration_history/migration.sql',
  );

  it('lets both runtime roles read the history and write none of it', () => {
    expect(sql).toContain(
      'GRANT SELECT ON TABLE public."_prisma_migrations" TO brandspace_app, brandspace_platform',
    );
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ');
    expect(sql).toContain("RAISE EXCEPTION 'the runtime roles must read _prisma_migrations");
  });

  it('changes privileges only — nothing a live previous release could notice', () => {
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(
      /\b(ALTER TABLE|CREATE TABLE|DROP|INSERT INTO|UPDATE "|DELETE FROM)\b/,
    );
  });
});
