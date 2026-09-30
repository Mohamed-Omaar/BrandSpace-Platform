import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  ContentApprovalService,
  type ApprovalActor,
  type ContentPolicy,
} from '@brandspace/content';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 2B-3, PR 2 — CONTENT_APPROVED ONCE PER APPROVAL CYCLE, AGAINST REAL
 * POSTGRESQL.
 *
 * The event's reference is the content item (what a rule acts on); its
 * identity is the approval that decided the cycle. Approving a post, sending
 * it back to draft, resubmitting and approving it again is two events. A
 * verdict that is not an approval is none, and an event recorded before PR 2
 * under the item-keyed identity is left exactly as it is.
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
    maxNoteLength: 200,
    maxCyclesPerItem: 5,
  },
};

let app: PrismaClient;
let fixtures: IsolationFixtures;

const author = (): ApprovalActor => ({
  userId: fixtures.a.userId,
  roleKey: 'content_creator',
  permissionKeys: ['content.read', 'content.submit'],
  brandScope: [],
});
const REVIEWER_ID = '11111111-2222-4333-8444-555555555555';
const reviewer = (): ApprovalActor => ({
  userId: REVIEWER_ID,
  roleKey: 'approver',
  permissionKeys: ['content.read', 'content.approve'],
  brandScope: [],
});

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const approvals = (db: TenantScopedClient) =>
  new ContentApprovalService({ db, workspaceId: fixtures.a.workspaceId, policy: CONTENT_POLICY });

async function draft(): Promise<string> {
  return inA(async (db) => {
    const item = await db.contentItem.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        title: `PR 2 cycle ${randomUUID().slice(0, 8)}`,
        primaryLocale: 'EN',
        status: 'DRAFT',
        createdByUserId: fixtures.a.userId,
      },
    });
    await db.contentVariant.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: 'A caption.',
        characterCount: 10,
        validationState: 'VALID',
      },
    });
    return item.id;
  });
}

async function submitAndDecide(
  itemId: string,
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT' = 'APPROVE',
): Promise<string> {
  const approval = await inA((db) => approvals(db).submit({ itemId, actor: author() }));
  await inA((db) =>
    approvals(db).decide({
      approvalId: approval.id,
      verdict,
      actor: reviewer(),
      note: verdict === 'APPROVE' ? null : 'Please change the caption.',
    }),
  );
  return approval.id;
}

/** Back to draft, as an edit of an approved post does. */
const reopen = (itemId: string) =>
  inA((db) => db.contentItem.update({ where: { id: itemId }, data: { status: 'DRAFT' } }));

const approvedEvents = (itemId: string) =>
  inA((db) =>
    db.automationEvent.findMany({
      where: { triggerType: 'CONTENT_APPROVED', refId: itemId },
      orderBy: { createdAt: 'asc' },
      select: { dedupeKey: true, refType: true, refId: true, ruleId: true, brandId: true },
    }),
  );

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('CONTENT_APPROVED is identified by the approval cycle', () => {
  it('one approval: one event, keyed by the approval, referencing the item', async () => {
    const itemId = await draft();
    const approvalId = await submitAndDecide(itemId);
    expect(await approvedEvents(itemId)).toEqual([
      {
        dedupeKey: `CONTENT_APPROVED:${approvalId}`,
        refType: 'ContentItem',
        refId: itemId,
        ruleId: null,
        brandId: fixtures.a.brandId,
      },
    ]);
  });

  it('approved, reopened, resubmitted and approved again: two distinct events', async () => {
    const itemId = await draft();
    const first = await submitAndDecide(itemId);
    await reopen(itemId);
    const second = await submitAndDecide(itemId);
    expect(first).not.toBe(second);
    expect((await approvedEvents(itemId)).map((event) => event.dedupeKey)).toEqual([
      `CONTENT_APPROVED:${first}`,
      `CONTENT_APPROVED:${second}`,
    ]);
  });

  it('a cycle sent back for changes produces none; the cycle approved after it produces one', async () => {
    const itemId = await draft();
    await submitAndDecide(itemId, 'REQUEST_CHANGES');
    expect(await approvedEvents(itemId)).toEqual([]);
    await reopen(itemId);
    const approved = await submitAndDecide(itemId);
    expect((await approvedEvents(itemId)).map((event) => event.dedupeKey)).toEqual([
      `CONTENT_APPROVED:${approved}`,
    ]);
  });

  it('the same verdict delivered twice is refused and adds no event', async () => {
    const itemId = await draft();
    const approvalId = await submitAndDecide(itemId);
    await expect(
      inA((db) => approvals(db).decide({ approvalId, verdict: 'APPROVE', actor: reviewer() })),
    ).rejects.toThrow();
    expect(await approvedEvents(itemId)).toHaveLength(1);
  });

  it('an item-keyed event recorded before PR 2 stays as it is, beside the new cycle key', async () => {
    const itemId = await draft();
    // What the outbox may already hold: the pre-PR 2 identity.
    await inA((db) =>
      db.automationEvent.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          triggerType: 'CONTENT_APPROVED',
          refType: 'ContentItem',
          refId: itemId,
          dedupeKey: `CONTENT_APPROVED:${itemId}`,
          dispatchedAt: new Date(),
          deliveredAt: new Date(),
        },
      }),
    );
    const approvalId = await submitAndDecide(itemId);
    expect((await approvedEvents(itemId)).map((event) => event.dedupeKey)).toEqual([
      `CONTENT_APPROVED:${itemId}`,
      `CONTENT_APPROVED:${approvalId}`,
    ]);
  });
});
