import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import {
  AutomationEngine,
  gatherFacts,
  parseAutomationPolicy,
  type AutomationActor,
  type AutomationPolicy,
  type AutomationPorts,
  type TriggerEvent,
} from '@brandspace/automation';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';
import { seedStoredRule } from './stored-automation-rule';

/**
 * PHASE 2B-3, PR 2 — A POST_FAILED EVENT REACHES THE RIGHT CONTENT ITEM,
 * AGAINST REAL POSTGRESQL.
 *
 * The event names the attempt that concluded the failure; the engine reaches
 * the post through that attempt's job — in the workspace, on the rule's brand,
 * inside the creator's live BrandScope — and the facts carry the post and the
 * job's failure class. The producer side (one event per FAILED transition) is
 * proven in `phase2b3-pr2-failed-evidence.test.ts`.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AutomationPolicy;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

function actor(overrides: Partial<AutomationActor> = {}): AutomationActor {
  return {
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    permissionKeys: ['workspace.read', 'automation.manage', 'content.submit'],
    brandScope: [],
    ...overrides,
  };
}

/** The content item each submission was aimed at, in order. */
let submitted: string[] = [];
const ports: AutomationPorts = {
  approvals: {
    submitForApproval: async (input) => {
      submitted.push(input.contentItemId);
      return { approvalId: randomUUID() };
    },
  },
};

const engine = (db: TenantScopedClient) =>
  new AutomationEngine({ db, workspaceId: fixtures.a.workspaceId, policy, ports });

/** A job of workspace A that FAILED, concluded by one attempt. */
async function failedJob(): Promise<{ jobId: string; attemptId: string }> {
  return inA(async (db) => {
    const job = await db.publishJob.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        calendarSlotId: fixtures.a.calendarSlotId,
        contentItemId: fixtures.a.contentItemId,
        contentVariantId: fixtures.a.contentVariantId,
        socialConnectionId: fixtures.a.socialConnectionId,
        provider: 'LINKEDIN',
        status: 'FAILED',
        failureClass: 'CONTENT_REJECTED',
        failureCode: 'scripted.content_rejected',
        idempotencyKey: `pr2-post-failed-${randomUUID()}`,
        scheduledAtUtc: new Date(),
        attemptCount: 1,
        maxAttempts: 3,
        completedAt: new Date(),
        createdByUserId: fixtures.a.userId,
      },
    });
    const attempt = await db.publishAttempt.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        publishJobId: job.id,
        attemptNumber: 1,
        startedAt: new Date(),
        finishedAt: new Date(),
        durationMs: 0,
        outcome: 'PERMANENT_FAILURE',
        failureClass: 'CONTENT_REJECTED',
      },
    });
    return { jobId: job.id, attemptId: attempt.id };
  });
}

function eventFor(attemptId: string, facts: Record<string, unknown>): TriggerEvent {
  return {
    type: 'POST_FAILED',
    brandId: fixtures.a.brandId,
    refType: 'PublishAttempt',
    refId: attemptId,
    ruleId: null,
    eventKey: `POST_FAILED:${attemptId}`,
    facts,
  };
}

async function submitRule() {
  return inA((db) =>
    seedStoredRule(db, {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      name: `pr2 post-failed ${randomUUID().slice(0, 8)}`,
      triggerType: 'POST_FAILED',
      actionType: 'SUBMIT_FOR_APPROVAL',
      createdByUserId: fixtures.a.userId,
    }),
  );
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parseAutomationPolicy(defaultPayload('automations'));
}, 60_000);

afterEach(async () => {
  submitted = [];
  await inA((db) =>
    db.automationRule.updateMany({
      where: { workspaceId: fixtures.a.workspaceId, name: { startsWith: 'pr2 post-failed' } },
      data: { deletedAt: new Date(), enabled: false },
    }),
  );
});

afterAll(async () => {
  await app?.$disconnect();
});

describe('POST_FAILED facts', () => {
  it('the post’s facts and the JOB’s failure class, reached through the attempt', async () => {
    const { attemptId } = await failedJob();
    const facts = await inA((db) =>
      gatherFacts(db, {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        triggerType: 'POST_FAILED',
        refType: 'PublishAttempt',
        refId: attemptId,
        ruleId: null,
      }),
    );
    expect(facts['brand.id']).toBe(fixtures.a.brandId);
    expect(facts['publish.failureClass']).toBe('CONTENT_REJECTED');
    // Content facts come from the fixture's content item.
    const item = await inA((db) =>
      db.contentItem.findFirstOrThrow({ where: { id: fixtures.a.contentItemId } }),
    );
    expect(facts['content.type']).toBe(item.contentType);
    expect(facts['content.campaignId']).toBe(item.campaignId);
    expect(Array.isArray(facts['content.channels'])).toBe(true);
    // Not produced for this trigger.
    expect(facts).not.toHaveProperty('publish.provider');
  });

  it('an attempt of another workspace yields nothing but the brand', async () => {
    const facts = await inA((db) =>
      gatherFacts(db, {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        triggerType: 'POST_FAILED',
        refType: 'PublishAttempt',
        refId: fixtures.b.publishAttemptId,
        ruleId: null,
      }),
    );
    expect(facts).toEqual({ 'brand.id': fixtures.a.brandId });
  });
});

describe('POST_FAILED runs act on the failed post', () => {
  it('a stored rule resolves attempt → job → content item, once per event', async () => {
    const rule = await submitRule();
    const { attemptId } = await failedJob();
    const event = eventFor(attemptId, { 'brand.id': fixtures.a.brandId });
    const first = await inA((db) =>
      engine(db).run({
        rule: { ...rule, enabled: true },
        event,
        resolveActor: async () => actor(),
      }),
    );
    expect(first.status).toBe('SUCCEEDED');
    expect(submitted).toEqual([fixtures.a.contentItemId]);

    // The same event delivered again is the same run: nothing is repeated.
    const again = await inA((db) =>
      engine(db).run({
        rule: { ...rule, enabled: true },
        event,
        resolveActor: async () => actor(),
      }),
    );
    expect(again.run?.id).toBe(first.run?.id);
    expect(submitted).toEqual([fixtures.a.contentItemId]);
    expect(first.run?.triggerRefType).toBe('PublishAttempt');
    expect(first.run?.triggerRefId).toBe(attemptId);
  });

  it('a second failure of the same job is a second run', async () => {
    const rule = await submitRule();
    const one = await failedJob();
    const two = await failedJob();
    for (const attemptId of [one.attemptId, two.attemptId]) {
      await inA((db) =>
        engine(db).run({
          rule: { ...rule, enabled: true },
          event: eventFor(attemptId, { 'brand.id': fixtures.a.brandId }),
          resolveActor: async () => actor(),
        }),
      );
    }
    expect(submitted).toHaveLength(2);
  });

  it('an attempt of another workspace resolves to nothing and nothing is submitted', async () => {
    const rule = await submitRule();
    const outcome = await inA((db) =>
      engine(db).run({
        rule: { ...rule, enabled: true },
        event: eventFor(fixtures.b.publishAttemptId, { 'brand.id': fixtures.a.brandId }),
        resolveActor: async () => actor(),
      }),
    );
    expect(outcome.status).toBe('FAILED');
    expect(submitted).toEqual([]);
    // And B cannot see A's attempt at all.
    const { attemptId } = await failedJob();
    expect(await inB((db) => db.publishAttempt.findFirst({ where: { id: attemptId } }))).toBeNull();
  });

  it('a creator whose BrandScope no longer covers the brand is blocked before anything resolves', async () => {
    const rule = await submitRule();
    const { attemptId } = await failedJob();
    const outcome = await inA((db) =>
      engine(db).run({
        rule: { ...rule, enabled: true },
        event: eventFor(attemptId, { 'brand.id': fixtures.a.brandId }),
        resolveActor: async () => actor({ brandScope: [randomUUID()] }),
      }),
    );
    expect(outcome.status).toBe('BLOCKED_BY_AUTHORIZATION');
    expect(outcome.run?.failureCode).toBe('creator_lost_brand_scope');
    expect(submitted).toEqual([]);
  });
});
