import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Cross-tenant isolation for every model Phase 3 added.
 *
 * The D-29 gate REQUIRES this file. Each model gets the same three assertions
 * the Phase 2B suite established, because each is a different way the same leak
 * happens:
 *
 *   1. a direct read of B's row from A's context returns null, not a row,
 *   2. a listing from A's context excludes B entirely, not "mostly",
 *   3. a write aimed at B from A's context is refused by the database.
 *
 * Plus, for this phase specifically, the MONEY assertions: a tenant cannot move
 * another tenant's credits, cannot spend from another tenant's bucket, and
 * cannot rewrite its own usage history to get its quota back.
 *
 * Everything runs through `withWorkspace()`, so PostgreSQL RLS — not a `where`
 * clause this test remembered to add — is what is being measured.
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

describe('WorkspaceSubscription is tenant-owned', () => {
  it('A cannot read B subscription by id', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.workspaceSubscription.findUnique({ where: { id: fixtures.b.subscriptionId } }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A cannot read B subscription by its unique workspace key either', async () => {
    // The unique index makes this a direct hit if RLS is not applied, which is
    // exactly why it is asserted separately from the id lookup.
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.workspaceSubscription.findUnique({
          where: { workspaceId: fixtures.b.workspaceId },
        }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A listing shows only A subscription', async () => {
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.workspaceSubscription.findMany(),
      { prisma: app },
    );
    expect(rows.map((r) => r.id)).toEqual([fixtures.a.subscriptionId]);
  });

  it("A cannot change B's pinned price", async () => {
    // The pinned price is what makes AC-04.7 hold. A tenant that could rewrite
    // another tenant's agreed price would be repricing a customer.
    const result = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.workspaceSubscription.updateMany({
          where: { id: fixtures.b.subscriptionId },
          data: { pinnedMonthlyMinor: 1 },
        }),
      { prisma: app },
    );
    expect(result.count).toBe(0);
  });

  it("A cannot clear B's trial history to give it a second trial", async () => {
    const result = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.workspaceSubscription.updateMany({
          where: { id: fixtures.b.subscriptionId },
          data: { trialStartedAt: null },
        }),
      { prisma: app },
    );
    expect(result.count).toBe(0);
  });
});

describe('CreditGrant is tenant-owned', () => {
  it('A cannot read B grant by id', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.creditGrant.findUnique({ where: { id: fixtures.b.creditGrantId } }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A listing shows only A buckets', async () => {
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.creditGrant.findMany(),
      { prisma: app },
    );
    expect(rows.map((r) => r.id)).toEqual([fixtures.a.creditGrantId]);
  });

  it('A cannot spend from a B bucket', async () => {
    const result = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.creditGrant.updateMany({
          where: { id: fixtures.b.creditGrantId },
          data: { remainingMilliCredits: 0n },
        }),
      { prisma: app },
    );
    expect(result.count).toBe(0);
  });

  it('A cannot grant itself credits attributed to B', async () => {
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          db.creditGrant.create({
            data: {
              workspaceId: fixtures.b.workspaceId,
              walletId: fixtures.b.walletId,
              source: 'PROMOTIONAL_GRANT',
              amountMilliCredits: 1_000_000n,
              remainingMilliCredits: 1_000_000n,
              sourceTransactionId: crypto.randomUUID(),
              reason: 'cross-tenant grant attempt',
            },
          }),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });

  it("a grant's amount and provenance are immutable even for its own tenant", async () => {
    // The trigger, not the policy. Rewriting the original amount would break
    // ledger replay silently: reconciliation would still report zero drift
    // while the numbers underneath had changed.
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          db.creditGrant.update({
            where: { id: fixtures.a.creditGrantId },
            data: { amountMilliCredits: 999_000n },
          }),
        { prisma: app },
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it('the remaining balance may still be spent by its own tenant', async () => {
    // The counterpart to the assertion above: the trigger must block history,
    // not the ordinary operation of the ledger.
    const result = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.creditGrant.updateMany({
          where: { id: fixtures.a.creditGrantId },
          data: { remainingMilliCredits: 4000n },
        }),
      { prisma: app },
    );
    expect(result.count).toBe(1);
  });
});

describe('CreditReservation is tenant-owned', () => {
  it('A cannot read B reservation by id', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.creditReservation.findUnique({ where: { id: fixtures.b.creditReservationId } }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A cannot find B reservation by its idempotency key', async () => {
    // A unique index again. If RLS were missing, a guessed key would return
    // another tenant's reservation — including what it is for.
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.creditReservation.findUnique({
          where: { idempotencyKey: `fixture-reservation-${fixtures.b.slug}` },
        }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A listing shows only A reservations', async () => {
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.creditReservation.findMany(),
      { prisma: app },
    );
    expect(rows.map((r) => r.id)).toEqual([fixtures.a.creditReservationId]);
  });

  it('A cannot settle or release a B reservation', async () => {
    const result = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.creditReservation.updateMany({
          where: { id: fixtures.b.creditReservationId },
          data: { status: 'RELEASED' },
        }),
      { prisma: app },
    );
    expect(result.count).toBe(0);
  });

  it('a terminal reservation cannot be reopened even by its own tenant', async () => {
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.creditReservation.update({
          where: { id: fixtures.a.creditReservationId },
          data: { status: 'RELEASED', releaseReason: 'test' },
        }),
      { prisma: app },
    );

    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          db.creditReservation.update({
            where: { id: fixtures.a.creditReservationId },
            data: { status: 'OPEN' },
          }),
        { prisma: app },
      ),
    ).rejects.toThrow(/terminal/i);
  });
});

describe('UsageCounter is tenant-owned', () => {
  it('A cannot read B counter by id', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.usageCounter.findUnique({ where: { id: fixtures.b.usageCounterId } }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A cannot read B counter by its composite unique key', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.usageCounter.findUnique({
          where: {
            workspaceId_featureKey_periodStart: {
              workspaceId: fixtures.b.workspaceId,
              featureKey: 'limit.scheduled_posts',
              periodStart: new Date(Date.UTC(2026, 0, 1)),
            },
          },
        }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A listing shows only A counters', async () => {
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.usageCounter.findMany(),
      { prisma: app },
    );
    expect(rows.map((r) => r.id)).toEqual([fixtures.a.usageCounterId]);
  });

  it("A cannot consume against B's quota", async () => {
    const result = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.usageCounter.updateMany({
          where: { id: fixtures.b.usageCounterId },
          data: { usedValue: 9999 },
        }),
      { prisma: app },
    );
    expect(result.count).toBe(0);
  });

  it('a counter can never go negative', async () => {
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          db.usageCounter.update({
            where: { id: fixtures.a.usageCounterId },
            data: { usedValue: -1 },
          }),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });
});

describe('UsageEvent is tenant-owned and append-only', () => {
  it('A cannot read B usage event by id', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.usageEvent.findUnique({ where: { id: fixtures.b.usageEventId } }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A cannot find B usage event by its idempotency key', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.usageEvent.findUnique({
          where: { idempotencyKey: `fixture-usage-${fixtures.b.slug}` },
        }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A listing shows only A usage events', async () => {
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.usageEvent.findMany(),
      { prisma: app },
    );
    expect(rows.map((r) => r.id)).toEqual([fixtures.a.usageEventId]);
  });

  it('a tenant cannot delete its own usage record to reclaim quota', async () => {
    // REVOKE plus a trigger. Both matter: if a tenant could delete the
    // idempotency record, the "record usage exactly once" guarantee would be
    // advisory, and deleting the record is also how you would reset a quota.
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) => db.usageEvent.delete({ where: { id: fixtures.a.usageEventId } }),
        { prisma: app },
      ),
    ).rejects.toThrow();

    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          db.usageEvent.update({
            where: { id: fixtures.a.usageEventId },
            data: { amount: 0 },
          }),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });
});

describe('BetaCohortMembership is tenant-owned', () => {
  it('A cannot read B membership by id', async () => {
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.betaCohortMembership.findUnique({ where: { id: fixtures.b.cohortMembershipId } }),
      { prisma: app },
    );
    expect(row).toBeNull();
  });

  it('A listing shows only A memberships', async () => {
    // A cohort listing that leaked would tell one customer which OTHER
    // customers are in a private beta.
    const rows = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.betaCohortMembership.findMany(),
      { prisma: app },
    );
    expect(rows.map((r) => r.id)).toEqual([fixtures.a.cohortMembershipId]);
  });

  it('A cannot enrol itself in a cohort as B', async () => {
    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          db.betaCohortMembership.create({
            data: {
              workspaceId: fixtures.b.workspaceId,
              cohortKey: 'smuggled',
              addedByPlatformUserId: fixtures.platformUserId,
              reason: 'cross-tenant enrolment attempt',
            },
          }),
        { prisma: app },
      ),
    ).rejects.toThrow();
  });

  it('A cannot remove B from a cohort', async () => {
    const result = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.betaCohortMembership.deleteMany({ where: { id: fixtures.b.cohortMembershipId } }),
      { prisma: app },
    );
    expect(result.count).toBe(0);
  });
});

describe('a query with no workspace context reads nothing', () => {
  // `NULL = <uuid>` is never true, so the absence of context is not a wildcard.
  // This is asserted per phase because a new table gets a new policy, and the
  // failure mode — a background job with no context reading every tenant — is
  // silent.
  it.each([
    ['workspaceSubscription'],
    ['creditGrant'],
    ['creditReservation'],
    ['usageCounter'],
    ['usageEvent'],
    ['betaCohortMembership'],
  ])('%s is empty without a workspace context', async (model) => {
    const rows = await (
      app[model as 'creditGrant'] as { findMany: () => Promise<unknown[]> }
    ).findMany();
    expect(rows).toEqual([]);
  });
});
