import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { closeQueues } from '@brandspace/jobs';
import {
  AutomationEngine,
  OCCURRENCE_STALE,
  parseAutomationPolicy,
  type AutomationActor,
  type AutomationPolicy,
} from '@brandspace/automation';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import {
  DAY,
  HOUR,
  deliver,
  disableCreatedRules,
  eventsFor,
  newBrand,
  sweepAt,
  timedRule,
} from './timed-automation-fixtures';

/**
 * PHASE 2B-3 PR 3 — REMIND THE REVIEWER, AGAINST REAL POSTGRESQL.
 *
 * REVIEW_WAITING_24H × REMIND_REVIEWER, from the real sweep through the real
 * worker: `approval.reminder` goes to the assigned reviewer while they can
 * still decide the review, otherwise to every member who can — ACTIVE,
 * `content.approve`, the brand in scope (NULL scope included) — never the
 * person who asked or the post's author, never another brand's reviewer and
 * never another workspace's. Nobody eligible: BLOCKED `no_eligible_reviewer`.
 * Decided before the reminder: SKIPPED `occurrence_stale`. The creator's own
 * authority is re-checked on every run.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AutomationPolicy;
const T = new Date();

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parseAutomationPolicy(defaultPayload('automations'));
}, 90_000);

afterAll(async () => {
  await disableCreatedRules(platform);
  await closeQueues();
  await app.$disconnect();
  await platform.$disconnect();
});

/** A real member of workspace A, with a real role. */
async function member(input: {
  readonly roleKey: string;
  readonly brandScope: readonly string[] | null;
  readonly status?: 'ACTIVE' | 'SUSPENDED';
  readonly workspaceId?: string;
}): Promise<string> {
  const user = await platform.user.create({
    data: {
      email: `reminder-${randomUUID()}@example.test`,
      name: `Member ${input.roleKey}`,
      status: 'ACTIVE',
      locale: 'EN',
      timezone: 'UTC',
    },
  });
  const role = await platform.role.findFirstOrThrow({
    where: { key: input.roleKey, realm: 'WORKSPACE' },
  });
  const workspaceId = input.workspaceId ?? fixtures.a.workspaceId;
  await platform.membership.create({
    data: {
      workspaceId,
      userId: user.id,
      roleId: role.id,
      status: input.status ?? 'ACTIVE',
      // `null` leaves the column out, the way onboarding writes an owner. It
      // used to be stored NULL; since F6 the database stores `{}` instead.
      ...(input.brandScope === null ? {} : { brandScope: [...input.brandScope] }),
    },
  });
  return user.id;
}

async function setMembership(
  userId: string,
  data: { status?: 'ACTIVE' | 'SUSPENDED'; roleKey?: string; brandScope?: string[] },
): Promise<void> {
  const roleId = data.roleKey
    ? (await platform.role.findFirstOrThrow({ where: { key: data.roleKey, realm: 'WORKSPACE' } }))
        .id
    : undefined;
  await platform.membership.updateMany({
    where: { workspaceId: fixtures.a.workspaceId, userId },
    data: {
      ...(data.status ? { status: data.status } : {}),
      ...(roleId ? { roleId } : {}),
      ...(data.brandScope ? { brandScope: data.brandScope } : {}),
    },
  });
}

/**
 * A post by a copywriter, whose review the OWNER asked for 25 hours ago — so
 * the owner and the author are the two people a reminder must never reach.
 */
async function waitingReview(
  input: { readonly brandId?: string; readonly assignedToUserId?: string } = {},
) {
  const brandId = input.brandId ?? (await newBrand(platform, fixtures.a.workspaceId));
  const author = await member({ roleKey: 'copywriter', brandScope: [brandId] });
  const title = `Autumn launch ${randomUUID().slice(0, 6)}`;
  const item = await platform.contentItem.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId,
      title,
      contentType: 'POST',
      primaryLocale: 'EN',
      status: 'IN_REVIEW',
      createdByUserId: author,
    } as never,
    select: { id: true },
  });
  const approval = await platform.approval.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId,
      contentItemId: item.id,
      requestedByUserId: fixtures.a.userId,
      assignedToUserId: input.assignedToUserId ?? null,
      status: 'PENDING',
      createdAt: new Date(T.getTime() - 25 * HOUR),
    },
    select: { id: true },
  });
  return { brandId, author, title, approvalId: approval.id };
}

async function reminderRule(brandId: string, creator: string = fixtures.a.userId) {
  return timedRule(platform, {
    workspaceId: fixtures.a.workspaceId,
    brandId,
    triggerType: 'REVIEW_WAITING_24H',
    armedAt: new Date(T.getTime() - 3 * DAY),
    createdByUserId: creator,
    actionType: 'REMIND_REVIEWER',
  });
}

/** Sweep, deliver the rule's one event, and read what happened. */
async function remind(ruleId: string) {
  await sweepAt(T);
  const [event] = await eventsFor(platform, ruleId);
  expect(event, 'the review produced its event').toBeTruthy();
  await deliver(event!);
  return outcome(ruleId);
}

async function outcome(ruleId: string) {
  const runs = await platform.automationRun.findMany({
    where: { ruleId },
    select: { id: true, status: true, failureCode: true, resourceType: true, resourceId: true },
  });
  const notices = await platform.notification.findMany({
    where: {
      workspaceId: fixtures.a.workspaceId,
      templateKey: 'approval.reminder',
      idempotencyKey: { startsWith: `automation-run:${runs[0]?.id ?? 'none'}` },
    },
    select: {
      userId: true,
      payload: true,
      linkPath: true,
      brandId: true,
      resourceType: true,
      resourceId: true,
    },
  });
  return { runs, notices, recipients: notices.map((notice) => notice.userId).sort() };
}

describe('authoring', () => {
  const actor = (): AutomationActor => ({
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    permissionKeys: ['workspace.read', 'automation.manage', 'content.submit'],
    brandScope: [],
  });
  const engine = (db: TenantScopedClient) =>
    new AutomationEngine({ db, workspaceId: fixtures.a.workspaceId, policy, ports: {} });
  class RolledBack extends Error {}
  const attempt = async (triggerType: string): Promise<string> => {
    try {
      await withWorkspace(
        fixtures.a.workspaceId,
        async (db) => {
          await engine(db).createRule({
            brandId: fixtures.a.brandId,
            name: `remind ${randomUUID().slice(0, 6)}`,
            triggerType: triggerType as never,
            triggerConfig: {},
            conditions: [],
            actionType: 'REMIND_REVIEWER',
            actionConfig: {},
            actor: actor(),
          } as never);
          throw new RolledBack();
        },
        { prisma: app },
      );
    } catch (error: unknown) {
      if (error instanceof RolledBack) return 'accepted';
      return error instanceof Error ? error.message : String(error);
    }
    return 'accepted';
  };

  it('a new rule may pair it with REVIEW_WAITING_24H, and with nothing else', async () => {
    expect(await attempt('REVIEW_WAITING_24H')).toBe('accepted');
    expect(await attempt('CONTENT_APPROVED')).not.toBe('accepted');
  });
});

describe('who is reminded', () => {
  it('the assigned reviewer alone, while they can still decide it — with the post and a link', async () => {
    const brand = await newBrand(platform, fixtures.a.workspaceId);
    const assignee = await member({ roleKey: 'approver', brandScope: [brand] });
    const { brandId, title, approvalId } = await waitingReview({
      brandId: brand,
      assignedToUserId: assignee,
    });
    const other = await member({ roleKey: 'approver', brandScope: [brandId] });
    const ruleId = await reminderRule(brandId);

    const { runs, notices, recipients } = await remind(ruleId);
    expect(runs).toMatchObject([
      { status: 'SUCCEEDED', failureCode: null, resourceType: 'Approval', resourceId: approvalId },
    ]);
    expect(recipients).toEqual([assignee]);
    expect(recipients).not.toContain(other);
    expect(notices[0]).toMatchObject({
      payload: { itemTitle: title },
      linkPath: `/approvals?review=${approvalId}`,
      brandId,
      resourceType: 'Approval',
      resourceId: approvalId,
    });
  });

  it('an assignee who can no longer decide it is never used: everyone who can is reminded', async () => {
    const brand = await newBrand(platform, fixtures.a.workspaceId);
    const assignee = await member({ roleKey: 'approver', brandScope: [brand] });
    const { brandId } = await waitingReview({ brandId: brand, assignedToUserId: assignee });
    const one = await member({ roleKey: 'approver', brandScope: [brandId] });
    const two = await member({ roleKey: 'approver', brandScope: [brandId] });
    await setMembership(assignee, { status: 'SUSPENDED' });
    const ruleId = await reminderRule(brandId);

    const { runs, recipients } = await remind(ruleId);
    expect(runs[0]?.status).toBe('SUCCEEDED');
    expect(recipients).toEqual([one, two].sort());
  });

  it('unassigned: every eligible reviewer — never the asker, the author, another brand, a non-approver, a suspended member or another workspace', async () => {
    const { brandId, author } = await waitingReview();
    const eligible = [
      await member({ roleKey: 'approver', brandScope: [brandId] }),
      await member({ roleKey: 'marketing_manager', brandScope: [brandId] }),
    ];
    const otherBrand = await newBrand(platform, fixtures.a.workspaceId);
    const never = [
      await member({ roleKey: 'approver', brandScope: [otherBrand] }),
      await member({ roleKey: 'copywriter', brandScope: [brandId] }),
      await member({ roleKey: 'client_viewer', brandScope: [brandId] }),
      await member({ roleKey: 'approver', brandScope: [brandId], status: 'SUSPENDED' }),
      await member({ roleKey: 'approver', brandScope: [], workspaceId: fixtures.b.workspaceId }),
      author,
      fixtures.a.userId,
    ];
    const ruleId = await reminderRule(brandId);

    const { recipients } = await remind(ruleId);
    expect(recipients).toEqual([...eligible].sort());
    for (const userId of never) expect(recipients).not.toContain(userId);
  });

  it('a member written without a brand scope is unrestricted, and is reminded; NULL is refused (F6)', async () => {
    const { brandId } = await waitingReview();
    const unrestricted = await member({ roleKey: 'approver', brandScope: null });
    try {
      // F6: the omitted scope is stored as `{}`, and a NULL can no longer be.
      const [row] = await platform.$queryRaw<{ id: string; scope: string }[]>`
        SELECT "id", "brandScope"::text AS scope FROM "membership"
         WHERE "workspaceId" = ${fixtures.a.workspaceId}::uuid AND "userId" = ${unrestricted}::uuid`;
      expect(row?.scope).toBe('{}');
      await expect(
        platform.$executeRaw`UPDATE "membership" SET "brandScope" = NULL WHERE "id" = ${row!.id}::uuid`,
      ).rejects.toThrow(/null value in column "brandScope"|23502/);

      const ruleId = await reminderRule(brandId);
      const { recipients } = await remind(ruleId);
      expect(recipients).toEqual([unrestricted]);
    } finally {
      await setMembership(unrestricted, { status: 'SUSPENDED' });
    }
  });

  it('a reviewer who muted review notices is not reminded; the others are', async () => {
    const { brandId } = await waitingReview();
    const muted = await member({ roleKey: 'approver', brandScope: [brandId] });
    const listening = await member({ roleKey: 'approver', brandScope: [brandId] });
    await platform.notificationPreference.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        userId: muted,
        category: 'approvals',
        enabled: false,
      },
    });
    const ruleId = await reminderRule(brandId);
    const { runs, recipients } = await remind(ruleId);
    expect(runs[0]?.status).toBe('SUCCEEDED');
    expect(recipients).toEqual([listening]);
  });
});

describe('when nothing is sent', () => {
  it('nobody who can decide it: BLOCKED no_eligible_reviewer', async () => {
    const { brandId } = await waitingReview();
    // Only people who may not decide it.
    await member({ roleKey: 'copywriter', brandScope: [brandId] });
    await member({ roleKey: 'approver', brandScope: [brandId], status: 'SUSPENDED' });
    const ruleId = await reminderRule(brandId);
    const { runs, notices } = await remind(ruleId);
    expect(runs).toMatchObject([
      { status: 'BLOCKED_BY_POLICY', failureCode: 'no_eligible_reviewer' },
    ]);
    expect(notices).toHaveLength(0);
  });

  it('decided before the reminder: SKIPPED occurrence_stale', async () => {
    const { brandId, approvalId } = await waitingReview();
    await member({ roleKey: 'approver', brandScope: [brandId] });
    const ruleId = await reminderRule(brandId);
    await sweepAt(T);
    const [event] = await eventsFor(platform, ruleId);
    await platform.approval.update({
      where: { id: approvalId },
      data: { status: 'APPROVED', decidedAt: new Date(), decidedByUserId: fixtures.a.userId },
    });
    await deliver(event!);
    const { runs, notices } = await outcome(ruleId);
    expect(runs).toMatchObject([{ status: 'SKIPPED', failureCode: OCCURRENCE_STALE }]);
    expect(notices).toHaveLength(0);
  });

  it('delivered twice: one run, one reminder each', async () => {
    const { brandId } = await waitingReview();
    const reviewer = await member({ roleKey: 'approver', brandScope: [brandId] });
    const ruleId = await reminderRule(brandId);
    await sweepAt(T);
    const [event] = await eventsFor(platform, ruleId);
    await deliver(event!);
    await deliver(event!);
    const { runs, recipients } = await outcome(ruleId);
    expect(runs).toHaveLength(1);
    expect(recipients).toEqual([reviewer]);
  });
});

describe('the creator’s authority, on every run', () => {
  async function creatorCase(change: Parameters<typeof setMembership>[1]) {
    const { brandId } = await waitingReview();
    await member({ roleKey: 'approver', brandScope: [brandId] });
    const creator = await member({ roleKey: 'copywriter', brandScope: [brandId] });
    const ruleId = await reminderRule(brandId, creator);
    await sweepAt(T);
    const [event] = await eventsFor(platform, ruleId);
    await setMembership(creator, change);
    await deliver(event!);
    return outcome(ruleId);
  }

  it('no longer a member', async () => {
    const { runs, notices } = await creatorCase({ status: 'SUSPENDED' });
    expect(runs[0]?.failureCode).toBe('creator_no_longer_a_member');
    expect(notices).toHaveLength(0);
  });

  it('without content.submit', async () => {
    const { runs, notices } = await creatorCase({ roleKey: 'client_viewer' });
    expect(runs[0]).toMatchObject({
      status: 'BLOCKED_BY_AUTHORIZATION',
      failureCode: 'creator_lost_permission',
    });
    expect(notices).toHaveLength(0);
  });

  it('without the brand', async () => {
    const other = await newBrand(platform, fixtures.a.workspaceId);
    const { runs, notices } = await creatorCase({ brandScope: [other] });
    expect(runs[0]).toMatchObject({
      status: 'BLOCKED_BY_AUTHORIZATION',
      failureCode: 'creator_lost_brand_scope',
    });
    expect(notices).toHaveLength(0);
  });
});

describe('a workspace pending deletion', () => {
  it('reminds nobody', async () => {
    const { brandId } = await waitingReview();
    await member({ roleKey: 'approver', brandScope: [brandId] });
    const ruleId = await reminderRule(brandId);
    await sweepAt(T);
    const [event] = await eventsFor(platform, ruleId);
    await platform.workspace.update({
      where: { id: fixtures.a.workspaceId },
      data: {
        deletionRequestedAt: new Date(),
        deletionScheduledFor: new Date(Date.now() + 30 * DAY),
      },
    });
    try {
      await deliver(event!);
      const { runs, notices } = await outcome(ruleId);
      expect(runs).toMatchObject([
        { status: 'BLOCKED_BY_POLICY', failureCode: 'workspace_pending_deletion' },
      ]);
      expect(notices).toHaveLength(0);
    } finally {
      await platform.workspace.update({
        where: { id: fixtures.a.workspaceId },
        data: { deletionRequestedAt: null, deletionScheduledFor: null },
      });
    }
  });
});
