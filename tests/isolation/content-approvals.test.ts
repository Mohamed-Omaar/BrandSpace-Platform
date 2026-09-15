import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import {
  ContentApprovalService,
  ContentCalendarService,
  ContentLibraryService,
  mayApproveForBrand,
  type ApprovalActor,
  type ContentPolicy,
  type ScheduleQuota,
} from '@brandspace/content';
import { NotificationService, type NotificationView } from '@brandspace/notifications';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * The Approvals workflow against a real PostgreSQL — Phase 5B-3, and the
 * closure of AC-14.6 / D-120.
 *
 * Every read and write runs on the TENANT pool inside a workspace transaction,
 * so RLS applies to all of it and the transitions are measured through the
 * database rather than through a mock.
 *
 * WHAT THIS FILE IS REALLY ASSERTING: that there is ONE content lifecycle. The
 * item's status and the approval's status move together or not at all, and
 * every route into `IN_REVIEW` and `APPROVED` goes through this service.
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
    maxNoteLength: 40,
    maxCyclesPerItem: 3,
  },
};

let fixtures: IsolationFixtures;
let app: PrismaClient;
/**
 * CLEANUP RUNS AS THE PLATFORM ROLE, not as the application role.
 *
 * `20260915210000_phase_5b_3_approval_integrity` revoked DELETE on `approval`
 * from `brandspace_app` and made a decided cycle immutable: an approval is the
 * record that somebody reviewed something, and the application has no business
 * erasing or rewriting one. Tenant offboarding and the retention purge run as
 * the PLATFORM role, so that is what a test fixture uses to reset state —
 * rather than the production grant being widened to make cleanup convenient,
 * which would have quietly handed every workspace admin the same power.
 */
let platform: PrismaClient;

/** The author. Holds `content.submit`, and deliberately not `content.approve`. */
const author = (): ApprovalActor => ({
  userId: fixtures.a.userId,
  roleKey: 'content_creator',
  permissionKeys: ['content.read', 'content.submit'],
  brandScope: [],
});

/** A second person, who reviews. A different user id is the whole point. */
const REVIEWER_ID = '11111111-2222-4333-8444-555555555555';
const reviewer = (): ApprovalActor => ({
  userId: REVIEWER_ID,
  roleKey: 'approver',
  permissionKeys: ['content.read', 'content.approve'],
  brandScope: [],
});

/** Someone who may read but may not judge. */
const bystander = (): ApprovalActor => ({
  userId: '99999999-8888-4777-8666-555555555555',
  roleKey: 'copywriter',
  permissionKeys: ['content.read', 'content.submit'],
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

/**
 * Every test starts from a clean draft with no review history and no policy
 * override. The fixture ships a decided approval and a departing policy so the
 * TENANCY suite has something to measure; this suite owns its own state.
 */
beforeEach(async () => {
  // The rows the APPLICATION may still remove, as the application.
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
  // And the approval history, as the platform — see the note on `platform`.
  await platform.approval.deleteMany({ where: { workspaceId: fixtures.a.workspaceId } });
  await platform.approvalPolicy.deleteMany({ where: { workspaceId: fixtures.a.workspaceId } });
});

function inA<T>(
  fn: (services: {
    approvals: ContentApprovalService;
    library: ContentLibraryService;
    db: Parameters<Parameters<typeof withWorkspace>[1]>[0];
  }) => Promise<T>,
) {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn({
        approvals: new ContentApprovalService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
        }),
        library: new ContentLibraryService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
        }),
        db,
      }),
    { prisma: app },
  );
}

const itemId = () => fixtures.a.contentItemId;

async function statusOf(): Promise<string> {
  return inA(async ({ db }) => {
    const row = await db.contentItem.findUniqueOrThrow({ where: { id: itemId() } });
    return row.status;
  });
}

describe('submitting for review', () => {
  it('moves the item to IN_REVIEW and opens a cycle, together', async () => {
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author(), note: 'Ready for you.' }),
    );
    expect(approval.status).toBe('PENDING');
    expect(approval.cycle).toBe(1);
    expect(approval.requestedByUserId).toBe(fixtures.a.userId);
    expect(await statusOf()).toBe('IN_REVIEW');
  });

  it('SNAPSHOTS the policy in force, so a later change cannot rewrite it', async () => {
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    expect(approval.policySnapshot).toMatchObject({ allowSelfApproval: false });

    await inA(({ approvals }) =>
      approvals.setPolicyForBrand({
        brandId: fixtures.a.brandId,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        patch: { allowSelfApproval: true },
      }),
    );
    const reread = await inA(({ db }) =>
      db.approval.findUniqueOrThrow({ where: { id: approval.id } }),
    );
    expect(reread.policySnapshot).toMatchObject({ allowSelfApproval: false });
  });

  /*
   * THE SCREEN AND THE SERVER MUST REACH THE SAME VERDICT.
   *
   * `decide()` was corrected to judge a cycle by its snapshot (D-126), but
   * `reviewSubject()` still answered `mayDecide: true` from the permission and
   * the status alone — so the review card offered an Approve button to the very
   * person the snapshot barred, and pressing it earned a refusal. A screen that
   * offers a verdict the server rejects teaches the rule by denial.
   */
  it('reviewSubject().mayDecide AGREES with decide(): self, under the snapshot', async () => {
    // One person who may both send and judge — the case D-122 is about.
    const selfApprover = (): ApprovalActor => ({
      userId: fixtures.a.userId,
      roleKey: 'approver',
      permissionKeys: ['content.read', 'content.submit', 'content.approve'],
      brandScope: [],
    });

    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: selfApprover() }),
    );
    expect(approval.policySnapshot).toMatchObject({ allowSelfApproval: false });

    // The brand relaxes the rule AFTER the cycle is already open.
    await inA(({ approvals }) =>
      approvals.setPolicyForBrand({
        brandId: fixtures.a.brandId,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        patch: { allowSelfApproval: true },
      }),
    );

    // The card withholds the verdict...
    const subject = await inA(({ approvals }) =>
      approvals.reviewSubject({ approvalId: approval.id, actor: selfApprover() }),
    );
    expect(subject.mayDecide).toBe(false);

    // ...and the server would have refused it, which is why.
    await expect(
      inA(({ approvals }) =>
        approvals.decide({ approvalId: approval.id, verdict: 'APPROVE', actor: selfApprover() }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a SECOND open review for the same item', async () => {
    await inA(({ approvals }) => approvals.submit({ itemId: itemId(), actor: author() }));
    await expect(
      inA(({ approvals }) => approvals.submit({ itemId: itemId(), actor: author() })),
    ).rejects.toThrow();
  });

  it('refuses to submit an ARCHIVED item', async () => {
    await inA(({ library }) =>
      library.transition({
        itemId: itemId(),
        to: 'ARCHIVED',
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
      }),
    );
    await expect(
      inA(({ approvals }) => approvals.submit({ itemId: itemId(), actor: author() })),
    ).rejects.toThrow();
  });

  it('refuses a note longer than the policy allows', async () => {
    await expect(
      inA(({ approvals }) =>
        approvals.submit({ itemId: itemId(), actor: author(), note: 'x'.repeat(41) }),
      ),
    ).rejects.toThrow();
  });

  it('enforces the cycle ceiling', async () => {
    for (let i = 0; i < CONTENT_POLICY.approvals.maxCyclesPerItem; i += 1) {
      const approval = await inA(({ approvals }) =>
        approvals.submit({ itemId: itemId(), actor: author() }),
      );
      await inA(({ approvals }) =>
        approvals.decide({
          approvalId: approval.id,
          verdict: 'REQUEST_CHANGES',
          actor: reviewer(),
        }),
      );
    }
    await expect(
      inA(({ approvals }) => approvals.submit({ itemId: itemId(), actor: author() })),
    ).rejects.toThrow();
  });
});

describe('deciding a review', () => {
  async function open(): Promise<string> {
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    return approval.id;
  }

  it('APPROVE moves the item to APPROVED', async () => {
    const id = await open();
    const decided = await inA(({ approvals }) =>
      approvals.decide({ approvalId: id, verdict: 'APPROVE', actor: reviewer() }),
    );
    expect(decided.status).toBe('APPROVED');
    expect(decided.decidedByUserId).toBe(REVIEWER_ID);
    expect(decided.decidedAt).toBeInstanceOf(Date);
    expect(await statusOf()).toBe('APPROVED');
  });

  it('REQUEST_CHANGES returns the item to an EDITABLE state', async () => {
    const id = await open();
    await inA(({ approvals }) =>
      approvals.decide({
        approvalId: id,
        verdict: 'REQUEST_CHANGES',
        actor: reviewer(),
        note: 'Shorten it.',
      }),
    );
    expect(await statusOf()).toBe('CHANGES_REQUESTED');
  });

  it('REJECT also returns the item to an editable state — content is never trapped', async () => {
    const id = await open();
    await inA(({ approvals }) =>
      approvals.decide({ approvalId: id, verdict: 'REJECT', actor: reviewer() }),
    );
    expect(await statusOf()).toBe('DRAFT');
  });

  it('a decided cycle cannot be decided twice', async () => {
    const id = await open();
    await inA(({ approvals }) =>
      approvals.decide({ approvalId: id, verdict: 'APPROVE', actor: reviewer() }),
    );
    await expect(
      inA(({ approvals }) =>
        approvals.decide({ approvalId: id, verdict: 'REJECT', actor: reviewer() }),
      ),
    ).rejects.toThrow();
  });

  it('a member without review authority is REFUSED, and the refusal is audited', async () => {
    const id = await open();

    /*
     * AC-15.6, and the reason `denialSink` exists. The refusal throws, which
     * rolls back the transaction it was raised in — so an audit row written just
     * before the throw would roll back with it. The sink writes on its own
     * connection, exactly as `apps/dashboard` wires it.
     */
    const sink = async (event: {
      approvalId: string;
      brandId: string;
      actorUserId: string;
      reason: string;
    }) => {
      await withWorkspace(
        fixtures.a.workspaceId,
        (db) =>
          db.auditEvent.create({
            data: {
              workspaceId: fixtures.a.workspaceId,
              actorType: 'USER',
              actorId: event.actorUserId,
              action: 'content.approval_denied',
              resourceType: 'Approval',
              resourceId: event.approvalId,
              brandId: event.brandId,
              severity: 'WARNING',
              outcome: 'DENIED',
              reason: event.reason,
            },
          }),
        { prisma: app },
      );
    };

    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        (db) =>
          new ContentApprovalService({
            db,
            workspaceId: fixtures.a.workspaceId,
            policy: CONTENT_POLICY,
            denialSink: sink,
          }).decide({ approvalId: id, verdict: 'APPROVE', actor: bystander() }),
        { prisma: app },
      ),
    ).rejects.toThrow();
    expect(await statusOf()).toBe('IN_REVIEW');

    const denials = await inA(({ db }) =>
      db.auditEvent.findMany({ where: { action: 'content.approval_denied', resourceId: id } }),
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]?.outcome).toBe('DENIED');
    expect(denials[0]?.reason).toBe('not_permitted');
  });
});

describe('D-122 — self-approval', () => {
  it('is REFUSED by default, for the requester', async () => {
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    // The author here also holds approve rights — the permission is not what is
    // being tested, the identity is.
    const authorWhoCanApprove: ApprovalActor = { ...author(), permissionKeys: ['content.approve'] };
    await expect(
      inA(({ approvals }) =>
        approvals.decide({
          approvalId: approval.id,
          verdict: 'APPROVE',
          actor: authorWhoCanApprove,
        }),
      ),
    ).rejects.toThrow();
    expect(await statusOf()).toBe('IN_REVIEW');
  });

  it('is REFUSED for the AUTHOR even when somebody else submitted it', async () => {
    /*
     * The case a requester-only check would miss: an author asks a colleague to
     * submit on their behalf, then approves their own words.
     */
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: bystander() }),
    );
    const authorWhoCanApprove: ApprovalActor = { ...author(), permissionKeys: ['content.approve'] };
    await expect(
      inA(({ approvals }) =>
        approvals.decide({
          approvalId: approval.id,
          verdict: 'APPROVE',
          actor: authorWhoCanApprove,
        }),
      ),
    ).rejects.toThrow();
  });

  it('is PERMITTED when the brand deliberately allows it', async () => {
    await inA(({ approvals }) =>
      approvals.setPolicyForBrand({
        brandId: fixtures.a.brandId,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        patch: { allowSelfApproval: true },
      }),
    );
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    const authorWhoCanApprove: ApprovalActor = { ...author(), permissionKeys: ['content.approve'] };
    const decided = await inA(({ approvals }) =>
      approvals.decide({
        approvalId: approval.id,
        verdict: 'APPROVE',
        actor: authorWhoCanApprove,
      }),
    );
    expect(decided.status).toBe('APPROVED');
    expect(await statusOf()).toBe('APPROVED');
  });
});

describe('D-62 — the Viewer is strictly read-only, end to end', () => {
  /*
   * This block used to prove D-121: a per-brand switch admitted `client_viewer`
   * as a reviewer. D-62 supersedes it. The MVP has no Client Portal, no client
   * hand-off workflow and no external reviewer surface, so there is nothing for
   * such a grant to belong to; the idea is deferred to a future External Review
   * / Guest Approval capability with its own narrow actor.
   *
   * What replaces it is the opposite proof, at every layer that used to carry
   * the grant.
   */
  const viewer = (): ApprovalActor => ({
    userId: '77777777-6666-4555-8444-333333333333',
    roleKey: 'client_viewer',
    permissionKeys: ['workspace.read'],
    brandScope: [],
  });

  it('the rule cannot be told about a role or a brand at all', () => {
    // No `roleKey`, no `policy` — the signature is the guarantee.
    expect(mayApproveForBrand({ permissionKeys: ['workspace.read'] })).toBe(false);
    expect(mayApproveForBrand({ permissionKeys: ['content.read', 'content.submit'] })).toBe(false);
    expect(mayApproveForBrand({ permissionKeys: ['content.approve'] })).toBe(true);
  });

  it('a Viewer cannot DECIDE a review', async () => {
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    await expect(
      inA(({ approvals }) =>
        approvals.decide({ approvalId: approval.id, verdict: 'APPROVE', actor: viewer() }),
      ),
    ).rejects.toThrow();
    // Still open: the refusal did not quietly decide it.
    expect(await statusOf()).toBe('IN_REVIEW');
  });

  it('a Viewer cannot WITHDRAW somebody else’s review', async () => {
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    await expect(
      inA(({ approvals }) => approvals.cancel({ approvalId: approval.id, actor: viewer() })),
    ).rejects.toThrow();
  });

  it('a Viewer cannot READ the review subject — NOT_FOUND, not FORBIDDEN', async () => {
    /*
     * `reviewSubject()` was the Viewer's one authorized read under D-121, and
     * it admitted anybody who could decide EVEN WITHOUT `content.read`. That
     * bypass is closed: the subject is content, and reading content needs the
     * content permission. The refusal is shaped like a miss so the existence
     * of the review is not disclosed by the error.
     */
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    await expect(
      inA(({ approvals }) => approvals.reviewSubject({ approvalId: approval.id, actor: viewer() })),
    ).rejects.toThrow(/not found/i);
  });

  it('a Viewer is not an eligible reviewer, so cannot be ASSIGNED one', async () => {
    await expect(
      inA(({ approvals }) =>
        approvals.submit({
          itemId: itemId(),
          actor: author(),
          assignedToUserId: viewer().userId,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('withdrawing a review', () => {
  it('returns the item to a draft and closes the cycle', async () => {
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    const cancelled = await inA(({ approvals }) =>
      approvals.cancel({ approvalId: approval.id, actor: author() }),
    );
    expect(cancelled.status).toBe('CANCELLED');
    expect(await statusOf()).toBe('DRAFT');
  });

  it('a member who neither asked nor may decide cannot withdraw it', async () => {
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    await expect(
      inA(({ approvals }) => approvals.cancel({ approvalId: approval.id, actor: bystander() })),
    ).rejects.toThrow();
  });

  it('withdrawing frees the item for a NEW cycle', async () => {
    const first = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    await inA(({ approvals }) => approvals.cancel({ approvalId: first.id, actor: author() }));
    const second = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    expect(second.cycle).toBe(2);
  });
});

describe('an edit revokes an approval', () => {
  it('editing an APPROVED item returns it to DRAFT, audibly', async () => {
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    await inA(({ approvals }) =>
      approvals.decide({ approvalId: approval.id, verdict: 'APPROVE', actor: reviewer() }),
    );
    expect(await statusOf()).toBe('APPROVED');

    await inA(({ library }) =>
      library.editVariant({
        variantId: fixtures.a.contentVariantId,
        body: 'Rewritten after approval.',
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
      }),
    );
    expect(await statusOf()).toBe('DRAFT');

    const revocations = await inA(({ db }) =>
      db.auditEvent.findMany({ where: { action: 'content.approval_revoked' } }),
    );
    expect(revocations).toHaveLength(1);
    expect(revocations[0]?.reason).toBe('edited_after_approval');
  });
});

describe('AC-14.6 — the calendar gate, now backed by a workflow (D-120 closed)', () => {
  const quota: ScheduleQuota = {
    limit: async () => null,
    consume: async () => true,
    refund: async () => {},
  };

  function calendar(
    db: Parameters<Parameters<typeof withWorkspace>[1]>[0],
    gate: ContentApprovalService,
  ) {
    return new ContentCalendarService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: CONTENT_POLICY,
      timezone: 'Asia/Riyadh',
      quota,
      approvalGate: gate,
    });
  }

  const futureLocalTime = `${new Date().getUTCFullYear() + 1}-06-15T09:00`;

  it('with the brand gate ON, an unapproved item cannot be scheduled', async () => {
    await inA(({ approvals }) =>
      approvals.setPolicyForBrand({
        brandId: fixtures.a.brandId,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        patch: { requireApprovalBeforeScheduling: true },
      }),
    );
    await expect(
      inA(({ approvals, db }) =>
        calendar(db, approvals).schedule({
          contentItemId: itemId(),
          localTime: futureLocalTime,
          actorUserId: fixtures.a.userId,
          actorBrandScope: [],
        }),
      ),
    ).rejects.toThrow();
  });

  it('with the gate ON, an item APPROVED THROUGH THE WORKFLOW schedules', async () => {
    /*
     * THE POINT OF THE WHOLE MILESTONE. In 5B-2 this test could only be written
     * by setting `status: 'APPROVED'` directly, because nothing could grant
     * approval — which is why D-120 shipped the gate OFF. Here the item reaches
     * `APPROVED` the way a customer's would: a person submitted it and a
     * different person approved it.
     */
    await inA(({ approvals }) =>
      approvals.setPolicyForBrand({
        brandId: fixtures.a.brandId,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        patch: { requireApprovalBeforeScheduling: true },
      }),
    );
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    await inA(({ approvals }) =>
      approvals.decide({ approvalId: approval.id, verdict: 'APPROVE', actor: reviewer() }),
    );

    const view = await inA(({ approvals, db }) =>
      calendar(db, approvals).schedule({
        contentItemId: itemId(),
        localTime: futureLocalTime,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
      }),
    );
    expect(view.slot.targetKind).toBe('MOCK');
    expect(await statusOf()).toBe('SCHEDULED');
  });

  it('the gate is PER BRAND — another brand is unaffected', async () => {
    await inA(({ approvals }) =>
      approvals.setPolicyForBrand({
        brandId: fixtures.a.brandId,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        patch: { requireApprovalBeforeScheduling: true },
      }),
    );
    const resolved = await inA(({ approvals }) => approvals.policyForBrand(fixtures.a.brandId));
    expect(resolved.requireApprovalBeforeScheduling).toBe(true);

    // A brand with no row falls back to the activated default, which is off.
    const other = await inA(({ approvals }) =>
      approvals.policyForBrand('00000000-0000-4000-8000-000000000000'),
    );
    expect(other.requireApprovalBeforeScheduling).toBe(false);
  });

  it('content a reviewer sent back cannot be scheduled at all', async () => {
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    await inA(({ approvals }) =>
      approvals.decide({ approvalId: approval.id, verdict: 'REQUEST_CHANGES', actor: reviewer() }),
    );
    await expect(
      inA(({ approvals, db }) =>
        calendar(db, approvals).schedule({
          contentItemId: itemId(),
          localTime: futureLocalTime,
          actorUserId: fixtures.a.userId,
          actorBrandScope: [],
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('the queue, the history and the audit trail', () => {
  it('the queue is brand-scoped AT THE QUERY', async () => {
    await inA(({ approvals }) => approvals.submit({ itemId: itemId(), actor: author() }));
    const mine = await inA(({ approvals }) =>
      approvals.queue({ brandScope: [fixtures.a.brandId] }),
    );
    expect(mine).toHaveLength(1);

    const elsewhere = await inA(({ approvals }) =>
      approvals.queue({ brandScope: ['00000000-0000-4000-8000-000000000000'] }),
    );
    expect(elsewhere).toHaveLength(0);
  });

  it('the history keeps every cycle, in order', async () => {
    const first = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    await inA(({ approvals }) =>
      approvals.decide({ approvalId: first.id, verdict: 'REQUEST_CHANGES', actor: reviewer() }),
    );
    const second = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author() }),
    );
    await inA(({ approvals }) =>
      approvals.decide({ approvalId: second.id, verdict: 'APPROVE', actor: reviewer() }),
    );

    const history = await inA(({ approvals }) =>
      approvals.historyForItem({ itemId: itemId(), brandScope: [] }),
    );
    expect(history.map((h) => h.status)).toEqual(['CHANGES_REQUESTED', 'APPROVED']);
    expect(history.map((h) => h.cycle)).toEqual([1, 2]);
  });

  it('every state change writes an audit event, and NONE carries the caption', async () => {
    const approval = await inA(({ approvals }) =>
      approvals.submit({ itemId: itemId(), actor: author(), note: 'Secret rationale' }),
    );
    await inA(({ approvals }) =>
      approvals.decide({
        approvalId: approval.id,
        verdict: 'APPROVE',
        actor: reviewer(),
        note: 'Looks right',
      }),
    );

    /*
     * SCOPED TO THIS APPROVAL'S OWN ROWS. `audit_event` is append-only by
     * design, so `beforeEach` cannot clear it and every earlier test in this
     * file has left its events behind. A query over the whole table would be
     * asserting the order of the suite rather than the behaviour.
     */
    const events = await inA(({ db }) =>
      db.auditEvent.findMany({
        where: { resourceType: 'Approval', resourceId: approval.id },
        orderBy: { occurredAt: 'asc' },
      }),
    );
    expect(events.map((e) => e.action)).toEqual(['content.review_requested', 'content.approved']);

    /*
     * THE NOTES ARE NOT IN THE AUDIT TRAIL, only the fact that there were some.
     * A review note is candid by design — it is where somebody writes why they
     * are unhappy with a colleague's work — and the audit trail is read by more
     * people and kept for longer than the review itself.
     */
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain('Secret rationale');
    expect(serialised).not.toContain('Looks right');
    expect(serialised).toContain('hasNote');
  });
});

describe('notifications are produced by the domain, not by a screen', () => {
  it('a decision notifies the requester exactly once, however often it is retried', async () => {
    const notified: string[] = [];
    const notifier = {
      approvalRequested: async () => {},
      approvalDecided: async (event: { notifyUserId: string }) => {
        notified.push(event.notifyUserId);
      },
    };

    const approval = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        new ContentApprovalService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
          notifier,
        }).submit({ itemId: itemId(), actor: author() }),
      { prisma: app },
    );
    await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        new ContentApprovalService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
          notifier,
        }).decide({ approvalId: approval.id, verdict: 'APPROVE', actor: reviewer() }),
      { prisma: app },
    );
    expect(notified).toEqual([fixtures.a.userId]);
  });

  it('the idempotency key means a replayed event does not double an inbox', async () => {
    const write = () =>
      withWorkspace(
        fixtures.a.workspaceId,
        (db) =>
          new NotificationService({ db, workspaceId: fixtures.a.workspaceId }).create({
            userIds: [fixtures.a.userId],
            templateKey: 'approval.requested',
            idempotencyKey: 'replayed-event',
          }),
        { prisma: app },
      );
    expect(await write()).toBe(1);
    expect(await write()).toBe(0);
  });

  it('read state is per reader, and a stranger cannot mark it read', async () => {
    await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        new NotificationService({ db, workspaceId: fixtures.a.workspaceId }).create({
          userIds: [fixtures.a.userId],
          templateKey: 'approval.approved',
          idempotencyKey: 'read-state',
        }),
      { prisma: app },
    );
    const inbox: NotificationView[] = await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        new NotificationService({ db, workspaceId: fixtures.a.workspaceId }).list({
          userId: fixtures.a.userId,
        }),
      { prisma: app },
    );
    const target = inbox[0];
    expect(target).toBeTruthy();

    const byStranger = await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        new NotificationService({ db, workspaceId: fixtures.a.workspaceId }).markRead({
          id: target?.id ?? '',
          userId: REVIEWER_ID,
        }),
      { prisma: app },
    );
    expect(byStranger).toBe(false);

    const byOwner = await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        new NotificationService({ db, workspaceId: fixtures.a.workspaceId }).markRead({
          id: target?.id ?? '',
          userId: fixtures.a.userId,
        }),
      { prisma: app },
    );
    expect(byOwner).toBe(true);
  });
});
