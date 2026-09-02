import type { PrismaClient } from '@prisma/client';
import { getPlatformPrisma } from './platform-pool';

/**
 * Narrow, server-only accessor for the platform database client.
 *
 * WHY THIS EXISTS: the Control Center needs a platform-scoped Prisma client, but
 * `packages/database` is the only package permitted to import `@prisma/client`
 * (docs/ARCHITECTURE.md §4.1). Rather than punching a hole in that rule for
 * apps/admin, the client is constructed here and handed out through one function.
 *
 * ACCESS IS RESTRICTED. An ESLint rule allows this module to be imported only by
 * apps/admin and apps/api — the two server-side surfaces that run platform
 * operations. The public website, the customer dashboard, ordinary workers and
 * every tenant-facing package are refused (F-07).
 *
 * The underlying pool carries its own browser guard and fails closed when
 * DATABASE_PLATFORM_URL is absent, so a misconfigured process can do nothing.
 */
export function getPlatformClient(repoRoot?: string): PrismaClient {
  return getPlatformPrisma(repoRoot);
}

export type { PrismaClient as PlatformPrismaClient };
