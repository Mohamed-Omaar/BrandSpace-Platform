import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '@brandspace/shared';
import { getPrisma } from './client';

/**
 * Tenant-scoped data access — the ONLY supported way for application code to read
 * or write customer data.
 *
 * docs/ARCHITECTURE.md §6. Every call runs inside a transaction that begins by
 * setting `app.workspace_id`, so the PostgreSQL RLS policies apply to everything
 * in the callback — including raw SQL. The tenant predicate is therefore enforced
 * by the database, not by remembering to write a `where` clause.
 */

/** The client handed to a scoped callback. Identical surface to PrismaClient. */
export type TenantScopedClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

export interface TenantContext {
  readonly workspaceId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidWorkspaceId(workspaceId: string): void {
  if (!UUID_PATTERN.test(workspaceId)) {
    // Fail closed: an unparseable tenant key must never reach the GUC, where a
    // cast failure or an empty string could widen visibility.
    throw new AppError('TENANT_CONTEXT_MISSING', `Invalid workspace id: ${workspaceId}`);
  }
}

export interface WithWorkspaceOptions {
  /** Overrides the client, for tests and for callers holding their own pool. */
  readonly prisma?: PrismaClient;
  readonly timeoutMs?: number;
}

/**
 * Run `fn` with the tenant context bound to `workspaceId`.
 *
 * The context is transaction-local (`set_config(..., true)`), so it is released
 * when the transaction ends and cannot leak across pooled connections.
 */
export async function withWorkspace<T>(
  workspaceId: string,
  fn: (db: TenantScopedClient) => Promise<T>,
  options: WithWorkspaceOptions = {},
): Promise<T> {
  assertValidWorkspaceId(workspaceId);
  const prisma = options.prisma ?? getPrisma();

  return prisma.$transaction(
    async (tx) => {
      // Parameterised: the workspace id is never interpolated into SQL text.
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return fn(tx as unknown as TenantScopedClient);
    },
    { timeout: options.timeoutMs ?? 15_000 },
  );
}

/**
 * Authentication-only access, with NO workspace context.
 *
 * Needed because a login must resolve a user by email before any workspace is
 * known. Under this context the `user` RLS policy allows lookup, while every
 * strictly tenant-owned table returns zero rows — `workspace_id = NULL` is never
 * true. Do not use this for anything but authentication.
 *
 * This runs on the TENANT pool. It grants no cross-tenant access: the tenant
 * role is not named by any platform policy, so there is nothing to escalate to.
 */
export async function withoutTenantContext<T>(
  fn: (db: TenantScopedClient) => Promise<T>,
  options: WithWorkspaceOptions = {},
): Promise<T> {
  const prisma = options.prisma ?? getPrisma();
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', '', true)`;
      return fn(tx as unknown as TenantScopedClient);
    },
    { timeout: options.timeoutMs ?? 15_000 },
  );
}

export type { Prisma };
