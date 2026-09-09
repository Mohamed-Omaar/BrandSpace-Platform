import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Cross-tenant isolation for the two models Phase 4 adds.
 *
 * The D-29 gate REQUIRES this file. Each model gets the three assertions the
 * earlier phases established — a direct read of B's row from A returns null, a
 * listing from A excludes B entirely, and a write aimed at B is refused — plus
 * the two properties specific to this phase:
 *
 *   - AI SPEND IS COMMERCIALLY SENSITIVE. What a competitor generates, how
 *     often, and what it costs them is exactly the kind of thing a tenant must
 *     never be able to read. The ledger is the table that would leak it.
 *   - THE LEDGER IS APPEND-ONLY IN THE DATABASE. Not by convention, and not
 *     only by a revoked privilege: a trigger refuses UPDATE and DELETE, so a
 *     future migration that re-grants the privilege by accident does not
 *     silently reopen the hole.
 *
 * Everything runs through `withWorkspace()`, so PostgreSQL RLS — not a `where`
 * clause a test remembered to add — is what is being measured.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('AiRequest is tenant-owned', () => {
  it('A cannot read B request by id', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.aiRequest.findUnique({ where: { id: fixtures.b.aiRequestId } }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A cannot read B request by its unique idempotency key', async () => {
    // The unique index is a direct hit if RLS is not applied, so it is asserted
    // separately from the id lookup. It also matters more here than elsewhere:
    // an idempotency key is derived from the caller's own input, so a tenant
    // could plausibly GUESS another tenant's key.
    const other = await withWorkspace(
      fixtures.b.workspaceId,
      async (db) => db.aiRequest.findUniqueOrThrow({ where: { id: fixtures.b.aiRequestId } }),
      { prisma: app },
    );
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.aiRequest.findUnique({ where: { idempotencyKey: other.idempotencyKey } }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it("A's listing excludes B entirely", async () => {
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.aiRequest.findMany(),
      { prisma: app },
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(rows.some((r) => r.id === fixtures.b.aiRequestId)).toBe(false);
  });

  it('A cannot write a request into B', async () => {
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          db.aiRequest.create({
            data: {
              workspaceId: fixtures.b.workspaceId,
              taskKey: 'caption.generate',
              idempotencyKey: `cross-tenant-${Date.now()}`,
              deadlineAt: new Date(Date.now() + 60_000),
            },
          }),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });

  it('A cannot edit B request', async () => {
    const result = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.aiRequest.updateMany({
          where: { id: fixtures.b.aiRequestId },
          data: { status: 'CANCELLED' },
        }),
      { prisma: app },
    );
    expect(result.count).toBe(0);
  });
});

describe('AiUsageLedger is tenant-owned', () => {
  it('A cannot read B ledger row by id', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.aiUsageLedger.findUnique({ where: { id: fixtures.b.aiLedgerId } }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it("A cannot read B's AI spend by any aggregate either", async () => {
    // A count or a sum that crosses the boundary leaks just as surely as a row
    // does — arguably worse, because it looks like a harmless metric. What a
    // competitor spends on AI is exactly what must not be inferable.
    const total = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.aiUsageLedger.aggregate({
          _sum: { creditsChargedMilli: true, providerCostMinor: true },
          _count: true,
        }),
      { prisma: app },
    );
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.aiUsageLedger.findMany(),
      { prisma: app },
    );
    const ownTotal = rows.reduce((sum, r) => sum + r.creditsChargedMilli, 0n);
    expect(total._sum.creditsChargedMilli ?? 0n).toBe(ownTotal);
    expect(total._count).toBe(rows.length);
  });

  it("A's listing excludes B entirely", async () => {
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.aiUsageLedger.findMany(),
      { prisma: app },
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(rows.some((r) => r.id === fixtures.b.aiLedgerId)).toBe(false);
  });

  it('A cannot write a ledger row into B', async () => {
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          db.aiUsageLedger.create({
            data: {
              workspaceId: fixtures.b.workspaceId,
              aiRequestId: fixtures.b.aiRequestId,
              taskKey: 'caption.generate',
              providerKey: 'forged',
              modelKey: 'forged',
              usageUnits: {},
              environment: 'DEVELOPMENT',
            },
          }),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });
});

describe('the AI usage ledger is append-only in the database', () => {
  it('refuses an UPDATE of a tenant its own row', async () => {
    /*
     * NOT a permission test — the tenant owns this row and can read it. The
     * point is that the financial record cannot be rewritten by ANYONE,
     * including its owner: docs/DATABASE.md §6.6 makes corrections new rows.
     * Asserted against the tenant's OWN row so the refusal is the immutability
     * rule rather than RLS quietly doing the work.
     */
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          db.aiUsageLedger.update({
            where: { id: fixtures.a.aiLedgerId },
            data: { creditsChargedMilli: 0n },
          }),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });

  it('refuses a DELETE of a tenant its own row', async () => {
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) => db.aiUsageLedger.delete({ where: { id: fixtures.a.aiLedgerId } }),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });

  it('leaves the row exactly as it was after both refusals', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.aiUsageLedger.findUniqueOrThrow({ where: { id: fixtures.a.aiLedgerId } }),
      { prisma: app },
    );
    expect(row.creditsChargedMilli).toBe(1500n);
  });
});

describe('a query with no workspace context reads nothing', () => {
  // `NULL = <uuid>` is never true, so the absence of context is not a wildcard.
  // Asserted per phase because a new table gets a new policy, and the failure
  // mode — a background job with no context reading every tenant — is silent.
  it.each([['aiRequest'], ['aiUsageLedger']])(
    '%s is empty without a workspace context',
    async (model) => {
      const rows = await (
        app[model as 'aiRequest'] as { findMany: () => Promise<unknown[]> }
      ).findMany();
      expect(rows).toEqual([]);
    },
  );
});
