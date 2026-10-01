import { randomUUID } from 'node:crypto';
import type { AutomationRule, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, writeDeniedAudit, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { closeQueues, EVALUATE_AUTOMATION } from '@brandspace/jobs';
import {
  AutomationEngine,
  parseAutomationPolicy,
  type AutomationActor,
  type AutomationPolicy,
  type AutomationPorts,
} from '@brandspace/automation';
import { parsePublishingPolicy, type PublishingPolicy } from '@brandspace/social-connectors';
import { processAutomationJob } from '../../apps/worker/src/processors/automation';
import { campaignPausePort, publishRetryPort } from '../../apps/api/src/routes/automation-ports';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2B-3 PR 5 — RETRY_PUBLISH AND PAUSE_CAMPAIGN, ASKS FIRST, AGAINST REAL
 * POSTGRESQL: the worker proposes, a person approves through the ports the
 * API's confirm route wires, and every stale target says why and does nothing.
 *
 *   - D3: a retry certain to be refused is never put to a person;
 *   - a pause names the rule's campaign, checked on save, at proposal and at
 *     approval; the request points at that campaign;
 *   - approval is performed as the APPROVER, once, under compare-and-swaps;
 *     approve vs approve, approve vs skip and approve vs a manual retry each
 *     end with one outcome.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AutomationPolicy;
let publishing: PublishingPolicy;
let otherBrandId: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const OWNER_KEYS = [
  'workspace.read',
  'automation.read',
  'automation.manage',
  'publishing.manage',
  'campaigns.manage',
];
const owner = (overrides: Partial<AutomationActor> = {}): AutomationActor => ({
  userId: fixtures.a.userId,
  roleKey: 'workspace_owner',
  permissionKeys: OWNER_KEYS,
  brandScope: [],
  ...overrides,
});

/** The engine the API's confirm route builds: the two PR 5 ports, here only. */
function approvalEngine(db: TenantScopedClient, workspaceId = fixtures.a.workspaceId) {
  const ports: AutomationPorts = {
    publishRetry: publishRetryPort(db, {
      environment: 'DEVELOPMENT',
      loadPolicy: async () => publishing,
    }),
    campaignPause: campaignPausePort(db),
  };
  return new AutomationEngine({
    db,
    workspaceId,
    policy,
    ports,
    denialSink: async (event) => {
      await withWorkspace(
        workspaceId,
        async (fresh) =>
          writeDeniedAudit(fresh, workspaceId, {
            action: 'automation.confirmation_refused',
            actorType: 'USER',
            actorId: event.actorUserId,
            resourceType: 'AutomationRun',
            resourceId: event.runId,
            brandId: event.brandId,
            reason: event.reason,
          }),
        { prisma: app },
      );
    },
  });
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parseAutomationPolicy(defaultPayload('automations'));
  const capability = {
    enabled: true,
    postKinds: ['text'],
    maxBodyCharacters: 2_200,
    maxHashtags: 30,
    maxMediaItems: 10,
    supportsFirstComment: false,
    supportsDelete: false,
    supportsNativeScheduling: false,
    supportsPostLookup: false,
    scopes: ['w_member_social'],
    targetKind: 'organization',
  };
  publishing = parsePublishingPolicy({
    providers: {
      facebook: capability,
      instagram: capability,
      tiktok: capability,
      linkedin: capability,
      x: capability,
    },
  });
  otherBrandId = (
    await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `pr5-af-${randomUUID().slice(0, 8)}`,
        name: 'PR 5 other brand',
        status: 'ACTIVE',
      },
      select: { id: true },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await platform.automationRule.updateMany({
    where: { name: { startsWith: 'pr5-af ' } },
    data: { enabled: false },
  });
  await closeQueues();
  await app.$disconnect();
  await platform.$disconnect();
});

// --- fixtures -----------------------------------------------------------------

/** A FAILED job with its concluding attempt — what POST_FAILED names. */
async function failedPost(
  failureClass: 'CONTENT_REJECTED' | 'AUTH_REVOKED' = 'CONTENT_REJECTED',
): Promise<{ jobId: string; attemptId: string }> {
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
        idempotencyKey: `pr5-af-${randomUUID()}`,
        scheduledAtUtc: new Date(),
        attemptCount: 1,
        maxAttempts: 3,
        nextAttemptAt: null,
        failureClass,
        completedAt: new Date(),
        createdByUserId: fixtures.a.userId,
      },
    });
    const attempt = await db.publishAttempt.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        publishJobId: job.id,
        attemptNumber: 1,
        outcome: 'PERMANENT_FAILURE',
        failureClass,
        finishedAt: new Date(),
        durationMs: 5,
      },
    });
    return { jobId: job.id, attemptId: attempt.id };
  });
}

async function campaign(
  status: 'PLANNED' | 'ACTIVE' | 'COMPLETED' = 'ACTIVE',
  brandId = fixtures.a.brandId,
): Promise<string> {
  return (
    await platform.campaign.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId,
        name: `PR5 ${status} ${randomUUID().slice(0, 6)}`,
        objective: 'AWARENESS',
        status,
        createdByUserId: fixtures.a.userId,
      },
      select: { id: true },
    })
  ).id;
}

async function rule(
  actionType: 'RETRY_PUBLISH' | 'PAUSE_CAMPAIGN',
  actionConfig: Record<string, unknown> = {},
): Promise<AutomationRule> {
  return inA((db) =>
    new AutomationEngine({ db, workspaceId: fixtures.a.workspaceId, policy, ports: {} }).createRule(
      {
        brandId: fixtures.a.brandId,
        name: `pr5-af ${randomUUID().slice(0, 8)}`,
        triggerType: 'POST_FAILED',
        triggerConfig: {},
        conditions: [],
        actionType,
        actionConfig,
        enabled: true,
        actor: owner(),
      },
    ),
  );
}

/** POST_FAILED for `attemptId`, delivered through the real worker. */
async function failed(attemptId: string): Promise<void> {
  const event = await inA((db) =>
    db.automationEvent.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        triggerType: 'POST_FAILED',
        refType: 'PublishAttempt',
        refId: attemptId,
        dedupeKey: `POST_FAILED:${attemptId}`,
        dispatchedAt: new Date(),
      },
    }),
  );
  await processAutomationJob({
    kind: EVALUATE_AUTOMATION,
    workspaceId: fixtures.a.workspaceId,
    idempotencyKey: `automation-event-${event.id}`,
    eventId: event.id,
    eventKey: event.dedupeKey,
    brandId: fixtures.a.brandId,
    triggerType: 'POST_FAILED',
    refType: 'PublishAttempt',
    refId: attemptId,
    ruleId: null,
    occurrence: null,
  });
}

const runsOf = (ruleId: string) =>
  platform.automationRun.findMany({ where: { ruleId }, orderBy: { startedAt: 'asc' } });

async function onlyRun(ruleId: string) {
  const runs = await runsOf(ruleId);
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

/** Approve as a person does: ask for the credential, then spend it. */
async function approve(runId: string, actor: AutomationActor = owner()) {
  const issued = await inA((db) => approvalEngine(db).reissueRunConfirmation({ runId, actor }));
  if (issued.token === null) return issued.run;
  const token = issued.token;
  return inA((db) => approvalEngine(db).confirmRun({ runId, token, actor }));
}

const jobStatus = async (jobId: string) =>
  (await platform.publishJob.findUniqueOrThrow({ where: { id: jobId } })).status;

// --- RETRY_PUBLISH ------------------------------------------------------------

describe('RETRY_PUBLISH', () => {
  it('a retry a person may approve: the request waits, approval re-queues the job once, as the approver', async () => {
    const { jobId, attemptId } = await failedPost();
    const r = await rule('RETRY_PUBLISH');
    await failed(attemptId);
    const waiting = await onlyRun(r.id);
    expect(waiting).toMatchObject({
      status: 'AWAITING_CONFIRMATION',
      resourceType: 'PublishAttempt',
      resourceId: attemptId,
    });
    expect(await jobStatus(jobId)).toBe('FAILED');

    const done = await approve(waiting.id);
    expect(done).toMatchObject({ status: 'SUCCEEDED', confirmedByUserId: fixtures.a.userId });
    expect(await jobStatus(jobId)).toBe('QUEUED');
    const confirmed = await platform.auditEvent.findFirstOrThrow({
      where: { action: 'automation.run_confirmed', resourceId: waiting.id },
    });
    expect(confirmed.actorId).toBe(fixtures.a.userId);
    const retried = await platform.auditEvent.findMany({
      where: { action: 'social.post.retry_requested', resourceId: jobId },
    });
    expect(retried.map((row) => row.actorId)).toEqual([fixtures.a.userId]);
  });

  it('D3 — a retry certain to be refused is never put to a person', async () => {
    const { jobId, attemptId } = await failedPost('AUTH_REVOKED');
    const r = await rule('RETRY_PUBLISH');
    await failed(attemptId);
    expect(await onlyRun(r.id)).toMatchObject({
      status: 'BLOCKED_BY_POLICY',
      failureCode: 'publish_not_retryable',
      confirmationExpiresAt: null,
    });
    expect(
      await platform.notification.count({
        where: {
          templateKey: 'automation.confirmation_required',
          resourceId: (await onlyRun(r.id)).id,
        },
      }),
    ).toBe(0);
    expect(await jobStatus(jobId)).toBe('FAILED');
  });

  it('the post failed again before approval: failure_superseded, nothing retried', async () => {
    const { jobId, attemptId } = await failedPost();
    const r = await rule('RETRY_PUBLISH');
    await failed(attemptId);
    const waiting = await onlyRun(r.id);
    await inA((db) =>
      db.publishAttempt.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          publishJobId: jobId,
          attemptNumber: 2,
          outcome: 'PERMANENT_FAILURE',
          failureClass: 'CONTENT_REJECTED',
          finishedAt: new Date(),
          durationMs: 5,
        },
      }),
    );
    expect(await approve(waiting.id)).toMatchObject({
      status: 'BLOCKED_BY_POLICY',
      failureCode: 'failure_superseded',
    });
    expect(await jobStatus(jobId)).toBe('FAILED');
  });

  it('somebody retried it by hand first: publish_not_retryable, nothing retried twice', async () => {
    const { jobId, attemptId } = await failedPost();
    const r = await rule('RETRY_PUBLISH');
    await failed(attemptId);
    const waiting = await onlyRun(r.id);
    await platform.publishJob.update({ where: { id: jobId }, data: { status: 'QUEUED' } });
    expect(await approve(waiting.id)).toMatchObject({
      status: 'BLOCKED_BY_POLICY',
      failureCode: 'publish_not_retryable',
    });
  });

  it('approval and a manual retry at once: the job is re-queued once', async () => {
    const { jobId, attemptId } = await failedPost();
    const r = await rule('RETRY_PUBLISH');
    await failed(attemptId);
    const waiting = await onlyRun(r.id);
    const issued = await inA((db) =>
      approvalEngine(db).reissueRunConfirmation({ runId: waiting.id, actor: owner() }),
    );
    const manual = inA((db) =>
      publishRetryPort(db, {
        environment: 'DEVELOPMENT',
        loadPolicy: async () => publishing,
      }).retry({
        workspaceId: fixtures.a.workspaceId,
        jobId,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
      }),
    );
    const approved = inA((db) =>
      approvalEngine(db).confirmRun({ runId: waiting.id, token: issued.token!, actor: owner() }),
    );
    await Promise.allSettled([manual, approved]);
    expect(await jobStatus(jobId)).toBe('QUEUED');
    expect(
      await platform.auditEvent.count({
        where: { action: 'social.post.retry_requested', resourceId: jobId },
      }),
    ).toBe(1);
  });
});

// --- PAUSE_CAMPAIGN -----------------------------------------------------------

describe('PAUSE_CAMPAIGN', () => {
  it('the rule names a campaign of its brand, PLANNED or ACTIVE, or it is not saved', async () => {
    for (const config of [
      {},
      { campaignId: await campaign('COMPLETED') },
      { campaignId: await campaign('ACTIVE', otherBrandId) },
      { campaignId: randomUUID() },
    ]) {
      await expect(rule('PAUSE_CAMPAIGN', config), JSON.stringify(config)).rejects.toThrow();
    }
  });

  it('the request points at the named campaign; approval pauses it, as the approver', async () => {
    const target = await campaign('ACTIVE');
    const { attemptId } = await failedPost();
    const r = await rule('PAUSE_CAMPAIGN', { campaignId: target });
    await failed(attemptId);
    const waiting = await onlyRun(r.id);
    expect(waiting).toMatchObject({
      status: 'AWAITING_CONFIRMATION',
      resourceType: 'Campaign',
      resourceId: target,
    });
    expect(await approve(waiting.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect((await platform.campaign.findUniqueOrThrow({ where: { id: target } })).status).toBe(
      'PAUSED',
    );
    const audit = await platform.auditEvent.findFirstOrThrow({
      where: { action: 'campaign.updated', resourceId: target },
    });
    expect(audit).toMatchObject({ actorId: fixtures.a.userId, reason: 'automation_pause' });
  });

  it('no longer pausable when the request would be created: no request', async () => {
    const target = await campaign('ACTIVE');
    const r = await rule('PAUSE_CAMPAIGN', { campaignId: target });
    await platform.campaign.update({ where: { id: target }, data: { status: 'COMPLETED' } });
    const { attemptId } = await failedPost();
    await failed(attemptId);
    expect(await onlyRun(r.id)).toMatchObject({
      status: 'BLOCKED_BY_POLICY',
      failureCode: 'campaign_not_pausable',
    });
  });

  it('deleted while the request waited: campaign_unavailable, nothing changes', async () => {
    const target = await campaign('ACTIVE');
    const r = await rule('PAUSE_CAMPAIGN', { campaignId: target });
    const { attemptId } = await failedPost();
    await failed(attemptId);
    const waiting = await onlyRun(r.id);
    await platform.campaign.update({ where: { id: target }, data: { deletedAt: new Date() } });
    expect(await approve(waiting.id)).toMatchObject({
      status: 'BLOCKED_BY_POLICY',
      failureCode: 'campaign_unavailable',
    });
    expect((await platform.campaign.findUniqueOrThrow({ where: { id: target } })).status).toBe(
      'ACTIVE',
    );
  });

  it('two approvals at once: one pause, one audit; the other is refused', async () => {
    const target = await campaign('ACTIVE');
    const r = await rule('PAUSE_CAMPAIGN', { campaignId: target });
    const { attemptId } = await failedPost();
    await failed(attemptId);
    const waiting = await onlyRun(r.id);
    const issued = await inA((db) =>
      approvalEngine(db).reissueRunConfirmation({ runId: waiting.id, actor: owner() }),
    );
    const confirm = () =>
      inA((db) =>
        approvalEngine(db).confirmRun({ runId: waiting.id, token: issued.token!, actor: owner() }),
      );
    const results = await Promise.allSettled([confirm(), confirm()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await platform.auditEvent.count({
        where: { action: 'campaign.updated', resourceId: target },
      }),
    ).toBe(1);
  });

  it('approve and skip at once: exactly one decides', async () => {
    const target = await campaign('ACTIVE');
    const r = await rule('PAUSE_CAMPAIGN', { campaignId: target });
    const { attemptId } = await failedPost();
    await failed(attemptId);
    const waiting = await onlyRun(r.id);
    const issued = await inA((db) =>
      approvalEngine(db).reissueRunConfirmation({ runId: waiting.id, actor: owner() }),
    );
    await Promise.allSettled([
      inA((db) =>
        approvalEngine(db).confirmRun({ runId: waiting.id, token: issued.token!, actor: owner() }),
      ),
      inA((db) => approvalEngine(db).skipRun({ runId: waiting.id, actor: owner() })),
    ]);
    const final = await platform.automationRun.findUniqueOrThrow({ where: { id: waiting.id } });
    const paused =
      (await platform.campaign.findUniqueOrThrow({ where: { id: target } })).status === 'PAUSED';
    if (final.status === 'CANCELLED') expect(paused).toBe(false);
    else expect(final.status).toBe('SUCCEEDED');
  });
});

// --- who may approve ---------------------------------------------------------

describe('who may approve', () => {
  it('a member without the action’s permission, or outside the brand, is refused; the request waits', async () => {
    const target = await campaign('ACTIVE');
    const r = await rule('PAUSE_CAMPAIGN', { campaignId: target });
    const { attemptId } = await failedPost();
    await failed(attemptId);
    const waiting = await onlyRun(r.id);
    for (const actor of [
      owner({ permissionKeys: ['automation.read', 'publishing.manage'] }),
      owner({ brandScope: [otherBrandId] }),
    ]) {
      await expect(
        inA((db) => approvalEngine(db).reissueRunConfirmation({ runId: waiting.id, actor })),
      ).rejects.toThrow();
    }
    expect(
      (await platform.automationRun.findUniqueOrThrow({ where: { id: waiting.id } })).status,
    ).toBe('AWAITING_CONFIRMATION');
  });

  it('another workspace cannot approve it', async () => {
    const target = await campaign('ACTIVE');
    const r = await rule('PAUSE_CAMPAIGN', { campaignId: target });
    const { attemptId } = await failedPost();
    await failed(attemptId);
    const waiting = await onlyRun(r.id);
    await expect(
      inB((db) =>
        approvalEngine(db, fixtures.b.workspaceId).reissueRunConfirmation({
          runId: waiting.id,
          actor: owner({ userId: fixtures.b.userId }),
        }),
      ),
    ).rejects.toThrow();
    expect((await platform.campaign.findUniqueOrThrow({ where: { id: target } })).status).toBe(
      'ACTIVE',
    );
  });
});
