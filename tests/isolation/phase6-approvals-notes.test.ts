import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotesService, type NoteActor } from '@brandspace/collaboration';
import { systemClock } from '@brandspace/shared';
import type { TenantScopedClient } from '@brandspace/database';
import { noteForChangesRequested } from '../../apps/dashboard/src/server/approval-notes';

/**
 * PHASE 6 · P6-06 — "NEEDS WORK" LEAVES A CONVERSATION BEHIND.
 *
 * THE APPROVAL SERVICE IS UNTOUCHED, and that is the point of this workstream
 * rather than an aside. `ContentApprovalService.decide()` already locks the row
 * before reading it, re-checks brand scope and self-approval authority against
 * the cycle's own snapshot, records a content fingerprint on approve, and
 * audits every outcome. None of that moved. What Phase 6 adds is what happens
 * AFTER a `REQUEST_CHANGES` verdict commits.
 *
 * THE PROBLEM IT SOLVES. `REQUEST_CHANGES` hands the item back to its author
 * with a `decisionNote` attached to a CLOSED approval cycle. The author opens
 * the draft, and the reason they were asked to change it is on a different
 * screen, in a record that is finished and cannot be replied to. A thread on
 * the content item puts the request where the work is, and makes it answerable.
 *
 * WHAT THIS FILE PINS:
 *
 *   - only `REQUEST_CHANGES` produces a thread — approve and reject do not;
 *   - an empty decision note produces nothing, because a thread reading "" that
 *     notifies somebody is the product talking to itself;
 *   - the author is mentioned, so it reaches their Command Center;
 *   - the thread lands on the CONTENT ITEM, not on the brand or a campaign;
 *   - tenant isolation holds through the integration, not just in the service.
 */

let platform: PrismaClient;

interface Fixture {
  readonly workspaceId: string;
  readonly brandId: string;
  readonly authorId: string;
  readonly reviewerId: string;
  readonly contentItemId: string;
}

async function freshWorkspace(label: string): Promise<Fixture> {
  const run = crypto.randomUUID();
  const role = await platform.role.findFirstOrThrow({
    where: { key: 'workspace_owner', realm: 'WORKSPACE', workspaceId: null },
    select: { id: true },
  });

  const author = await platform.user.create({
    data: {
      email: `appr-author-${label}-${run}@example.local`,
      name: `Author ${label}`,
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  const reviewer = await platform.user.create({
    data: {
      email: `appr-reviewer-${label}-${run}@example.local`,
      name: `Reviewer ${label}`,
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  const workspace = await platform.workspace.create({
    data: {
      id: run,
      workspaceId: run,
      slug: `appr-${run.slice(0, 12)}`,
      name: `Approvals ${label}`,
      ownerUserId: author.id,
      status: 'ACTIVE',
      country: 'SA',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
    },
  });
  for (const userId of [author.id, reviewer.id]) {
    await platform.membership.create({
      data: {
        workspaceId: workspace.id,
        userId,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });
  }
  const brand = await platform.brand.create({
    data: {
      workspaceId: workspace.id,
      name: `Brand ${label}`,
      slug: `brand-${run.slice(0, 8)}`,
    },
  });
  const item = await platform.contentItem.create({
    data: {
      workspaceId: workspace.id,
      brandId: brand.id,
      title: `Draft ${label}`,
      status: 'IN_REVIEW',
      createdByUserId: author.id,
    },
  });
  return {
    workspaceId: workspace.id,
    brandId: brand.id,
    authorId: author.id,
    reviewerId: reviewer.id,
    contentItemId: item.id,
  };
}

/** The REVIEWER is the actor — they are the one deciding. */
function reviewerActor(fixture: Fixture): NoteActor {
  return { userId: fixture.reviewerId, permissionKeys: ['content.read'], brandScope: [] };
}

function serviceFor(workspaceId: string): NotesService {
  return new NotesService({
    db: platform as unknown as TenantScopedClient,
    workspaceId,
    clock: systemClock,
  });
}

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}, 60_000);

afterAll(async () => {
  await platform?.$disconnect();
});

describe('P6-06 · only a changes-requested verdict starts a conversation', () => {
  it('writes a thread on the content item, carrying the reviewer note', async () => {
    const fixture = await freshWorkspace('needs-work');
    const service = serviceFor(fixture.workspaceId);
    const decisionNote = 'The second paragraph contradicts the campaign brief.';

    const threadId = await noteForChangesRequested({
      service,
      actor: reviewerActor(fixture),
      verdict: 'REQUEST_CHANGES',
      contentItemId: fixture.contentItemId,
      requestedByUserId: fixture.authorId,
      decisionNote,
    });

    expect(threadId).not.toBeNull();
    const thread = await platform.noteThread.findUniqueOrThrow({
      where: { id: threadId as string },
    });
    // ON THE CONTENT ITEM — not the brand, not a campaign. The request is about
    // this draft, and a thread on the brand would be unfindable from the work.
    expect(thread.subjectType).toBe('CONTENT_ITEM');
    expect(thread.contentItemId).toBe(fixture.contentItemId);
    expect(thread.status).toBe('OPEN');

    const notes = await platform.note.findMany({ where: { threadId: thread.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toBe(decisionNote);
  });

  it('mentions the author, so it reaches their Command Center', async () => {
    // Without the mention the request sits on a draft waiting to be found, and
    // "what needs you" does not know about it.
    const fixture = await freshWorkspace('mention-author');
    const service = serviceFor(fixture.workspaceId);

    await noteForChangesRequested({
      service,
      actor: reviewerActor(fixture),
      verdict: 'REQUEST_CHANGES',
      contentItemId: fixture.contentItemId,
      requestedByUserId: fixture.authorId,
      decisionNote: 'Please tighten the opening.',
    });

    const authorActor: NoteActor = {
      userId: fixture.authorId,
      permissionKeys: ['content.read'],
      brandScope: [],
    };
    expect(await service.unreadMentionCount(authorActor)).toBe(1);
    // And NOT for the reviewer, who wrote it.
    expect(await service.unreadMentionCount(reviewerActor(fixture))).toBe(0);
  });

  it('writes nothing for an approval', async () => {
    const fixture = await freshWorkspace('approved');
    const threadId = await noteForChangesRequested({
      service: serviceFor(fixture.workspaceId),
      actor: reviewerActor(fixture),
      verdict: 'APPROVE',
      contentItemId: fixture.contentItemId,
      requestedByUserId: fixture.authorId,
      decisionNote: 'Looks good.',
    });
    expect(threadId).toBeNull();
    expect(await platform.noteThread.count({ where: { workspaceId: fixture.workspaceId } })).toBe(
      0,
    );
  });

  it('writes nothing for a rejection', async () => {
    // A rejection ENDS the cycle rather than asking for something. Opening a
    // conversation would invite a reply to a decision that is not a request.
    const fixture = await freshWorkspace('rejected');
    const threadId = await noteForChangesRequested({
      service: serviceFor(fixture.workspaceId),
      actor: reviewerActor(fixture),
      verdict: 'REJECT',
      contentItemId: fixture.contentItemId,
      requestedByUserId: fixture.authorId,
      decisionNote: 'Not this one.',
    });
    expect(threadId).toBeNull();
    expect(await platform.noteThread.count({ where: { workspaceId: fixture.workspaceId } })).toBe(
      0,
    );
  });

  it('writes nothing when the reviewer left no note', async () => {
    // A thread reading "" that notifies its author is the product talking to
    // itself, and the notification would be about nothing.
    const fixture = await freshWorkspace('silent');
    const threadId = await noteForChangesRequested({
      service: serviceFor(fixture.workspaceId),
      actor: reviewerActor(fixture),
      verdict: 'REQUEST_CHANGES',
      contentItemId: fixture.contentItemId,
      requestedByUserId: fixture.authorId,
      decisionNote: '   ',
    });
    expect(threadId).toBeNull();
    expect(await platform.noteThread.count({ where: { workspaceId: fixture.workspaceId } })).toBe(
      0,
    );
  });

  it('writes nothing for an approval that has no content item', async () => {
    const fixture = await freshWorkspace('no-subject');
    const threadId = await noteForChangesRequested({
      service: serviceFor(fixture.workspaceId),
      actor: reviewerActor(fixture),
      verdict: 'REQUEST_CHANGES',
      contentItemId: null,
      requestedByUserId: fixture.authorId,
      decisionNote: 'About what, though?',
    });
    expect(threadId).toBeNull();
  });
});

describe('P6-06 · the integration does not become a way across tenants', () => {
  it("a reviewer cannot open a thread on another workspace's content", async () => {
    /*
     * THE SERVICE REFUSES, AND THE INTEGRATION INHERITS THAT. The helper adds a
     * rule about WHEN to write a note; it adds no authority, so a content item
     * id from another workspace is refused exactly as it would be anywhere
     * else — as a 404 shaped like a genuine miss.
     */
    const a = await freshWorkspace('cross-a');
    const b = await freshWorkspace('cross-b');

    await expect(
      noteForChangesRequested({
        service: serviceFor(a.workspaceId),
        actor: reviewerActor(a),
        verdict: 'REQUEST_CHANGES',
        contentItemId: b.contentItemId,
        requestedByUserId: a.authorId,
        decisionNote: 'reaching across',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await platform.noteThread.count({ where: { contentItemId: b.contentItemId } })).toBe(0);
  });
});

describe('P6-06 · approvals are not forced on a workspace that did not ask', () => {
  it('the platform-wide default leaves the scheduling gate OFF', async () => {
    /*
     * ASSERTED RATHER THAN CHANGED, because it is already true and the brief
     * asks for the property rather than for a change. This is the "do not
     * rebuild what works" case, written down so the property cannot regress
     * quietly.
     *
     * `requireApprovalBeforeScheduling` defaults to FALSE in the `content`
     * domain, so a workspace nobody has configured — a solo founder, a
     * brand-new staging tenant — schedules with no review cycle at all. A brand
     * may depart from it through `approval_policy`, which is exactly the
     * "active policy" the brief allows to require one.
     *
     * Read from the schema's own default rather than restated here, so changing
     * the shipped default fails this test instead of being discovered by a
     * customer who suddenly cannot publish.
     */
    const { CONFIG_DOMAINS } = await import('@brandspace/config');
    const parsed = CONFIG_DOMAINS['content']?.schema.parse({}) as {
      approvals: { requireApprovalBeforeScheduling: boolean; allowSelfApproval: boolean };
    };
    expect(parsed.approvals.requireApprovalBeforeScheduling).toBe(false);
  });

  it('and a brand may still require one, which is what a policy is for', async () => {
    // The gate being off by default is not the same as the gate not existing.
    const { CONFIG_DOMAINS } = await import('@brandspace/config');
    const required = CONFIG_DOMAINS['content']?.schema.parse({
      approvals: { requireApprovalBeforeScheduling: true },
    }) as { approvals: { requireApprovalBeforeScheduling: boolean } };
    expect(required.approvals.requireApprovalBeforeScheduling).toBe(true);
  });
});
