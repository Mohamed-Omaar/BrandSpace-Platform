import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Phase 7 tenant isolation — the four Copilot tables, on real PostgreSQL.
 *
 * WHY THESE ARE NOT ORDINARY ROWS. A `copilot_action_plan` is a loaded gun with
 * the safety on: it names actions that will be executed against tenant data, and
 * `confirmationTokenHash` is what releases the safety. `copilot_message` holds
 * whatever the customer typed, which in this product means their strategy, their
 * launch dates and sometimes their numbers.
 *
 * SO THIS FILE PROVES TWO DIFFERENT THINGS. The isolation half is the usual six
 * probes. The SECURITY half is the one that matters for the confirmation
 * contract: a plan belonging to another workspace must not be confirmable,
 * executable or undoable from this one, and the plan must be FROZEN once
 * confirmed so a confirmed plan and the plan that executes are the same plan.
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

describe('CopilotSession is invisible across the tenant boundary', () => {
  it('a cross-tenant read returns null', async () => {
    const found = await inA((db) =>
      db.copilotSession.findFirst({ where: { id: fixtures.b.copilotSessionId } }),
    );
    expect(found).toBeNull();
  });

  it('listing and counting exclude the other tenant', async () => {
    const rows = await inA((db) => db.copilotSession.findMany({}));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(await inA((db) => db.copilotSession.count({}))).toBe(rows.length);
  });

  it("listing by B's user id returns nothing — a user id is not a back door", async () => {
    const rows = await inA((db) =>
      db.copilotSession.findMany({ where: { userId: fixtures.b.userId } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('a cross-tenant write is refused', async () => {
    await expect(
      inA((db) =>
        db.copilotSession.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            userId: fixtures.b.userId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("a session in A's workspace cannot name B's brand (D-112)", async () => {
    await expect(
      inA((db) =>
        db.copilotSession.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.b.brandId,
            userId: fixtures.a.userId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a cross-tenant UPDATE and DELETE change nothing', async () => {
    expect(
      (
        await inA((db) =>
          db.copilotSession.updateMany({
            where: { id: fixtures.b.copilotSessionId },
            data: { archivedAt: new Date() },
          }),
        )
      ).count,
    ).toBe(0);
    expect(
      (
        await inA((db) =>
          db.copilotSession.deleteMany({ where: { id: fixtures.b.copilotSessionId } }),
        )
      ).count,
    ).toBe(0);

    const still = await inB((db) =>
      db.copilotSession.findFirstOrThrow({
        where: { id: fixtures.b.copilotSessionId },
        select: { archivedAt: true },
      }),
    );
    expect(still.archivedAt).toBeNull();
  });
});

describe('CopilotMessage is invisible across the tenant boundary', () => {
  it('a cross-tenant read returns null', async () => {
    const found = await inA((db) =>
      db.copilotMessage.findFirst({ where: { id: fixtures.b.copilotMessageId } }),
    );
    expect(found).toBeNull();
  });

  it("reading by B's session id returns nothing", async () => {
    const rows = await inA((db) =>
      db.copilotMessage.findMany({ where: { sessionId: fixtures.b.copilotSessionId } }),
    );
    expect(rows).toHaveLength(0);
  });

  it("a substring search cannot surface B's typed words", async () => {
    /*
     * THE SEARCH PROBE, and for this table it is the important one: a customer's
     * message body is free text they believed was private.
     */
    const rows = await inA((db) =>
      db.copilotMessage.findMany({
        where: { body: { contains: `fixture-copilot-body-${fixtures.b.slug}` } },
      }),
    );
    expect(rows).toHaveLength(0);

    const own = await inA((db) =>
      db.copilotMessage.findMany({
        where: { body: { contains: `fixture-copilot-body-${fixtures.a.slug}` } },
      }),
    );
    expect(own.length).toBeGreaterThan(0);
  });

  it('listing and counting exclude the other tenant', async () => {
    const rows = await inA((db) => db.copilotMessage.findMany({}));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(await inA((db) => db.copilotMessage.count({}))).toBe(rows.length);
  });

  it("a message cannot be created against B's session", async () => {
    await expect(
      inA((db) =>
        db.copilotMessage.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            sessionId: fixtures.b.copilotSessionId,
            role: 'USER',
            body: 'probe',
            correlationId: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('CopilotActionPlan is invisible AND unusable across the tenant boundary', () => {
  it('a cross-tenant read returns null', async () => {
    const found = await inA((db) =>
      db.copilotActionPlan.findFirst({ where: { id: fixtures.b.copilotPlanId } }),
    );
    expect(found).toBeNull();
  });

  it("looking a plan up by B's plan hash finds nothing", async () => {
    const found = await inA((db) =>
      db.copilotActionPlan.findFirst({ where: { planHash: fixtures.b.copilotPlanHash } }),
    );
    expect(found).toBeNull();
  });

  it("A cannot CONFIRM B's plan, even holding its id", async () => {
    /*
     * THE CENTRAL SECURITY ASSERTION OF THE COPILOT. The confirmation write is
     * the only thing standing between a proposed action and an executed one, so
     * it is probed here in the rawest possible form: a direct update with the
     * foreign id, no service in the way.
     */
    const result = await inA((db) =>
      db.copilotActionPlan.updateMany({
        where: { id: fixtures.b.copilotPlanId },
        data: {
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          confirmedByUserId: fixtures.a.userId,
        },
      }),
    );
    expect(result.count).toBe(0);

    const still = await inB((db) =>
      db.copilotActionPlan.findFirstOrThrow({
        where: { id: fixtures.b.copilotPlanId },
        select: { status: true, confirmedAt: true, confirmedByUserId: true },
      }),
    );
    expect(still.status).toBe('AWAITING_CONFIRMATION');
    expect(still.confirmedAt).toBeNull();
    expect(still.confirmedByUserId).toBeNull();
  });

  it('a plan cannot be created that skips confirmation for an external action', async () => {
    /*
     * CLAUDE.md §2.5 AS A DATABASE CONSTRAINT. Not "the service sets this
     * correctly" — the row cannot exist.
     */
    await expect(
      inA((db) =>
        db.copilotActionPlan.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            sessionId: fixtures.a.copilotSessionId,
            userId: fixtures.a.userId,
            planVersion: 99,
            planHash: `probe-${randomUUID()}`,
            summary: { en: 'probe', ar: 'probe' },
            steps: [],
            highestActionClass: 'EXTERNAL_OR_DESTRUCTIVE',
            requiresConfirmation: false,
            correlationId: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow(/external_requires_confirmation/i);
  });

  it('a plan cannot start executing before it is confirmed', async () => {
    await expect(
      inA((db) =>
        db.copilotActionPlan.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            sessionId: fixtures.a.copilotSessionId,
            userId: fixtures.a.userId,
            planVersion: 98,
            planHash: `probe-${randomUUID()}`,
            summary: { en: 'probe', ar: 'probe' },
            steps: [],
            highestActionClass: 'INTERNAL_REVERSIBLE',
            requiresConfirmation: true,
            startedAt: new Date(),
            correlationId: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow(/execution_follows_confirmation/i);
  });

  it('a confirmation with nobody attached to it is refused', async () => {
    await expect(
      inA((db) =>
        db.copilotActionPlan.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            sessionId: fixtures.a.copilotSessionId,
            userId: fixtures.a.userId,
            planVersion: 97,
            planHash: `probe-${randomUUID()}`,
            summary: { en: 'probe', ar: 'probe' },
            steps: [],
            highestActionClass: 'INTERNAL_REVERSIBLE',
            requiresConfirmation: true,
            confirmedAt: new Date(),
            correlationId: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow(/confirmation_is_attributable/i);
  });

  it('a confirmed plan is FROZEN: its steps and hash cannot move afterwards', async () => {
    /*
     * "CHANGING THE PLAN INVALIDATES THE CONFIRMATION" — stated as a trigger, so
     * the alternative attack (change the plan and KEEP the confirmation) is not
     * available either. Proven on a plan this tenant owns, because the hazard is
     * a bug in our own code rather than a foreign caller.
     */
    const planId = await inA(async (db) => {
      const plan = await db.copilotActionPlan.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          sessionId: fixtures.a.copilotSessionId,
          userId: fixtures.a.userId,
          planVersion: 50,
          planHash: `frozen-${randomUUID()}`,
          summary: { en: 'probe', ar: 'probe' },
          steps: [{ toolKey: 'campaign.create', actionClass: 'INTERNAL_REVERSIBLE' }],
          highestActionClass: 'INTERNAL_REVERSIBLE',
          requiresConfirmation: true,
          correlationId: randomUUID(),
        },
      });
      await db.copilotActionPlan.update({
        where: { id: plan.id },
        data: {
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          confirmedByUserId: fixtures.a.userId,
          confirmationTokenHash: `frozen-token-${randomUUID()}`,
        },
      });
      return plan.id;
    });

    await expect(
      inA((db) =>
        db.copilotActionPlan.update({
          where: { id: planId },
          data: { steps: [{ toolKey: 'publishing.publish_now' }] },
        }),
      ),
    ).rejects.toThrow(/confirmed|frozen/i);

    await expect(
      inA((db) =>
        db.copilotActionPlan.update({
          where: { id: planId },
          data: { planHash: `moved-${randomUUID()}` },
        }),
      ),
    ).rejects.toThrow(/confirmed|frozen/i);
  });

  it('a cross-tenant write is refused', async () => {
    await expect(
      inA((db) =>
        db.copilotActionPlan.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            sessionId: fixtures.b.copilotSessionId,
            userId: fixtures.b.userId,
            planHash: `probe-${randomUUID()}`,
            summary: { en: 'probe', ar: 'probe' },
            steps: [],
            correlationId: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('CopilotToolCall is invisible across the tenant boundary', () => {
  it('a cross-tenant read returns null', async () => {
    const found = await inA((db) =>
      db.copilotToolCall.findFirst({ where: { id: fixtures.b.copilotToolCallId } }),
    );
    expect(found).toBeNull();
  });

  it("looking up by B's tool-call idempotency key finds nothing", async () => {
    const found = await inA((db) =>
      db.copilotToolCall.findFirst({
        where: { idempotencyKey: fixtures.b.copilotToolCallIdempotencyKey },
      }),
    );
    expect(found).toBeNull();
  });

  it("listing by B's plan id returns nothing", async () => {
    const rows = await inA((db) =>
      db.copilotToolCall.findMany({ where: { planId: fixtures.b.copilotPlanId } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('listing and counting exclude the other tenant', async () => {
    const rows = await inA((db) => db.copilotToolCall.findMany({}));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
    expect(await inA((db) => db.copilotToolCall.count({}))).toBe(rows.length);
  });

  it("A cannot mark B's tool call as executed", async () => {
    const result = await inA((db) =>
      db.copilotToolCall.updateMany({
        where: { id: fixtures.b.copilotToolCallId },
        data: { status: 'SUCCEEDED', finishedAt: new Date() },
      }),
    );
    expect(result.count).toBe(0);

    const still = await inB((db) =>
      db.copilotToolCall.findFirstOrThrow({
        where: { id: fixtures.b.copilotToolCallId },
        select: { status: true },
      }),
    );
    expect(still.status).toBe('PLANNED');
  });

  it("a tool call cannot be attached to B's plan", async () => {
    await expect(
      inA((db) =>
        db.copilotToolCall.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            planId: fixtures.b.copilotPlanId,
            sessionId: fixtures.a.copilotSessionId,
            ordinal: 9,
            toolKey: 'campaign.create',
            actionClass: 'INTERNAL_REVERSIBLE',
            idempotencyKey: `probe-${randomUUID()}`,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
