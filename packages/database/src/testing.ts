/**
 * Test-only helpers. Exported from a separate entrypoint so application code
 * cannot import them by accident.
 */
import { createPrismaClient, type PrismaClient } from './client';

/** A client bound to the APPLICATION role — the role isolation tests must use. */
export function createAppRoleClient(): PrismaClient {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required for tests.');
  return createPrismaClient({ connectionString: url });
}

/**
 * Assert the test database connection is NOT a superuser and cannot bypass RLS.
 * Running the isolation suite as a privileged role would make every assertion
 * vacuous, so the suite refuses to run in that case.
 */
export async function assertConnectionCannotBypassRls(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<
    { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;

  const role = rows[0];
  if (!role) throw new Error('Could not resolve the current database role.');
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `Isolation tests must run as a non-superuser role with NOBYPASSRLS. ` +
        `Current role "${role.rolname}" has rolsuper=${role.rolsuper}, ` +
        `rolbypassrls=${role.rolbypassrls}. The suite would prove nothing.`,
    );
  }
}
