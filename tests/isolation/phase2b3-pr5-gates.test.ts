import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { closeQueues, EVALUATE_AUTOMATION } from '@brandspace/jobs';
import {
  AutomationEngine,
  parseAutomationPolicy,
  type AutomationActor,
  type AutomationPolicy,
} from '@brandspace/automation';
import { processAutomationJob } from '../../apps/worker/src/processors/automation';
import { MaintenanceScheduler } from '../../apps/api/src/scheduler';
import {
  appRoleClient,
  createIsolationFixtures,
  ensureWorkspaceRbac,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import { seedStoredRule } from './stored-automation-rule';

/**
 * PHASE 2B-3 PR 5 — WHO IS TOLD, AND WHAT A LAPSE LEAVES BEHIND, AGAINST REAL
 * POSTGRESQL.
 *
 *   - A request is put to the people who may DECIDE it: holders of the action's
 *     own permission. A pause reaches a campaign manager who cannot publish; a
 *     retry does not.
 *   - The expiry sweep reads the open requests oldest window first through M4,
 *     and a lapse writes `automation.run_expired` once, in the same transaction
 *     as the status, and never for a request somebody decided.
 *
 * THE EXPIRY DATES ARE IN 2000 and the sweep's clock in 2001, so the real
 * cross-tenant sweep sees only this suite's requests.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AutomationPolicy;
let campaignManagerId: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const owner = (): AutomationActor => ({
  userId: fixtures.a.userId,
  roleKey: 'workspace_owner',
  permissionKeys: [
    'workspace.read',
    'automation.read',
    'automation.manage',
    'publishing.manage',
    'campaigns.manage',
  ],
  brandScope: [],
});

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  await ensureWorkspaceRbac(platform);
  policy = parseAutomationPolicy(defaultPayload('automations'));

  // A member who runs campaigns and may NOT publish: no built-in role is that.
  const run = randomUUID().slice(0, 8);
  const role = await platform.role.create({
    data: {
      workspaceId: null,
      key: `pr5-campaigns-${run}`,
      realm: 'WORKSPACE',
      nameEn: 'PR 5 campaign manager',
      nameAr: 'PR 5 campaign manager',
    },
  });
  const keys = ['workspace.read', 'automation.read', 'campaigns.read', 'campaigns.manage'];
  const permissions = await platform.permission.findMany({ where: { key: { in: keys } } });
  expect(permissions).toHaveLength(keys.length);
  await platform.rolePermission.createMany({
    data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
  });
  const user = await platform.user.create({
    data: {
      email: `pr5-cm-${run}@example.local`,
      name: 'PR 5 campaign manager',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      timezone: 'UTC',
    },
  });
  await platform.membership.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      userId: user.id,
      roleId: role.id,
      status: 'ACTIVE',
      acceptedAt: new Date(),
      brandScope: [],
    },
  });
  campaignManagerId = user.id;
}, 120_000);

afterAll(async () => {
  await platform.automationRule.updateMany({
    where: { name: { startsWith: 'pr5-gates ' } },
    data: { enabled: false },
  });
  await closeQueues();
  await app.$disconnect();
  await platform.$disconnect();
});

// --- who is told ----------------------------------------------------------------

async function failedAttempt(): Promise<string> {
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
        idempotencyKey: `pr5-gates-${randomUUID()}`,
        scheduledAtUtc: new Date(),
        attemptCount: 1,
        maxAttempts: 3,
        nextAttemptAt: null,
        failureClass: 'CONTENT_REJECTED',
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
        failureClass: 'CONTENT_REJECTED',
        finishedAt: new Date(),
        durationMs: 5,
      },
    });
    return attempt.id;
  });
}

/** A request of `actionType`, proposed by the real worker on POST_FAILED. */
async function requestOf(
  actionType: 'RETRY_PUBLISH' | 'PAUSE_CAMPAIGN',
  actionConfig: Record<string, unknown> = {},
): Promise<string> {
  const rule = await inA((db) =>
    new AutomationEngine({ db, workspaceId: fixtures.a.workspaceId, policy, ports: {} }).createRule(
      {
        brandId: fixtures.a.brandId,
        name: `pr5-gates ${randomUUID().slice(0, 8)}`,
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
  const attemptId = await failedAttempt();
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
  const run = await platform.automationRun.findFirstOrThrow({ where: { ruleId: rule.id } });
  expect(run.status).toBe('AWAITING_CONFIRMATION');
  return run.id;
}

const toldAbout = async (runId: string) =>
  (
    await platform.notification.findMany({
      where: { templateKey: 'automation.confirmation_required', resourceId: runId },
      select: { userId: true },
    })
  ).map((row) => row.userId);

describe('a request is put to the people who may decide it', () => {
  it('a pause reaches a campaign manager who cannot publish, and the owner', async () => {
    const campaign = await platform.campaign.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        name: `PR5 gates ${randomUUID().slice(0, 6)}`,
        objective: 'AWARENESS',
        status: 'ACTIVE',
        createdByUserId: fixtures.a.userId,
      },
      select: { id: true },
    });
    const told = await toldAbout(await requestOf('PAUSE_CAMPAIGN', { campaignId: campaign.id }));
    expect(told).toContain(campaignManagerId);
    expect(told).toContain(fixtures.a.userId);
  });

  it('a retry still reaches publishers only — not the campaign manager', async () => {
    const told = await toldAbout(await requestOf('RETRY_PUBLISH'));
    expect(told).toContain(fixtures.a.userId);
    expect(told).not.toContain(campaignManagerId);
  });
});

// --- what a lapse leaves behind --------------------------------------------------

const LAPSED = new Date(Date.UTC(2000, 5, 1, 9, 0));
const SWEEP_AT = new Date(Date.UTC(2001, 0, 1, 9, 0));

async function waitingSince(
  expiresAt: Date,
  overrides: { status?: 'AWAITING_CONFIRMATION' | 'CANCELLED'; confirmedAt?: Date } = {},
): Promise<string> {
  const rule = await inA((db) =>
    seedStoredRule(db, {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      name: `pr5-gates ${randomUUID().slice(0, 8)}`,
      triggerType: 'CONTENT_APPROVED',
      actionType: 'PROPOSE_PUBLISH',
      enabled: false,
      createdByUserId: fixtures.a.userId,
    }),
  );
  const run = await platform.automationRun.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      ruleId: rule.id,
      status: overrides.status ?? 'AWAITING_CONFIRMATION',
      triggerType: 'CONTENT_APPROVED',
      idempotencyKey: `pr5-gates-${randomUUID()}`,
      conditionsHeld: true,
      actionType: 'PROPOSE_PUBLISH',
      confirmationExpiresAt: expiresAt,
      confirmedAt: overrides.confirmedAt ?? null,
      // A confirmation is attributable or it is not one (the table's CHECK).
      confirmedByUserId: overrides.confirmedAt ? fixtures.a.userId : null,
      confirmationTokenHash: overrides.confirmedAt ? `pr5-gates-${randomUUID()}` : null,
      correlationId: randomUUID(),
    },
    select: { id: true },
  });
  return run.id;
}

const sweep = () =>
  new MaintenanceScheduler({
    environment: 'DEVELOPMENT',
    clock: { now: () => SWEEP_AT },
  }).sweepAutomations(500);

const lapses = (runId: string) =>
  platform.auditEvent.findMany({ where: { action: 'automation.run_expired', resourceId: runId } });

describe('a lapse is recorded once, and only for a request nobody decided', () => {
  it('the sweep ends it EXPIRED and writes automation.run_expired once, across sweeps', async () => {
    const runId = await waitingSince(LAPSED);
    await sweep();
    await sweep();
    expect(await platform.automationRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: 'EXPIRED',
      failureCode: 'confirmation_window_closed',
      confirmationTokenHash: null,
    });
    const rows = await lapses(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: fixtures.a.workspaceId,
      actorType: 'AUTOMATION',
      actorId: null,
      resourceType: 'AutomationRun',
      brandId: fixtures.a.brandId,
      reason: 'confirmation_window_closed',
    });
  });

  it('a request decided in time — or being confirmed — is never marked lapsed', async () => {
    const skipped = await waitingSince(LAPSED, { status: 'CANCELLED' });
    const confirming = await waitingSince(LAPSED, { confirmedAt: new Date() });
    const open = await waitingSince(new Date(Date.UTC(2001, 0, 2)));
    await sweep();
    for (const runId of [skipped, confirming, open]) {
      expect(await lapses(runId), runId).toHaveLength(0);
    }
    expect((await platform.automationRun.findUniqueOrThrow({ where: { id: open } })).status).toBe(
      'AWAITING_CONFIRMATION',
    );
  });

  it('two sweeps at once: one EXPIRED, one audit', async () => {
    const runId = await waitingSince(LAPSED);
    await Promise.all([sweep(), sweep()]);
    expect((await platform.automationRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      'EXPIRED',
    );
    expect(await lapses(runId)).toHaveLength(1);
  });

  it('the sweep’s read — open requests, oldest window first — can be served by M4', async () => {
    const plan = await platform.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT "id" FROM "automation_run"
          WHERE "status" = 'AWAITING_CONFIRMATION' AND "confirmedAt" IS NULL
            AND "confirmationExpiresAt" < $1
          ORDER BY "confirmationExpiresAt" ASC, "id" ASC LIMIT 500`,
        SWEEP_AT,
      );
    });
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'automation_run_awaiting_expiry_idx',
    );
  });
});
