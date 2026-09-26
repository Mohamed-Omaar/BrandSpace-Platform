import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import {
  ContentApprovalService,
  type ApprovalActor,
  type ApprovalNotifier,
  type ContentPolicy,
} from '@brandspace/content';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * WHO A REVIEW NOTIFICATION MAY REACH, and who may be assigned one.
 *
 * A NOTIFICATION IS A DISCLOSURE. It says that content exists, in that brand,
 * carrying that title, awaiting review. The first version addressed it by
 * listing every member whose ROLE held `content.approve` — which ignored
 * membership status and BrandScope entirely, so:
 *
 *   * a member restricted to Brand A was told the title of Brand B's content;
 *   * a suspended or never-accepted member kept being told; and
 *   * and, under the since-superseded D-121, a Viewer the brand had admitted
 *     was told nothing. D-62 makes the Viewer strictly read-only, so what is
 *     asserted now is the opposite: they are never a recipient.
 *
 * All three are asserted here against real memberships, real roles and real
 * role-permission rows, because the defect was precisely that the code reasoned
 * about roles in the abstract instead of asking the database who these people
 * actually are.
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
  learning: {
    preferenceMinObservations: 4,
    preferenceMinPosts: 3,
    workflowMinRepeats: 4,
    windowDays: 90,
    snoozeDays: 30,
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

/** A second brand, so "another brand" is a real place with real members. */
let brandTwo: string;

/** The cast. Each is a real membership with a real role. */
let approverBothBrands: string;
let approverBrandTwoOnly: string;
let suspendedApprover: string;
let viewerBrandOne: string;
let copywriter: string;

/**
 * A real member, created the way the product creates one: as the PLATFORM.
 *
 * `user` carries RLS and the application role cannot insert into it — which is
 * the policy working rather than an obstacle. Provisioning people is a platform
 * act (invitations, workspace creation), so the fixture performs it as the
 * platform and everything under test then reads these rows as the tenant.
 */
async function member(input: {
  roleKey: string;
  brandScope: string[];
  status: 'ACTIVE' | 'SUSPENDED';
}): Promise<string> {
  const email = `recipient-${randomUUID()}@example.test`;
  const user = await platform.user.create({
    data: {
      email,
      name: `Member ${input.roleKey}`,
      status: 'ACTIVE',
      locale: 'EN',
      timezone: 'UTC',
    },
  });
  const role = await platform.role.findFirstOrThrow({
    where: { key: input.roleKey, realm: 'WORKSPACE' },
  });
  await platform.membership.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      userId: user.id,
      roleId: role.id,
      status: input.status,
      brandScope: input.brandScope,
    },
  });
  return user.id;
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);

  brandTwo = await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      const existing = await db.brand.findFirst({ where: { slug: 'recipients-brand-two' } });
      if (existing) return existing.id;
      const created = await db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          slug: 'recipients-brand-two',
          name: 'Brand Two',
          defaultLocale: 'EN',
          status: 'ACTIVE',
        },
      });
      return created.id;
    },
    { prisma: app },
  );

  // UNRESTRICTED membership — the platform's empty-scope rule, so this one
  // reviews every brand.
  approverBothBrands = await member({ roleKey: 'approver', brandScope: [], status: 'ACTIVE' });
  approverBrandTwoOnly = await member({
    roleKey: 'approver',
    brandScope: [brandTwo],
    status: 'ACTIVE',
  });
  suspendedApprover = await member({ roleKey: 'approver', brandScope: [], status: 'SUSPENDED' });
  viewerBrandOne = await member({
    roleKey: 'client_viewer',
    brandScope: [fixtures.a.brandId],
    status: 'ACTIVE',
  });
  copywriter = await member({ roleKey: 'copywriter', brandScope: [], status: 'ACTIVE' });
}, 90_000);

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
  await platform.approval.deleteMany({ where: { workspaceId: fixtures.a.workspaceId } });
  await platform.approvalPolicy.deleteMany({ where: { workspaceId: fixtures.a.workspaceId } });
});

const author = (): ApprovalActor => ({
  userId: fixtures.a.userId,
  roleKey: 'content_creator',
  permissionKeys: ['content.read', 'content.submit'],
  brandScope: [],
});

/** Captures the recipient list the SERVICE resolved. */
function capturing(): { notifier: ApprovalNotifier; recipients: string[] } {
  const recipients: string[] = [];
  return {
    recipients,
    notifier: {
      approvalRequested: async (event) => {
        recipients.push(...event.recipientUserIds);
      },
      approvalDecided: async () => {},
    },
  };
}

function run<T>(
  fn: (service: ContentApprovalService) => Promise<T>,
  notifier?: ApprovalNotifier,
): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    (db) =>
      fn(
        new ContentApprovalService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
          ...(notifier ? { notifier } : {}),
        }),
      ),
    { prisma: app },
  );
}

describe('an approval-request notification reaches only effective reviewers of THAT brand', () => {
  it('includes an unrestricted approver and EXCLUDES one scoped to another brand', async () => {
    const { notifier, recipients } = capturing();
    await run((s) => s.submit({ itemId: fixtures.a.contentItemId, actor: author() }), notifier);

    expect(recipients).toContain(approverBothBrands);
    /*
     * THE CROSS-BRAND DISCLOSURE. This member reviews Brand Two only; the
     * content is in Brand One. Telling them would put another brand's title in
     * their inbox — the notification's whole payload is a disclosure.
     */
    expect(recipients).not.toContain(approverBrandTwoOnly);
  });

  it('EXCLUDES a suspended member, whatever their role says', async () => {
    const { notifier, recipients } = capturing();
    await run((s) => s.submit({ itemId: fixtures.a.contentItemId, actor: author() }), notifier);
    expect(recipients).not.toContain(suspendedApprover);
  });

  it('EXCLUDES a member whose role carries no review authority', async () => {
    const { notifier, recipients } = capturing();
    await run((s) => s.submit({ itemId: fixtures.a.contentItemId, actor: author() }), notifier);
    expect(recipients).not.toContain(copywriter);
  });

  it('EXCLUDES the requester — they know', async () => {
    const { notifier, recipients } = capturing();
    await run((s) => s.submit({ itemId: fixtures.a.contentItemId, actor: author() }), notifier);
    expect(recipients).not.toContain(fixtures.a.userId);
  });

  it('NEVER includes a read-only Viewer — D-62, and there is no switch to flip', async () => {
    /*
     * D-121 made this the opposite test: a Viewer the brand had admitted was
     * supposed to be told they had work. D-62 supersedes it — the MVP Viewer is
     * strictly read-only — so the Viewer is simply not a reviewer and is never
     * addressed.
     *
     * NOTE WHAT THIS TEST CANNOT DO ANY MORE, which is the real assertion:
     * there is no `patch: { clientApprovalEnabled: true }` to write. The field
     * is not in `setPolicyForBrand`'s patch type, `mayApproveForBrand` takes
     * neither a role key nor a policy, and the database pins the column. The
     * grant cannot be turned on from anywhere, so the only case left to check
     * is the permanent one.
     */
    const { notifier, recipients } = capturing();
    await run((s) => s.submit({ itemId: fixtures.a.contentItemId, actor: author() }), notifier);
    expect(recipients).not.toContain(viewerBrandOne);
    expect(recipients.length).toBeGreaterThan(0); // real reviewers WERE told
  });
});

describe('an assignment is validated before it is persisted', () => {
  it('REFUSES a member scoped to another brand', async () => {
    await expect(
      run((s) =>
        s.submit({
          itemId: fixtures.a.contentItemId,
          actor: author(),
          assignedToUserId: approverBrandTwoOnly,
        }),
      ),
    ).rejects.toThrow();
    // And nothing was written: a refused assignment must not leave a cycle open.
    expect(await run((s) => s.openForItem(fixtures.a.contentItemId))).toBeNull();
  });

  it('REFUSES a suspended member', async () => {
    await expect(
      run((s) =>
        s.submit({
          itemId: fixtures.a.contentItemId,
          actor: author(),
          assignedToUserId: suspendedApprover,
        }),
      ),
    ).rejects.toThrow();
  });

  it('REFUSES a member with no review authority', async () => {
    await expect(
      run((s) =>
        s.submit({
          itemId: fixtures.a.contentItemId,
          actor: author(),
          assignedToUserId: copywriter,
        }),
      ),
    ).rejects.toThrow();
  });

  it('REFUSES a uuid that is nobody, the same way — it names no reason', async () => {
    await expect(
      run((s) =>
        s.submit({
          itemId: fixtures.a.contentItemId,
          actor: author(),
          assignedToUserId: randomUUID(),
        }),
      ),
    ).rejects.toThrow();
  });

  it('ACCEPTS an eligible reviewer, and notifies them ALONE', async () => {
    const { notifier, recipients } = capturing();
    const approval = await run(
      (s) =>
        s.submit({
          itemId: fixtures.a.contentItemId,
          actor: author(),
          assignedToUserId: approverBothBrands,
        }),
      notifier,
    );
    expect(approval.assignedToUserId).toBe(approverBothBrands);
    // Assigned means assigned: notifying the whole pool would make it meaningless.
    expect(recipients).toEqual([approverBothBrands]);
  });
});

describe('Q10 — an assignment says who is asked first, not who alone may decide', () => {
  it('another eligible approver may still decide an assigned review (D-325 amends D-127)', async () => {
    /*
     * D-127 made an assignment exclusive. Q10 reverses that: every review is
     * now assigned by default, and an exclusive assignment would stall a
     * review whenever that one person is away. The rule that remains is the
     * rest of `decide()` — authority, brand scope, self-approval.
     */
    const approval = await run((s) =>
      s.submit({
        itemId: fixtures.a.contentItemId,
        actor: author(),
        assignedToUserId: approverBothBrands,
      }),
    );

    const otherApprover: ApprovalActor = {
      userId: approverBrandTwoOnly,
      roleKey: 'approver',
      permissionKeys: ['content.read', 'content.approve'],
      brandScope: [],
    };
    const decided = await run((s) =>
      s.decide({ approvalId: approval.id, verdict: 'APPROVE', actor: otherApprover }),
    );
    expect(decided.status).toBe('APPROVED');
    expect(decided.decidedByUserId).toBe(approverBrandTwoOnly);
    expect(decided.assignedToUserId).toBe(approverBothBrands);
  });

  it('and reviewSubject().mayDecide offers the decision to that other approver too', async () => {
    const approval = await run((s) =>
      s.submit({
        itemId: fixtures.a.contentItemId,
        actor: author(),
        assignedToUserId: approverBothBrands,
      }),
    );
    const otherApprover: ApprovalActor = {
      userId: approverBrandTwoOnly,
      roleKey: 'approver',
      permissionKeys: ['content.read', 'content.approve'],
      brandScope: [],
    };
    const offered = await run((s) =>
      s.reviewSubject({ approvalId: approval.id, actor: otherApprover }),
    );
    expect(offered.mayDecide).toBe(true);
  });

  it('an UNASSIGNED review may be decided by any eligible reviewer', async () => {
    const approval = await run((s) =>
      s.submit({ itemId: fixtures.a.contentItemId, actor: author() }),
    );
    const anyApprover: ApprovalActor = {
      userId: approverBothBrands,
      roleKey: 'approver',
      permissionKeys: ['content.read', 'content.approve'],
      brandScope: [],
    };
    expect(
      (
        await run((s) =>
          s.decide({ approvalId: approval.id, verdict: 'APPROVE', actor: anyApprover }),
        )
      ).status,
    ).toBe('APPROVED');
  });
});

describe('Q10 — every review has a default reviewer', () => {
  const copywriterAuthor = (): ApprovalActor => ({
    userId: copywriter,
    roleKey: 'copywriter',
    permissionKeys: ['content.read', 'content.submit'],
    brandScope: [],
  });

  it('assigns the first eligible approver who is not the author, and tells them alone', async () => {
    const { notifier, recipients } = capturing();
    const approval = await run(
      (s) => s.submit({ itemId: fixtures.a.contentItemId, actor: author() }),
      notifier,
    );
    expect(approval.assignedToUserId).toBe(approverBothBrands);
    expect(recipients).toEqual([approverBothBrands]);
  });

  it('puts members before the owner, even an owner who joined first', async () => {
    const eligible = await run((s) =>
      s.eligibleReviewers({ brandId: fixtures.a.brandId, excludeUserId: copywriter }),
    );
    expect(eligible).toContain(fixtures.a.userId); // the owner may approve…
    expect(eligible.at(-1)).toBe(fixtures.a.userId); // …and is asked last
    const approval = await run((s) =>
      s.submit({ itemId: fixtures.a.contentItemId, actor: copywriterAuthor() }),
    );
    expect(approval.assignedToUserId).toBe(approverBothBrands);
  });

  it("submitting a colleague's post never assigns its author, and asks somebody who may decide", async () => {
    // The author is the approver who would otherwise be first in line.
    await platform.contentItem.update({
      where: { id: fixtures.a.contentItemId },
      data: { createdByUserId: approverBothBrands },
    });
    const { notifier, recipients } = capturing();
    const approval = await run(
      (s) => s.submit({ itemId: fixtures.a.contentItemId, actor: copywriterAuthor() }),
      notifier,
    );
    // D-122 bars the author from deciding, so the default moves on — here to
    // the owner, the only other approver for this brand.
    expect(approval.assignedToUserId).not.toBe(approverBothBrands);
    expect(approval.assignedToUserId).toBe(fixtures.a.userId);
    expect(recipients).toEqual([fixtures.a.userId]);
    // The composer's "Automatic (name)" preview asks the same question.
    const preview = await run((s) =>
      s.eligibleReviewers({
        brandId: fixtures.a.brandId,
        excludeUserIds: [copywriter, approverBothBrands],
      }),
    );
    expect(preview[0]).toBe(approval.assignedToUserId);
    expect(
      await run((s) =>
        s.defaultReviewer({
          brandId: fixtures.a.brandId,
          submitterUserId: copywriter,
          authorUserId: approverBothBrands,
        }),
      ),
    ).toBe(fixtures.a.userId);
  });

  describe('an explicit assignee must be able to decide THIS item (D-122)', () => {
    /** Both people here hold `content.approve`, so only D-122 can refuse them. */
    const approverSubmitting = (): ApprovalActor => ({
      userId: approverBothBrands,
      roleKey: 'approver',
      permissionKeys: ['content.read', 'content.submit', 'content.approve'],
      brandScope: [],
    });
    const approvalsFor = () =>
      platform.approval.count({
        where: { workspaceId: fixtures.a.workspaceId, contentItemId: fixtures.a.contentItemId },
      });
    const allowSelfApproval = (allow: boolean) =>
      run((s) =>
        s.setPolicyForBrand({
          brandId: fixtures.a.brandId,
          actorUserId: fixtures.a.userId,
          actorBrandScope: [],
          patch: { allowSelfApproval: allow },
        }),
      );

    it("refuses a crafted assignment to the post's AUTHOR, and writes no approval", async () => {
      await platform.contentItem.update({
        where: { id: fixtures.a.contentItemId },
        data: { createdByUserId: approverBothBrands },
      });
      const { notifier, recipients } = capturing();
      await expect(
        run(
          (s) =>
            s.submit({
              itemId: fixtures.a.contentItemId,
              actor: copywriterAuthor(),
              assignedToUserId: approverBothBrands,
            }),
          notifier,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await approvalsFor()).toBe(0);
      expect(recipients).toEqual([]);
      const item = await platform.contentItem.findUniqueOrThrow({
        where: { id: fixtures.a.contentItemId },
      });
      expect(item.status).toBe('DRAFT');
    });

    it('refuses a crafted assignment to the SUBMITTER, and writes no approval', async () => {
      await platform.contentItem.update({
        where: { id: fixtures.a.contentItemId },
        data: { createdByUserId: copywriter },
      });
      await expect(
        run((s) =>
          s.submit({
            itemId: fixtures.a.contentItemId,
            actor: approverSubmitting(),
            assignedToUserId: approverBothBrands,
          }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await approvalsFor()).toBe(0);
    });

    it('accepts the author or the submitter when the brand allows self-approval', async () => {
      await allowSelfApproval(true);

      await platform.contentItem.update({
        where: { id: fixtures.a.contentItemId },
        data: { createdByUserId: approverBothBrands },
      });
      const toAuthor = await run((s) =>
        s.submit({
          itemId: fixtures.a.contentItemId,
          actor: copywriterAuthor(),
          assignedToUserId: approverBothBrands,
        }),
      );
      expect(toAuthor.assignedToUserId).toBe(approverBothBrands);

      // A second cycle, submitted by the approver themself.
      await platform.approval.deleteMany({ where: { workspaceId: fixtures.a.workspaceId } });
      await platform.contentItem.update({
        where: { id: fixtures.a.contentItemId },
        data: { status: 'DRAFT', createdByUserId: copywriter },
      });
      const toSubmitter = await run((s) =>
        s.submit({
          itemId: fixtures.a.contentItemId,
          actor: approverSubmitting(),
          assignedToUserId: approverBothBrands,
        }),
      );
      expect(toSubmitter.assignedToUserId).toBe(approverBothBrands);
    });
  });

  it('an explicit choice wins over the default', async () => {
    // The copywriter wrote it and submits it; the owner is neither, so D-122
    // leaves the owner free to be chosen.
    await platform.contentItem.update({
      where: { id: fixtures.a.contentItemId },
      data: { createdByUserId: copywriter },
    });
    const approval = await run((s) =>
      s.submit({
        itemId: fixtures.a.contentItemId,
        actor: copywriterAuthor(),
        assignedToUserId: fixtures.a.userId,
      }),
    );
    expect(approval.assignedToUserId).toBe(fixtures.a.userId);
  });

  it("the queue lists a reviewer's own assignments first", async () => {
    const second = await platform.contentItem.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        title: 'Q10 second',
        contentType: 'POST',
        primaryLocale: 'EN',
        createdByUserId: copywriter,
      },
      select: { id: true },
    });
    const mine = await run((s) =>
      s.submit({ itemId: fixtures.a.contentItemId, actor: copywriterAuthor() }),
    );
    // Newer, and assigned to somebody else: without the preference it would lead.
    const theirs = await run((s) =>
      s.submit({
        itemId: second.id,
        actor: copywriterAuthor(),
        assignedToUserId: fixtures.a.userId,
      }),
    );
    const plain = await run((s) => s.queue({ brandScope: [] }));
    expect(plain[0]?.id).toBe(theirs.id);
    const preferred = await run((s) =>
      s.queue({ brandScope: [], preferUserId: approverBothBrands }),
    );
    expect(preferred.map((a) => a.id)).toEqual([mine.id, theirs.id]);
    await platform.contentItem.delete({ where: { id: second.id } });
  });
});
