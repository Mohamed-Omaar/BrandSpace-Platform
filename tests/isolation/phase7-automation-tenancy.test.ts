import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Phase 7 tenant isolation — the two automation tables, on real PostgreSQL.
 *
 * AN AUTOMATION RULE IS STORED AUTHORITY. It says "when this happens, do that",
 * and it keeps saying it long after the person who wrote it has gone. So the
 * hazards here are not only the usual read and write leaks: a rule that could
 * name another workspace's brand, or fire against another workspace's content
 * item, would be a way to act across the boundary rather than merely to see
 * across it.
 *
 * THE RUN TABLE CARRIES THE OTHER HALF OF THE CONFIRMATION CONTRACT. An external
 * action reaches `AWAITING_CONFIRMATION` and waits for a human; the token hash on
 * the run is what that human presents. A foreign workspace must not be able to
 * present it, and the same token must not work twice.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

type Db = Parameters<Parameters<typeof withWorkspace>[1]>[0];
const inA = <T>(fn: (db: Db) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: Db) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

describe('AutomationRule is invisible across the tenant boundary', () => {
  it('a cross-tenant read returns null', async () => {
    const found = await inA((db) =>
      db.automationRule.findFirst({ where: { id: fixtures.b.automationRuleId } }),
    );
    expect(found).toBeNull();
  });

  it('listing and counting exclude the other tenant', async () => {
    const rows = await inA((db) => db.automationRule.findMany({}));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(await inA((db) => db.automationRule.count({}))).toBe(rows.length);
  });

  it("the trigger sweep shape — 'every enabled rule for this trigger' — stays inside the tenant", async () => {
    /*
     * THE QUERY THE ENGINE ACTUALLY RUNS when an event arrives. Written here
     * without any brand or workspace filter on purpose: RLS is what must make it
     * safe, not the caller remembering.
     */
    const rules = await inA((db) =>
      db.automationRule.findMany({
        where: { enabled: true, triggerType: 'CONTENT_APPROVED', deletedAt: null },
        select: { id: true, workspaceId: true },
      }),
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(rules.some((row) => row.id === fixtures.b.automationRuleId)).toBe(false);
  });

  it("a name search cannot find B's rule", async () => {
    const rows = await inA((db) =>
      db.automationRule.findMany({ where: { name: { contains: fixtures.b.slug } } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('a cross-tenant write is refused', async () => {
    await expect(
      inA((db) =>
        db.automationRule.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            name: `probe-${randomUUID()}`,
            triggerType: 'CONTENT_APPROVED',
            actionType: 'NOTIFY',
            createdByUserId: fixtures.b.userId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("a rule in A's workspace cannot be pointed at B's brand (D-112)", async () => {
    await expect(
      inA((db) =>
        db.automationRule.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.b.brandId,
            name: `probe-${randomUUID()}`,
            triggerType: 'CONTENT_APPROVED',
            actionType: 'NOTIFY',
            createdByUserId: fixtures.a.userId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('an external action cannot have its confirmation requirement switched off', async () => {
    /*
     * THE OTHER DOOR TO §2.5, CLOSED IN THE DATABASE. An automation must not be
     * a way around the Copilot's confirmation boundary, whatever a future rule
     * editor offers.
     */
    await expect(
      inA((db) =>
        db.automationRule.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            name: `probe-${randomUUID()}`,
            triggerType: 'CONTENT_APPROVED',
            actionType: 'PROPOSE_PUBLISH',
            requiresConfirmationForExternal: false,
            createdByUserId: fixtures.a.userId,
          },
        }),
      ),
    ).rejects.toThrow(/external_requires_confirmation/i);
  });

  it("A cannot enable, disable, re-point or delete B's rule", async () => {
    expect(
      (
        await inA((db) =>
          db.automationRule.updateMany({
            where: { id: fixtures.b.automationRuleId },
            data: { enabled: false },
          }),
        )
      ).count,
    ).toBe(0);
    expect(
      (
        await inA((db) =>
          db.automationRule.updateMany({
            where: { id: fixtures.b.automationRuleId },
            data: { actionType: 'PROPOSE_PUBLISH' },
          }),
        )
      ).count,
    ).toBe(0);
    expect(
      (
        await inA((db) =>
          db.automationRule.deleteMany({ where: { id: fixtures.b.automationRuleId } }),
        )
      ).count,
    ).toBe(0);

    const still = await inB((db) =>
      db.automationRule.findFirstOrThrow({
        where: { id: fixtures.b.automationRuleId },
        select: { enabled: true, actionType: true },
      }),
    );
    expect(still.enabled).toBe(true);
    expect(still.actionType).toBe('NOTIFY');
  });
});

describe('AutomationRun is invisible across the tenant boundary', () => {
  it('a cross-tenant read returns null', async () => {
    const found = await inA((db) =>
      db.automationRun.findFirst({ where: { id: fixtures.b.automationRunId } }),
    );
    expect(found).toBeNull();
  });

  it("looking up by B's run idempotency key finds nothing", async () => {
    const found = await inA((db) =>
      db.automationRun.findFirst({
        where: { idempotencyKey: fixtures.b.automationRunIdempotencyKey },
      }),
    );
    expect(found).toBeNull();
  });

  it("listing by B's rule id returns nothing", async () => {
    const rows = await inA((db) =>
      db.automationRun.findMany({ where: { ruleId: fixtures.b.automationRuleId } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('listing and counting exclude the other tenant', async () => {
    const rows = await inA((db) => db.automationRun.findMany({}));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(await inA((db) => db.automationRun.count({}))).toBe(rows.length);
  });

  it("A cannot confirm B's awaiting run", async () => {
    const awaitingId = await inB(async (db) => {
      const run = await db.automationRun.create({
        data: {
          workspaceId: fixtures.b.workspaceId,
          brandId: fixtures.b.brandId,
          ruleId: fixtures.b.automationRuleId,
          status: 'AWAITING_CONFIRMATION',
          triggerType: 'CONTENT_APPROVED',
          idempotencyKey: `awaiting-${randomUUID()}`,
          conditionsHeld: true,
          actionType: 'PROPOSE_PUBLISH',
          confirmationTokenHash: `awaiting-token-${randomUUID()}`,
          confirmationExpiresAt: new Date(Date.now() + 600_000),
          correlationId: randomUUID(),
        },
      });
      return run.id;
    });

    const result = await inA((db) =>
      db.automationRun.updateMany({
        where: { id: awaitingId },
        data: {
          status: 'SUCCEEDED',
          confirmedAt: new Date(),
          confirmedByUserId: fixtures.a.userId,
        },
      }),
    );
    expect(result.count).toBe(0);

    const still = await inB((db) =>
      db.automationRun.findFirstOrThrow({
        where: { id: awaitingId },
        select: { status: true, confirmedByUserId: true },
      }),
    );
    expect(still.status).toBe('AWAITING_CONFIRMATION');
    expect(still.confirmedByUserId).toBeNull();
  });

  it('a confirmation token is single-use, even within the tenant that owns it', async () => {
    /*
     * REPLAY, IN THE RAWEST FORM. The run's confirmation hash may be consumed
     * once; presenting it a second time must not move the run again. Enforced by
     * a trigger, so it holds whatever the service does.
     */
    const runId = await inA(async (db) => {
      const run = await db.automationRun.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          ruleId: fixtures.a.automationRuleId,
          status: 'AWAITING_CONFIRMATION',
          triggerType: 'CONTENT_APPROVED',
          idempotencyKey: `replay-${randomUUID()}`,
          conditionsHeld: true,
          actionType: 'PROPOSE_PUBLISH',
          confirmationTokenHash: `replay-token-${randomUUID()}`,
          confirmationExpiresAt: new Date(Date.now() + 600_000),
          correlationId: randomUUID(),
        },
      });
      await db.automationRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCEEDED',
          confirmedAt: new Date(),
          confirmedByUserId: fixtures.a.userId,
          finishedAt: new Date(),
        },
      });
      return run.id;
    });

    await expect(
      inA((db) =>
        db.automationRun.update({
          where: { id: runId },
          data: {
            status: 'SUCCEEDED',
            confirmedAt: new Date(),
            confirmedByUserId: fixtures.a.userId,
          },
        }),
      ),
    ).rejects.toThrow(/confirm|single|already/i);
  });

  it('a cross-tenant write is refused', async () => {
    await expect(
      inA((db) =>
        db.automationRun.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            ruleId: fixtures.b.automationRuleId,
            triggerType: 'CONTENT_APPROVED',
            idempotencyKey: `probe-${randomUUID()}`,
            actionType: 'NOTIFY',
            correlationId: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("a run cannot be attached to B's rule from A", async () => {
    await expect(
      inA((db) =>
        db.automationRun.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            ruleId: fixtures.b.automationRuleId,
            triggerType: 'CONTENT_APPROVED',
            idempotencyKey: `probe-${randomUUID()}`,
            actionType: 'NOTIFY',
            correlationId: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
