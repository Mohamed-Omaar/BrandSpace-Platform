import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiGateway } from '@brandspace/ai-gateway';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import type { READ_ONLY_CONTENT_STATUSES } from '@brandspace/content';
import {
  CampaignService,
  ContentApprovalService,
  ContentCalendarService,
  ContentLibraryService,
  ContentStudioService,
  type ContentPolicy,
} from '@brandspace/content';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * Prototype v76 alignment, Phase 1 — the content editing guards, against a
 * real PostgreSQL under RLS.
 *
 * Every test makes its OWN post through the ordinary manual-create path, so the
 * shared fixture item other suites rely on is never moved.
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
    maxNoteLength: 400,
    maxCyclesPerItem: 5,
  },
};

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
/** A real, active approver in workspace A — a reviewer who can be told things. */
let reviewerId: string;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  const user = await platform.user.create({
    data: {
      email: `guard-reviewer-${crypto.randomUUID()}@example.test`,
      name: 'Guard Reviewer',
      status: 'ACTIVE',
      locale: 'EN',
      timezone: 'UTC',
    },
  });
  const role = await platform.role.findFirstOrThrow({
    where: { key: 'approver', realm: 'WORKSPACE' },
  });
  await platform.membership.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      userId: user.id,
      roleId: role.id,
      status: 'ACTIVE',
      brandScope: [],
    },
  });
  reviewerId = user.id;
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

function inA<T>(fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app });
}

function library(db: TenantScopedClient): ContentLibraryService {
  return new ContentLibraryService({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: CONTENT_POLICY,
  });
}

/** A fresh one-variant post on brand A. */
async function freshPost(): Promise<{ itemId: string; variantId: string }> {
  return inA(async (db) => {
    const created = await library(db).createManualItem({
      brandId: fixtures.a.brandId,
      title: 'Guarded post',
      locale: 'EN',
      variants: [{ platformKey: 'instagram', body: 'The words that went out.' }],
      actorUserId: fixtures.a.userId,
      actorBrandScope: [],
      expiresAt: null,
      idempotencyKey: `guard-${crypto.randomUUID()}`,
    });
    const variant = created.variants[0];
    if (!variant) throw new Error('the fixture post has no variant');
    return { itemId: created.item.id, variantId: variant.id };
  });
}

async function setStatus(itemId: string, status: string): Promise<void> {
  await inA((db) =>
    db.contentItem.update({
      where: { id: itemId },
      data: { status: status as (typeof READ_ONLY_CONTENT_STATUSES)[number] },
    }),
  );
}

async function bodyOf(variantId: string): Promise<string | null> {
  return inA(
    async (db) => (await db.contentVariant.findUniqueOrThrow({ where: { id: variantId } })).body,
  );
}

describe('B-2 · a published post is read-only', () => {
  it.each(['PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED'])(
    'refuses a manual edit while the post is %s, and changes nothing',
    async (status) => {
      const post = await freshPost();
      await setStatus(post.itemId, status);

      await expect(
        inA((db) =>
          library(db).editVariant({
            variantId: post.variantId,
            body: 'Rewritten after the fact.',
            actorUserId: fixtures.a.userId,
            actorBrandScope: [],
            actorPermissionKeys: ['content.edit', 'content.schedule'],
          }),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await bodyOf(post.variantId)).toBe('The words that went out.');
    },
  );

  it('refuses an AI edit BEFORE the model is called, so no credit is spent', async () => {
    const post = await freshPost();
    await setStatus(post.itemId, 'PUBLISHED');
    let calls = 0;
    const gateway = {
      execute: () => {
        calls += 1;
        throw new Error('the gateway must not be reached for a published post');
      },
    } as unknown as AiGateway;

    await expect(
      inA((db) =>
        new ContentStudioService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
          gateway,
        }).applyTool({
          variantId: post.variantId,
          tool: 'shorten',
          idempotencyKey: `tool-${crypto.randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actorBrandScope: [],
          actorPermissionKeys: ['content.edit', 'content.schedule'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(calls).toBe(0);
    expect(await bodyOf(post.variantId)).toBe('The words that went out.');
  });

  it('still lets a draft, and a failed post, be edited', async () => {
    for (const status of ['DRAFT', 'FAILED']) {
      const post = await freshPost();
      await setStatus(post.itemId, status);
      await inA((db) =>
        library(db).editVariant({
          variantId: post.variantId,
          body: `Edited while ${status}.`,
          actorUserId: fixtures.a.userId,
          actorBrandScope: [],
          actorPermissionKeys: ['content.edit', 'content.schedule'],
        }),
      );
      expect(await bodyOf(post.variantId)).toBe(`Edited while ${status}.`);
    }
  });
});

describe('B-3 · editing a post in review withdraws the review', () => {
  const authorActor = () => ({
    userId: fixtures.a.userId,
    roleKey: 'content_creator',
    permissionKeys: ['content.read', 'content.submit'],
    brandScope: [] as string[],
  });
  const reviewerActor = () => ({
    userId: reviewerId,
    roleKey: 'approver',
    permissionKeys: ['content.read', 'content.approve'],
    brandScope: [] as string[],
  });
  const approvals = (db: TenantScopedClient) =>
    new ContentApprovalService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: CONTENT_POLICY,
    });

  async function inReview(assigned: boolean) {
    const post = await freshPost();
    const approval = await inA((db) =>
      approvals(db).submit({
        itemId: post.itemId,
        actor: authorActor(),
        ...(assigned ? { assignedToUserId: reviewerId } : {}),
      }),
    );
    return { ...post, approvalId: approval.id };
  }

  const edit = (variantId: string, body: string) =>
    inA((db) =>
      library(db).editVariant({
        variantId,
        body,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        actorPermissionKeys: ['content.edit', 'content.schedule'],
      }),
    );

  it('cancels the review, returns the post to DRAFT, audits and tells the reviewer — together', async () => {
    const post = await inReview(true);
    await edit(post.variantId, 'Changed while the reviewer was reading.');

    // Sequential: one transaction's client runs one query at a time.
    const { approval, item, audit, notes } = await inA(async (db) => ({
      approval: await db.approval.findUniqueOrThrow({ where: { id: post.approvalId } }),
      item: await db.contentItem.findUniqueOrThrow({ where: { id: post.itemId } }),
      audit: await db.auditEvent.findFirst({
        where: { resourceId: post.approvalId, action: 'content.review_cancelled' },
      }),
      notes: await db.notification.findMany({
        where: { resourceId: post.approvalId, templateKey: 'approval.withdrawn_after_edit' },
      }),
    }));
    expect(approval.status).toBe('CANCELLED');
    expect(item.status).toBe('DRAFT');
    expect(audit?.reason).toBe('edited_during_review');
    expect(notes.map((n) => n.userId)).toEqual([reviewerId]);
    expect(notes[0]?.linkPath).toBe(`/content/compose?item=${post.itemId}`);
  });

  it('the reviewer can no longer approve the version that changed', async () => {
    const post = await inReview(true);
    await edit(post.variantId, 'A different caption.');
    await expect(
      inA((db) =>
        approvals(db).decide({
          approvalId: post.approvalId,
          verdict: 'APPROVE',
          actor: reviewerActor(),
        }),
      ),
    ).rejects.toThrow();
  });

  it('an unassigned review tells everyone who could have picked it up, never the editor', async () => {
    const post = await inReview(false);
    await edit(post.variantId, 'Edited by the author.');
    const recipients = await inA((db) =>
      db.notification.findMany({
        where: { resourceId: post.approvalId, templateKey: 'approval.withdrawn_after_edit' },
        select: { userId: true },
      }),
    );
    expect(recipients.map((r) => r.userId)).toContain(reviewerId);
    expect(recipients.map((r) => r.userId)).not.toContain(fixtures.a.userId);
  });

  it('a post with changes requested stays there: editing is what was asked for', async () => {
    const post = await inReview(true);
    await inA((db) =>
      approvals(db).decide({
        approvalId: post.approvalId,
        verdict: 'REQUEST_CHANGES',
        note: 'Please change the opening line.',
        actor: reviewerActor(),
      }),
    );
    await edit(post.variantId, 'The requested change.');
    const item = await inA((db) =>
      db.contentItem.findUniqueOrThrow({ where: { id: post.itemId } }),
    );
    expect(item.status).toBe('CHANGES_REQUESTED');
  });

  it('the author can send the edited post for review again', async () => {
    const post = await inReview(true);
    await edit(post.variantId, 'Second version.');
    const again = await inA((db) =>
      approvals(db).submit({ itemId: post.itemId, actor: authorActor() }),
    );
    expect(again.cycle).toBe(2);
  });
});

describe('B-7 · archive and restore are one permission: content.archive', () => {
  const move = (itemId: string, to: 'DRAFT' | 'ARCHIVED', permissions: readonly string[]) =>
    inA((db) =>
      library(db).transition({
        itemId,
        to,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        actorPermissionKeys: permissions,
      }),
    );
  const statusOf = (itemId: string) =>
    inA(async (db) => (await db.contentItem.findUniqueOrThrow({ where: { id: itemId } })).status);

  it('archiving needs content.archive, not content.edit', async () => {
    const post = await freshPost();
    await expect(move(post.itemId, 'ARCHIVED', ['content.edit'])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await statusOf(post.itemId)).toBe('DRAFT');
    await move(post.itemId, 'ARCHIVED', ['content.archive']);
    expect(await statusOf(post.itemId)).toBe('ARCHIVED');
  });

  it('restoring needs content.archive too — the permission the screen now asks for', async () => {
    const post = await freshPost();
    await move(post.itemId, 'ARCHIVED', ['content.archive']);
    for (const permissions of [
      ['content.edit'],
      ['content.submit'],
      ['content.edit', 'content.submit'],
    ]) {
      await expect(move(post.itemId, 'DRAFT', permissions)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    expect(await statusOf(post.itemId)).toBe('ARCHIVED');
    await move(post.itemId, 'DRAFT', ['content.archive']);
    expect(await statusOf(post.itemId)).toBe('DRAFT');
  });

  it('back to draft after changes were requested is editing: content.edit', async () => {
    const post = await freshPost();
    await setStatus(post.itemId, 'CHANGES_REQUESTED');
    await expect(move(post.itemId, 'DRAFT', ['content.archive'])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await move(post.itemId, 'DRAFT', ['content.edit']);
    expect(await statusOf(post.itemId)).toBe('DRAFT');
  });
});

describe('Q8 · editing a SCHEDULED post without content.schedule takes it off the calendar', () => {
  /** A quota that records what it was asked, so the refund key can be read back. */
  function recordingQuota() {
    const consumed: string[] = [];
    const refunded: string[] = [];
    return {
      consumed,
      refunded,
      quota: {
        limit: async () => null,
        consume: async (key: string) => {
          consumed.push(key);
          return true;
        },
        refund: async (key: string) => {
          refunded.push(key);
        },
      },
    };
  }

  function calendar(db: TenantScopedClient, quota: ReturnType<typeof recordingQuota>['quota']) {
    return new ContentCalendarService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: CONTENT_POLICY,
      timezone: 'UTC',
      quota,
    });
  }

  /** A post placed on the calendar three days out, and what its slot charged. */
  async function scheduledPost() {
    const post = await freshPost();
    const recorder = recordingQuota();
    const when = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const view = await inA((db) =>
      calendar(db, recorder.quota).schedule({
        contentItemId: post.itemId,
        localTime: `${when}T10:00`,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
      }),
    );
    return { ...post, slotId: view.slot.id, recorder };
  }

  const read = (itemId: string, slotId: string) =>
    inA(async (db) => ({
      item: await db.contentItem.findUniqueOrThrow({ where: { id: itemId } }),
      slot: await db.calendarSlot.findUniqueOrThrow({ where: { id: slotId } }),
    }));

  it('cancels the slot, refunds its quota once, returns the post to DRAFT and audits it', async () => {
    const post = await scheduledPost();
    expect((await read(post.itemId, post.slotId)).item.status).toBe('SCHEDULED');

    await inA((db) =>
      new ContentLibraryService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: CONTENT_POLICY,
        scheduling: calendar(db, post.recorder.quota),
      }).editVariant({
        variantId: post.variantId,
        body: 'Changed by a copywriter.',
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        actorPermissionKeys: ['content.read', 'content.edit'],
      }),
    );

    const after = await read(post.itemId, post.slotId);
    expect(after.slot.status).toBe('CANCELLED');
    expect(after.slot.cancelledAt).not.toBeNull();
    expect(after.item.status).toBe('DRAFT');
    expect(await bodyOf(post.variantId)).toBe('Changed by a copywriter.');
    // The refund uses the SAME derived key a manual cancel would, so the two
    // can never both refund.
    expect(post.recorder.refunded).toEqual([`${post.recorder.consumed[0]}:refund`]);

    const actions = await inA((db) =>
      db.auditEvent.findMany({
        where: { resourceId: { in: [post.itemId, post.slotId] } },
        select: { action: true, reason: true },
      }),
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        { action: 'content.schedule_cancelled', reason: null },
        { action: 'content.scheduled_item_edited', reason: 'edited_without_schedule_permission' },
      ]),
    );

    // A later manual cancel of the same slot refunds nothing more.
    await inA((db) =>
      calendar(db, post.recorder.quota).cancel({
        slotId: post.slotId,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
      }),
    );
    expect(post.recorder.refunded).toHaveLength(1);
  });

  it('with content.schedule the post stays planned, and the edit is recorded', async () => {
    const post = await scheduledPost();
    await inA((db) =>
      new ContentLibraryService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: CONTENT_POLICY,
        scheduling: calendar(db, post.recorder.quota),
      }).editVariant({
        variantId: post.variantId,
        body: 'Changed by a scheduler.',
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        actorPermissionKeys: ['content.read', 'content.edit', 'content.schedule'],
      }),
    );
    const after = await read(post.itemId, post.slotId);
    expect(after.item.status).toBe('SCHEDULED');
    expect(after.slot.status).not.toBe('CANCELLED');
    expect(post.recorder.refunded).toEqual([]);
    const recorded = await inA((db) =>
      db.auditEvent.count({
        where: {
          resourceId: post.itemId,
          action: 'content.scheduled_item_edited',
          reason: 'edited_after_scheduling',
        },
      }),
    );
    expect(recorded).toBe(1);
  });

  it('a slot that has started publishing refuses the edit, and nothing changes', async () => {
    const post = await scheduledPost();
    await inA((db) =>
      db.calendarSlot.update({ where: { id: post.slotId }, data: { status: 'PUBLISHING' } }),
    );
    await expect(
      inA((db) =>
        new ContentLibraryService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: CONTENT_POLICY,
          scheduling: calendar(db, post.recorder.quota),
        }).editVariant({
          variantId: post.variantId,
          body: 'Too late.',
          actorUserId: fixtures.a.userId,
          actorBrandScope: [],
          actorPermissionKeys: ['content.read', 'content.edit'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const after = await read(post.itemId, post.slotId);
    expect(after.slot.status).toBe('PUBLISHING');
    expect(after.item.status).toBe('SCHEDULED');
    expect(await bodyOf(post.variantId)).toBe('The words that went out.');
    expect(post.recorder.refunded).toEqual([]);
  });

  it('without the calendar the edit is refused rather than leaving a live slot', async () => {
    const post = await scheduledPost();
    await expect(
      inA((db) =>
        library(db).editVariant({
          variantId: post.variantId,
          body: 'No calendar here.',
          actorUserId: fixtures.a.userId,
          actorBrandScope: [],
          actorPermissionKeys: ['content.read', 'content.edit'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await read(post.itemId, post.slotId)).slot.status).not.toBe('CANCELLED');
  });
});

describe('F1 · changing a post’s campaign is an edit', () => {
  const authorActor = () => ({
    userId: fixtures.a.userId,
    roleKey: 'content_creator',
    permissionKeys: ['content.read', 'content.submit'],
    brandScope: [] as string[],
  });
  const approvals = (db: TenantScopedClient) =>
    new ContentApprovalService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: CONTENT_POLICY,
    });
  /** As the dashboard builds it: the review withdrawal comes from the approvals module. */
  const campaigns = (db: TenantScopedClient, withdrawal = true) =>
    new CampaignService({
      db,
      workspaceId: fixtures.a.workspaceId,
      ...(withdrawal
        ? { reviewWithdrawal: { withdrawForEdit: (i) => approvals(db).withdrawForEdit(i) } }
        : {}),
    });

  let campaignId: string;
  let otherCampaignId: string;
  beforeAll(async () => {
    const make = (name: string) =>
      inA((db) =>
        db.campaign.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            name,
            objective: 'AWARENESS',
          },
          select: { id: true },
        }),
      );
    campaignId = (await make(`F1 ${crypto.randomUUID().slice(0, 6)}`)).id;
    otherCampaignId = (await make(`F1 other ${crypto.randomUUID().slice(0, 6)}`)).id;
  });

  const setCampaign = (itemId: string, id: string | null, withdrawal = true) =>
    inA((db) =>
      campaigns(db, withdrawal).setContentCampaign({
        contentItemId: itemId,
        campaignId: id,
        actor: { userId: fixtures.a.userId, brandScope: [] },
        actorPermissionKeys: ['content.create', 'campaigns.manage'],
      }),
    );

  const state = (itemId: string, approvalId?: string) =>
    inA(async (db) => ({
      item: await db.contentItem.findUniqueOrThrow({ where: { id: itemId } }),
      approval: approvalId
        ? await db.approval.findUniqueOrThrow({ where: { id: approvalId } })
        : null,
    }));

  it.each(['PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED'])(
    'a %s post keeps its campaign: read-only like its words',
    async (status) => {
      const post = await freshPost();
      await setStatus(post.itemId, status);
      await expect(setCampaign(post.itemId, campaignId)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect((await state(post.itemId)).item.campaignId).toBeNull();
    },
  );

  it('a post in review is withdrawn from review and returns to DRAFT', async () => {
    const post = await freshPost();
    const approval = await inA((db) =>
      approvals(db).submit({ itemId: post.itemId, actor: authorActor() }),
    );
    await setCampaign(post.itemId, campaignId);
    const after = await state(post.itemId, approval.id);
    expect(after.item.campaignId).toBe(campaignId);
    expect(after.item.status).toBe('DRAFT');
    expect(after.approval?.status).toBe('CANCELLED');
  });

  it('re-sending the campaign a post in review already has withdraws nothing', async () => {
    const post = await freshPost();
    await setCampaign(post.itemId, campaignId);
    const approval = await inA((db) =>
      approvals(db).submit({ itemId: post.itemId, actor: authorActor() }),
    );
    await setCampaign(post.itemId, campaignId);
    const after = await state(post.itemId, approval.id);
    expect(after.item.status).toBe('IN_REVIEW');
    expect(after.approval?.status).toBe('PENDING');
  });

  it('without the approvals module the change is refused, and the review stays open', async () => {
    const post = await freshPost();
    const approval = await inA((db) =>
      approvals(db).submit({ itemId: post.itemId, actor: authorActor() }),
    );
    await expect(setCampaign(post.itemId, campaignId, false)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const after = await state(post.itemId, approval.id);
    expect(after.item.campaignId).toBeNull();
    expect(after.approval?.status).toBe('PENDING');
  });

  it.each(['APPROVED', 'SCHEDULED', 'CHANGES_REQUESTED'])(
    'a %s post changes campaign and keeps its status: the approval covers the post, not its filing',
    async (status) => {
      const post = await freshPost();
      await setStatus(post.itemId, status);
      await setCampaign(post.itemId, otherCampaignId);
      const after = await state(post.itemId);
      expect(after.item.campaignId).toBe(otherCampaignId);
      expect(after.item.status).toBe(status);
    },
  );
});
