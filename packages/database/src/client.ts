import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Database connections.
 *
 * TWO ROLES, DELIBERATELY (docs/SECURITY.md §2.2):
 *   - the RUNTIME client connects as the application role, which has NOBYPASSRLS
 *     and owns no table. Row-level security therefore genuinely constrains it.
 *   - migrations connect as the migrator/owner role and never serve a request.
 *
 * Connection pooling must be transaction-scoped: the tenant context is set with
 * `set_config(..., is_local => true)`, so it is bound to the transaction and can
 * never leak onto another tenant's request through a reused connection.
 */

let singleton: PrismaClient | undefined;

export interface DatabaseOptions {
  /** Defaults to DATABASE_URL — the application role. */
  readonly connectionString?: string;
  readonly maxConnections?: number;
}

export function createPrismaClient(options: DatabaseOptions = {}): PrismaClient {
  const connectionString = options.connectionString ?? process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  const adapter = new PrismaPg({
    connectionString,
    max: options.maxConnections ?? 10,
  });
  return new PrismaClient({ adapter });
}

/** Process-wide client. Use `getPrisma()` rather than constructing ad hoc clients. */
export function getPrisma(): PrismaClient {
  singleton ??= createPrismaClient();
  return singleton;
}

export async function disconnectPrisma(): Promise<void> {
  if (singleton) {
    await singleton.$disconnect();
    singleton = undefined;
  }
}

export type { PrismaClient };
/**
 * Re-exported so other packages can use Prisma's sentinel values (DbNull,
 * JsonNull) without importing @prisma/client directly — packages/database
 * remains the only package permitted to do that.
 */
export { Prisma } from '@prisma/client';
