import path from 'node:path';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma CLI configuration (Prisma 7 moves connection URLs out of the schema).
 *
 * Migrations run as the MIGRATOR role, which owns the schema. The application role
 * used at runtime is a different, lower-privileged role that cannot bypass RLS —
 * see packages/database/src/client.ts and docs/SECURITY.md §2.2.
 */
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_MIGRATION_URL'),
  },
});
