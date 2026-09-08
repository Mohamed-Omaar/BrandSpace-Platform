import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * A short-lived PLATFORM connection for end-to-end housekeeping.
 *
 * The E2E suite drives the product through a browser and asserts on what it
 * sees; it does not read the database to make assertions, and this is not a way
 * to start. Its one job is CLEANUP (F-53): a secret created through the form
 * has no id the browser can hand back, so removing it afterwards needs a
 * connection.
 *
 * Opened and closed around each use rather than held for the run. A pooled
 * client living for the whole suite competes with the three application servers
 * for connections, and the work here is a handful of statements at teardown.
 */
export async function withPlatformPrisma<T>(fn: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) {
    throw new Error(
      'DATABASE_PLATFORM_URL is required for end-to-end cleanup: the rows are platform-owned.',
    );
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
