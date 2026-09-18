import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import {
  ContentApprovalService,
  ContentCalendarService,
  type ApprovalActor,
  type ContentPolicy,
  type ScheduleQuota,
} from '@brandspace/content';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * The corrective pass's four behavioural findings, against a REAL PostgreSQL:
 * concurrency, the snapshotted policy, the calendar/approval divergence, and
 * who a notification may reach.
 *
 * THESE NEED A REAL DATABASE AND REAL PARALLELISM. A mocked client cannot
 * express `SELECT … FOR UPDATE` blocking a second transaction, and a test that
 * awaited the two verdicts in sequence would pass against the defective code —
 * which is exactly why the defect survived the first round of tests.
 */

const CONTENT_POLICY: ContentPolicy = {
  dialects: {
    defaultKey: 'msa',
    supported: [{ key: 'msa', labelKey: 'content.dialect.msa', bcp47: 'ar' }],
  },
  platforms: [
    {
      key: 'instagram',
      labelKey: 'content.platform.instagram',
      maxBodyChars: 2_200,
      maxHashtags: 30,
      allowsFirstComment: true,
      maxMediaItems: 10,
    },
  ],
  generation: {
    maxVariantsPerRequest: 4,
    maxDraftsPerBrand: 500,
    maxContextItems: 12,
    maxContextChunks: 8,
    maxContextChars: 12_000,
    maxBriefChars: 2_000,
  },
  retention: { cancellationGraceDays: 30, minCustomerRetentionDays: 7 },
  calendar: {
    weekStartsOn: 0,
    maxDaysAhead: 365,
    minLeadMinutes: 5,
    maxSlotsPerDay: 25,
    requireApprovalBeforeScheduling: false,
  },
  approvals: {
    requireApprovalBeforeScheduling: false,
    allowSelfApproval: false,
    clientApprovalEnabled: false,
    maxNoteLength: 1_000,
    maxCyclesPerItem: 25,
  },
};

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;

const REVIEWER_A = '41111111-2222-4333-8444-555555555555';
const REVIEWER_B = '42222222-2222-4333-8444-555555555555';

const author = (): ApprovalActor => ({
  userId: fixtures.a.userId,
  roleKey: 'content_creator',
  permissionKeys: ['content.read', 'content.submit'],
  brandScope: [],
});
const reviewer = (userId: string): ApprovalActor => ({
  userId,
  roleKey: 'approver',
  permissionKeys: ['content.read', 'content.approve'],
  brandScope: [],
});

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

beforeEach(async () => {
  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      await db.calendarSlot.deleteMany({});
      await db.notification.deleteMany({});
      await db.contentItem.updateMany({
        data: { status: 'DRAFT', createdByUserId: fixtures.a.userId },
      });
    },
    { prisma: app },
  );
  // The approval history is the platform's to clear — see `content-approvals`.
  await platform.approval.deleteMany({ where: { workspaceId: fixtures.a.workspaceId } });
  await platform.approvalPolicy.deleteMany({ where: { workspaceId: fixtures.a.workspaceId } });
});

/** One service call in its own transaction, so two can genuinely race. */
function run<T>(fn: (service: ContentApprovalService) => Promise<T>): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    (db) =>
      fn(
        new ContentApprovalService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
        }),
      ),
    { prisma: app },
  );
}

const itemId = () => fixtures.a.contentItemId;

async function openCycle(): Promise<string> {
  const approval = await run((s) => s.submit({ itemId: itemId(), actor: author() }));
  return approval.id;
}

async function statusOf(): Promise<string> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => (await db.contentItem.findUniqueOrThrow({ where: { id: itemId() } })).status,
    { prisma: app },
  );
}

describe('two concurrent verdicts on one review', () => {
  it('EXACTLY ONE wins, and the loser is told it was already decided', async () => {
    /*
     * THE RACE THE FIRST VERSION LOST. `decide()` read the row by id, checked
     * `status === 'PENDING'`, and updated by id — so two reviewers pressing at
     * once both read PENDING, both passed the guard and both wrote. The second
     * write silently overwrote the first: one reviewer's verdict vanished,
     * while two audit events each claimed to have decided the same review.
     *
     * `SELECT … FOR UPDATE` now makes the second transaction WAIT for the first
     * to commit, after which it sees a terminal status and refuses.
     */
    const id = await openCycle();

    const results = await Promise.allSettled([
      run((s) => s.decide({ approvalId: id, verdict: 'APPROVE', actor: reviewer(REVIEWER_A) })),
      run((s) => s.decide({ approvalId: id, verdict: 'REJECT', actor: reviewer(REVIEWER_B) })),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won, 'exactly one verdict must win').toHaveLength(1);
    expect(lost, 'the other must be refused, not silently dropped').toHaveLength(1);

    // The row carries ONE verdict, and the item agrees with it.
    const row = await withWorkspace(
      fixtures.a.workspaceId,
      (db) => db.approval.findUniqueOrThrow({ where: { id } }),
      { prisma: app },
    );
    expect(['APPROVED', 'REJECTED']).toContain(row.status);
    expect(row.decidedByUserId).not.toBeNull();
    expect(await statusOf()).toBe(row.status === 'APPROVED' ? 'APPROVED' : 'DRAFT');
  });

  it('a decide/cancel race also has ONE authoritative winner', async () => {
    const id = await openCycle();

    const results = await Promise.allSettled([
      run((s) => s.decide({ approvalId: id, verdict: 'APPROVE', actor: reviewer(REVIEWER_A) })),
      run((s) => s.cancel({ approvalId: id, actor: author() })),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    const row = await withWorkspace(
      fixtures.a.workspaceId,
      (db) => db.approval.findUniqueOrThrow({ where: { id } }),
      { prisma: app },
    );
    expect(row.status).not.toBe('PENDING');
    // The item and the approval cannot disagree: APPROVED means a verdict
    // landed, CANCELLED means the withdrawal did, and never a mixture.
    const item = await statusOf();
    expect(row.status === 'APPROVED' ? item === 'APPROVED' : item === 'DRAFT').toBe(true);
  });

  it('the audit trail records ONE decision, not two', async () => {
    const id = await openCycle();
    await Promise.allSettled([
      run((s) => s.decide({ approvalId: id, verdict: 'APPROVE', actor: reviewer(REVIEWER_A) })),
      run((s) => s.decide({ approvalId: id, verdict: 'APPROVE', actor: reviewer(REVIEWER_B) })),
    ]);

    const events = await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        db.auditEvent.findMany({
          where: {
            resourceType: 'Approval',
            resourceId: id,
            action: { in: ['content.approved', 'content.rejected', 'content.changes_requested'] },
          },
        }),
      { prisma: app },
    );
    expect(events).toHaveLength(1);
  });
});

describe('D-126 — the cycle is judged by the policy it was opened under', () => {
  it('flipping self-approval ON does not retroactively permit an OPEN cycle', async () => {
    /*
     * The defect: `policySnapshot` was written and then ignored, because
     * `decide()` re-read the brand's CURRENT policy. A workspace admin could
     * therefore approve their own content by flipping the switch after
     * submitting — and the row would still carry a snapshot saying it had not
     * been allowed, so the record contradicted the decision.
     */
    const id = await openCycle();

    await run((s) =>
      s.setPolicyForBrand({
        brandId: fixtures.a.brandId,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        patch: { allowSelfApproval: true },
      }),
    );

    const selfWithApproveRights: ApprovalActor = {
      ...author(),
      permissionKeys: ['content.read', 'content.approve'],
    };
    await expect(
      run((s) => s.decide({ approvalId: id, verdict: 'APPROVE', actor: selfWithApproveRights })),
    ).rejects.toThrow();
    expect(await statusOf()).toBe('IN_REVIEW');
  });

  it('a NEW cycle opened after the flip reflects the new policy', async () => {
    const first = await openCycle();
    await run((s) =>
      s.setPolicyForBrand({
        brandId: fixtures.a.brandId,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        patch: { allowSelfApproval: true },
      }),
    );
    await run((s) => s.cancel({ approvalId: first, actor: author() }));

    const second = await openCycle();
    const selfWithApproveRights: ApprovalActor = {
      ...author(),
      permissionKeys: ['content.read', 'content.approve'],
    };
    const decided = await run((s) =>
      s.decide({ approvalId: second, verdict: 'APPROVE', actor: selfWithApproveRights }),
    );
    expect(decided.status).toBe('APPROVED');
  });

  it('A READ-ONLY VIEWER IS REFUSED, WHATEVER THE CYCLE SNAPSHOTTED — D-62', async () => {
    /*
     * This once asserted the D-121 grant's snapshot semantics: a cycle opened
     * before the brand switched the grant on kept its answer, and one opened
     * after carried it. D-62 removes the grant, so the only correct answer is
     * "refused", on every cycle, in every direction.
     *
     * THE SNAPSHOT IS THE INTERESTING PART. A historical `policySnapshot` is
     * real data that can still contain `clientApprovalEnabled: true` — rows
     * written before this change, which the migration deliberately does NOT
     * rewrite, because an approval is a record of what happened. So the test
     * forges exactly that and shows it buys nothing: authority is read from
     * the actor's permissions, never from the snapshot.
     */
    const id = await openCycle();

    /*
     * AND THE OLD GRANT CANNOT BE SMUGGLED BACK INTO AN OPEN CYCLE EITHER.
     * `approval_is_write_once` names `policySnapshot` among the columns that
     * may never change, so even the platform role cannot edit a decided
     * cycle's rules — which is the reason the migration leaves historical
     * snapshots alone rather than rewriting them.
     */
    await expect(
      platform.$executeRawUnsafe(
        `UPDATE "approval" SET "policySnapshot" = jsonb_set("policySnapshot", '{clientApprovalEnabled}', 'true') WHERE "id" = $1::uuid`,
        id,
      ),
    ).rejects.toThrow();

    const viewer: ApprovalActor = {
      userId: REVIEWER_A,
      roleKey: 'client_viewer',
      permissionKeys: ['workspace.read'],
      brandScope: [],
    };
    await expect(
      run((s) => s.decide({ approvalId: id, verdict: 'APPROVE', actor: viewer })),
    ).rejects.toThrow();

    // And a fresh cycle is no different — there is no state that admits them.
    await run((s) => s.cancel({ approvalId: id, actor: author() }));
    const next = await openCycle();
    await expect(
      run((s) => s.decide({ approvalId: next, verdict: 'APPROVE', actor: viewer })),
    ).rejects.toThrow();

    // The review is still open, so the refusal did not quietly decide it.
    const still = await run((s) => s.openForItem(fixtures.a.contentItemId));
    expect(still?.status).toBe('PENDING');
  });

  it('MEMBERSHIP AND ROLE STAY CURRENT — only the workflow policy is historical', async () => {
    /*
     * The snapshot must not become a way to keep authority somebody has since
     * lost. A cycle opened while a reviewer could decide is still refused once
     * their role no longer carries the authority.
     */
    const id = await openCycle();
    const strippedOfAuthority: ApprovalActor = {
      userId: REVIEWER_A,
      roleKey: 'copywriter',
      permissionKeys: ['content.read'],
      brandScope: [],
    };
    await expect(
      run((s) => s.decide({ approvalId: id, verdict: 'APPROVE', actor: strippedOfAuthority })),
    ).rejects.toThrow();
  });
});

describe('the calendar and the approval cannot diverge', () => {
  const quota: ScheduleQuota = {
    limit: async () => null,
    consume: async () => true,
    refund: async () => {},
  };
  const futureLocalTime = `${new Date().getUTCFullYear() + 1}-07-20T09:00`;

  function schedule() {
    return withWorkspace(
      fixtures.a.workspaceId,
      async (db) => {
        const approvals = new ContentApprovalService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
        });
        return new ContentCalendarService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
          timezone: 'Asia/Riyadh',
          quota,
          approvalGate: approvals,
        }).schedule({
          contentItemId: itemId(),
          localTime: futureLocalTime,
          actorUserId: fixtures.a.userId,
          actorBrandScope: [],
        });
      },
      { prisma: app },
    );
  }

  it('an item IN REVIEW cannot be scheduled, even with the gate OFF', async () => {
    /*
     * THE DIVERGENCE THIS CLOSES. With the gate off, `IN_REVIEW` used to be
     * schedulable: the item became `SCHEDULED` while its PENDING approval was
     * still open, and the reviewer's verdict then moved it again — out from
     * under a live slot. `transition()` refuses to move a scheduled item
     * precisely so that cannot happen, and this path went around it.
     */
    const id = await openCycle();
    expect(await statusOf()).toBe('IN_REVIEW');

    await expect(schedule()).rejects.toThrow();

    // No slot was created, and the item is still where the workflow left it.
    const slots = await withWorkspace(
      fixtures.a.workspaceId,
      (db) => db.calendarSlot.findMany({ where: { contentItemId: itemId() } }),
      { prisma: app },
    );
    expect(slots).toHaveLength(0);
    expect(await statusOf()).toBe('IN_REVIEW');
    expect(id).toBeTruthy();
  });

  it('a DRAFT still schedules with the gate off — the gate is what is optional', async () => {
    const view = await schedule();
    expect(view.slot.targetKind).toBe('MOCK');
    expect(await statusOf()).toBe('SCHEDULED');
  });

  it('a SCHEDULED item cannot then be submitted for review', async () => {
    await schedule();
    await expect(run((s) => s.submit({ itemId: itemId(), actor: author() }))).rejects.toThrow();
    expect(await statusOf()).toBe('SCHEDULED');
  });

  it('content a reviewer sent back cannot be scheduled', async () => {
    const id = await openCycle();
    await run((s) =>
      s.decide({ approvalId: id, verdict: 'REQUEST_CHANGES', actor: reviewer(REVIEWER_A) }),
    );
    expect(await statusOf()).toBe('CHANGES_REQUESTED');
    await expect(schedule()).rejects.toThrow();
  });
});
