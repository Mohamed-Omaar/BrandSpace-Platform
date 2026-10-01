import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, writeDeniedAudit, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import {
  AutomationEngine,
  parseAutomationPolicy,
  RULE_DISABLED,
  type AutomationActor,
  type AutomationPolicy,
} from '@brandspace/automation';
import {
  appRoleClient,
  createIsolationFixtures,
  ensureWorkspaceRbac,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import { seedStoredRule } from './stored-automation-rule';

/**
 * PHASE 2B-3 PR 5 — APPROVING A REQUEST RE-CHECKS THE RULE AND ITS CREATOR,
 * AGAINST REAL POSTGRESQL (owner decisions D1 and D2).
 *
 * The approver is checked as before. Then, before a credential is issued and
 * again at approval: the rule must still be enabled and not deleted
 * (`rule_disabled`), and its creator must still be an ACTIVE member holding
 * the action's permission and the rule's brand (`creator_*`). Any one failing
 * ENDS the request — BLOCKED, audited, gone from Needs you — and nothing is
 * performed.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AutomationPolicy;
let otherBrandId: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

/** The approver: an owner of workspace A, unrestricted. */
const approver = (): AutomationActor => ({
  userId: fixtures.a.userId,
  roleKey: 'workspace_owner',
  permissionKeys: ['automation.read', 'publishing.manage'],
  brandScope: [],
});

const engine = (db: TenantScopedClient) =>
  new AutomationEngine({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy,
    ports: {},
    denialSink: async (event) => {
      await withWorkspace(
        fixtures.a.workspaceId,
        async (fresh) =>
          writeDeniedAudit(fresh, fixtures.a.workspaceId, {
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

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  await ensureWorkspaceRbac(platform);
  policy = parseAutomationPolicy(defaultPayload('automations'));
  otherBrandId = (
    await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `pr5-auth-${randomUUID().slice(0, 8)}`,
        name: 'PR 5 other brand',
        status: 'ACTIVE',
      },
      select: { id: true },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

/** A member who wrote the rule: an owner, until a test changes that. */
async function creator(): Promise<{ userId: string; membershipId: string }> {
  const user = await platform.user.create({
    data: {
      email: `pr5-creator-${randomUUID().slice(0, 8)}@example.local`,
      name: 'PR 5 creator',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  const role = await platform.role.findFirstOrThrow({
    where: { key: 'workspace_owner', workspaceId: null, realm: 'WORKSPACE' },
  });
  const membership = await platform.membership.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      userId: user.id,
      roleId: role.id,
      status: 'ACTIVE',
      acceptedAt: new Date(),
    },
  });
  return { userId: user.id, membershipId: membership.id };
}

/** An ENABLED asks-first rule by `createdByUserId`, and one request of it waiting. */
async function request(createdByUserId: string): Promise<{ ruleId: string; runId: string }> {
  const rule = await inA((db) =>
    seedStoredRule(db, {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      name: `pr5-auth ${randomUUID().slice(0, 8)}`,
      triggerType: 'CONTENT_APPROVED',
      triggerConfig: {},
      conditions: [],
      actionType: 'PROPOSE_PUBLISH',
      actionConfig: {},
      enabled: true,
      createdByUserId,
    }),
  );
  const run = await platform.automationRun.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      ruleId: rule.id,
      status: 'AWAITING_CONFIRMATION',
      triggerType: 'CONTENT_APPROVED',
      idempotencyKey: `pr5-auth-${randomUUID()}`,
      conditionsHeld: true,
      actionType: 'PROPOSE_PUBLISH',
      confirmationExpiresAt: new Date(Date.now() + 600_000),
      correlationId: randomUUID(),
    },
    select: { id: true },
  });
  return { ruleId: rule.id, runId: run.id };
}

const runOf = (runId: string) => platform.automationRun.findUniqueOrThrow({ where: { id: runId } });

async function expectEnded(
  runId: string,
  status: 'BLOCKED_BY_POLICY' | 'BLOCKED_BY_AUTHORIZATION',
  code: string,
): Promise<void> {
  const row = await runOf(runId);
  expect(row).toMatchObject({
    status,
    failureCode: code,
    confirmationTokenHash: null,
    confirmedAt: null,
  });
  expect(row.finishedAt).not.toBeNull();
  const refused = await platform.auditEvent.findFirstOrThrow({
    where: { resourceId: runId, action: 'automation.confirmation_refused' },
  });
  expect(refused).toMatchObject({ actorId: fixtures.a.userId, reason: code });
  const ran = await platform.auditEvent.findFirstOrThrow({
    where: { resourceId: runId, action: 'automation.run' },
  });
  expect(ran.reason).toBe(code);
  // Gone from Needs you.
  const waiting = await inA((db) =>
    engine(db).awaitingRuns({ brandScope: [], permissionKeys: approver().permissionKeys }),
  );
  expect(waiting.map((run) => run.id)).not.toContain(runId);
}

describe('the rule (D2): switched off or deleted ends the request', () => {
  it('switched off: no credential, BLOCKED rule_disabled', async () => {
    const { userId } = await creator();
    const { ruleId, runId } = await request(userId);
    await platform.automationRule.update({ where: { id: ruleId }, data: { enabled: false } });
    const issued = await inA((db) =>
      engine(db).reissueRunConfirmation({ runId, actor: approver() }),
    );
    expect(issued.token).toBeNull();
    await expectEnded(runId, 'BLOCKED_BY_POLICY', RULE_DISABLED);
  });

  it('deleted after the credential was issued: approval ends it, nothing performed', async () => {
    const { userId } = await creator();
    const { ruleId, runId } = await request(userId);
    const issued = await inA((db) =>
      engine(db).reissueRunConfirmation({ runId, actor: approver() }),
    );
    expect(issued.token).toEqual(expect.any(String));
    await platform.automationRule.update({
      where: { id: ruleId },
      data: { deletedAt: new Date() },
    });
    const run = await inA((db) =>
      engine(db).confirmRun({ runId, token: issued.token!, actor: approver() }),
    );
    expect(run.status).toBe('BLOCKED_BY_POLICY');
    await expectEnded(runId, 'BLOCKED_BY_POLICY', RULE_DISABLED);
  });
});

describe('the creator (D1): authority lost while the request waited ends it', () => {
  it('no longer a member', async () => {
    const { userId, membershipId } = await creator();
    const { runId } = await request(userId);
    await platform.membership.update({
      where: { id: membershipId },
      data: { status: 'SUSPENDED' },
    });
    expect(
      (await inA((db) => engine(db).reissueRunConfirmation({ runId, actor: approver() }))).token,
    ).toBeNull();
    await expectEnded(runId, 'BLOCKED_BY_AUTHORIZATION', 'creator_no_longer_a_member');
  });

  it('lost the action’s permission', async () => {
    const { userId, membershipId } = await creator();
    const { runId } = await request(userId);
    const analyst = await platform.role.findFirstOrThrow({
      where: { key: 'analyst', workspaceId: null, realm: 'WORKSPACE' },
    });
    await platform.membership.update({ where: { id: membershipId }, data: { roleId: analyst.id } });
    const issued = await inA((db) =>
      engine(db).reissueRunConfirmation({ runId, actor: approver() }),
    );
    expect(issued.token).toBeNull();
    await expectEnded(runId, 'BLOCKED_BY_AUTHORIZATION', 'creator_lost_permission');
  });

  it('lost the rule’s brand — checked again at approval, after the credential', async () => {
    const { userId, membershipId } = await creator();
    const { runId } = await request(userId);
    const issued = await inA((db) =>
      engine(db).reissueRunConfirmation({ runId, actor: approver() }),
    );
    expect(issued.token).toEqual(expect.any(String));
    await platform.membership.update({
      where: { id: membershipId },
      data: { brandScope: [otherBrandId] },
    });
    const run = await inA((db) =>
      engine(db).confirmRun({ runId, token: issued.token!, actor: approver() }),
    );
    expect(run.status).toBe('BLOCKED_BY_AUTHORIZATION');
    await expectEnded(runId, 'BLOCKED_BY_AUTHORIZATION', 'creator_lost_brand_scope');
  });

  it('still authorized: a credential is issued and the request still waits', async () => {
    const { userId } = await creator();
    const { runId } = await request(userId);
    const issued = await inA((db) =>
      engine(db).reissueRunConfirmation({ runId, actor: approver() }),
    );
    expect(issued.token).toEqual(expect.any(String));
    expect((await runOf(runId)).status).toBe('AWAITING_CONFIRMATION');
  });
});

describe('ending never lands on a decided request', () => {
  it('skipped first: the later approval attempt is refused and the skip stands', async () => {
    const { userId, membershipId } = await creator();
    const { runId } = await request(userId);
    await inA((db) => engine(db).skipRun({ runId, actor: approver() }));
    await platform.membership.update({
      where: { id: membershipId },
      data: { status: 'SUSPENDED' },
    });
    await expect(
      inA((db) => engine(db).reissueRunConfirmation({ runId, actor: approver() })),
    ).rejects.toThrow();
    expect(await runOf(runId)).toMatchObject({
      status: 'CANCELLED',
      failureCode: 'skipped_by_member',
    });
  });
});
