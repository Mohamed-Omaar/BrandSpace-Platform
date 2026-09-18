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

describe('an assignment is ENFORCED on the verdict, not merely recorded', () => {
  it('somebody else who could otherwise approve is refused', async () => {
    /*
     * The half-built behaviour this replaces: assignment was written to the row
     * and then ignored, so the screen said a review was assigned and any
     * approver could still decide it. Recording an intention the system does
     * not honour is worse than not offering it.
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
    await expect(
      run((s) => s.decide({ approvalId: approval.id, verdict: 'APPROVE', actor: otherApprover })),
    ).rejects.toThrow();

    const assignee: ApprovalActor = {
      userId: approverBothBrands,
      roleKey: 'approver',
      permissionKeys: ['content.read', 'content.approve'],
      brandScope: [],
    };
    const decided = await run((s) =>
      s.decide({ approvalId: approval.id, verdict: 'APPROVE', actor: assignee }),
    );
    expect(decided.status).toBe('APPROVED');
    expect(decided.decidedByUserId).toBe(approverBothBrands);
  });

  it('and reviewSubject().mayDecide SAYS SO, rather than offering a button that refuses', async () => {
    /*
     * The screen reads `mayDecide` off the review subject. It answered from the
     * permission and the status alone, so a non-assignee was offered the
     * Approve button on a review the verdict would then refuse — the same
     * half-behaviour one layer up. The card and the verdict share the rule.
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
    const withheld = await run((s) =>
      s.reviewSubject({ approvalId: approval.id, actor: otherApprover }),
    );
    expect(withheld.mayDecide).toBe(false);

    const assignee: ApprovalActor = {
      userId: approverBothBrands,
      roleKey: 'approver',
      permissionKeys: ['content.read', 'content.approve'],
      brandScope: [],
    };
    const offered = await run((s) => s.reviewSubject({ approvalId: approval.id, actor: assignee }));
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
