import path from 'node:path';
import { defineConfig } from 'prisma/config';
import { loadRepoEnv, requireDatabaseUrl } from './src/env-file';

/**
 * Prisma CLI configuration (Prisma 7 moved connection URLs out of the schema).
 *
 * TWO PROPERTIES THIS FILE MUST HAVE, and why it is written this way:
 *
 *  1. `prisma generate` must work in a COMPLETELY CLEAN ENVIRONMENT. Client
 *     generation reads the schema and writes TypeScript; it never opens a
 *     connection, so requiring a database URL for it is simply wrong. The
 *     previous version called `env('DATABASE_MIGRATION_URL')` at module load,
 *     which resolves EAGERLY and throws when unset — breaking `generate` on any
 *     clean checkout, and with it three CI jobs.
 *
 *  2. Commands that DO connect must FAIL CLOSED, with an actionable error naming
 *     the missing variable — never a silent fallback to some default database,
 *     and never the variable's value.
 *
 * Migrations connect as the MIGRATOR role, which owns the schema. The runtime
 * application role is a different, lower-privileged role that cannot bypass RLS.
 * See packages/database/src/client.ts and docs/SECURITY.md §2.2.
 */

/**
 * Prisma subcommands that open a database connection. Everything else —
 * generate, validate, format, version, init — is offline and must not require
 * any environment at all.
 */
const SUBCOMMANDS_REQUIRING_DATABASE = new Set(['migrate', 'db', 'studio', 'introspect']);

function commandNeedsDatabase(): boolean {
  // argv[0] is node, argv[1] the Prisma CLI entrypoint, argv[2] the subcommand.
  const subcommand = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
  // An unknown or absent subcommand is treated as offline. A command that truly
  // needs a connection still fails loudly at connect time; this only decides
  // whether THIS FILE demands the variable up front.
  return subcommand !== undefined && SUBCOMMANDS_REQUIRING_DATABASE.has(subcommand);
}

function migrationDatasourceUrl(): string {
  loadRepoEnv(path.resolve(import.meta.dirname, '..', '..'));
  return requireDatabaseUrl(
    ['DATABASE_MIGRATION_URL', 'DATABASE_URL'],
    'this Prisma command connects to the database',
  );
}

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
  // `datasource` is optional and, per Prisma's own typing, "required for
  // migration / introspection commands". Omitting it for offline commands is
  // exactly what lets `generate` run with no environment at all.
  ...(commandNeedsDatabase() ? { datasource: { url: migrationDatasourceUrl() } } : {}),
});
