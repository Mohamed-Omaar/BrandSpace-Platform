import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPrismaClient,
  EXPECTED_MIGRATIONS,
  getPrisma,
  readSchemaReadiness,
  type PrismaClient,
} from '@brandspace/database';
import { buildServer } from '../../apps/api/src/server';

/**
 * THE MIGRATION READINESS GATE ON REAL POSTGRESQL (docs/RAILWAY-DEPLOYMENT.md §4.4).
 *
 * The global setup ran `prisma migrate deploy`, so this database is exactly
 * what `migration-staging` leaves behind: every migration recorded in
 * `_prisma_migrations`, including `20261005090000_runtime_roles_read_migration_history`.
 * Each runtime identity must be able to answer "is the schema current?" and
 * neither may change the answer.
 */

let platform: PrismaClient;
let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  const url = process.env['DATABASE_PLATFORM_URL'];
  if (!url) throw new Error('DATABASE_PLATFORM_URL is required for the isolation suite');
  platform = createPrismaClient({ connectionString: url, maxConnections: 2 });
  server = await buildServer();
});

afterAll(async () => {
  await server?.close();
  await platform?.$disconnect();
});

describe('each runtime role reads the migration history', () => {
  it('the tenant role (api, worker, dashboard) sees a current schema', async () => {
    expect(await readSchemaReadiness(getPrisma())).toEqual({ ready: true, pending: [] });
  });

  it('the platform role (Control Center) sees a current schema', async () => {
    expect(await readSchemaReadiness(platform)).toEqual({ ready: true, pending: [] });
  });

  it('a build that expects a migration the database does not have is not ready', async () => {
    const expected = [...EXPECTED_MIGRATIONS, '29991231000000_not_applied_yet'];
    expect(await readSchemaReadiness(getPrisma(), expected)).toEqual({
      ready: false,
      pending: ['29991231000000_not_applied_yet'],
    });
  });
});

describe('neither runtime role can change the answer', () => {
  /*
   * A runtime identity that could insert a history row could make a release
   * report ready over a schema it does not have — or, deleting one, hold every
   * deployment back for ever.
   */
  it.each([
    ['tenant', () => getPrisma()],
    ['platform', () => platform],
  ])('the %s role may not insert, update or delete a history row', async (_name, client) => {
    const db = client();
    await expect(
      db.$executeRaw`INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "started_at", "applied_steps_count")
                     VALUES (gen_random_uuid()::text, 'x', '29991231000000_forged', now(), 1)`,
    ).rejects.toThrow(/permission denied/i);
    await expect(
      db.$executeRaw`UPDATE "_prisma_migrations" SET "rolled_back_at" = now()`,
    ).rejects.toThrow(/permission denied/i);
    await expect(db.$executeRaw`DELETE FROM "_prisma_migrations"`).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe("the api's /health/ready carries the schema check", () => {
  it('answers ready with `schema: ok` once every migration is applied, and no migration name', async () => {
    const response = await server.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { checks: { name: string; state: string }[] };
    expect(body.checks).toEqual(
      expect.arrayContaining([
        { name: 'database', state: 'ok' },
        { name: 'schema', state: 'ok' },
      ]),
    );
    expect(response.body).not.toContain('20261005090000');
  });
});
