/**
 * A FRESH PROCESS for `tests/isolation/pr-a2-pg-serial.test.ts`. Node prints a
 * deprecation once per process, so each mode runs in its own: it opens a
 * transaction, sends five queries on its one connection at once, prints their
 * results as JSON on stdout and exits. pg's warning, if any, lands on stderr.
 *
 *   raw     — a plain pg.Pool: the warning the fix exists for (the control);
 *   serial  — `createSerialPool`;
 *   prisma  — the product's own client: `withWorkspace` with `Promise.all` and a
 *             read whose relations Prisma loads concurrently.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type pgTypes from 'pg';
import { createPrismaClient, createSerialPool, withWorkspace } from '@brandspace/database';

// `pg` is a dependency of the database package, not of the repository root:
// resolve it from there, as the product does (the child runs at the repo root).
const pg = createRequire(path.resolve('packages/database/package.json'))('pg') as typeof pgTypes;

async function viaPool(pool: pgTypes.Pool): Promise<number[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        client.query<{ n: number }>('SELECT pg_sleep(0.02), $1::int AS n', [n]),
      ),
    );
    await client.query('COMMIT');
    return rows.map((result) => result.rows[0]?.n ?? -1);
  } finally {
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const connectionString = process.env['DATABASE_URL'] ?? '';
  let out: unknown;
  if (mode === 'raw') out = await viaPool(new pg.Pool({ connectionString, max: 1 }));
  else if (mode === 'serial') out = await viaPool(createSerialPool({ connectionString, max: 1 }));
  else {
    const prisma = createPrismaClient({ connectionString, maxConnections: 1 });
    out = await withWorkspace(
      process.argv[3] ?? '',
      async (db) =>
        Promise.all([
          db.brand.count(),
          // One Prisma call whose relations the query engine loads concurrently
          // on the transaction's single connection: where the warning came from.
          db.contentItem.findMany({
            take: 5,
            include: { variants: true, approvals: true, calendarSlots: true, publishJobs: true },
          }),
          db.$queryRaw`SELECT 1 AS one`,
          db.brand.findMany({ take: 1, select: { id: true } }),
        ]).then((results) => results.length),
      { prisma },
    );
    await prisma.$disconnect();
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`FAILED ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
