import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NOTE_SUBJECT_READ_PERMISSION,
  NotesService,
  readableNoteSubjectTypes,
  type NoteActor,
  type NoteSubject,
  type NoteSubjectType,
} from '@brandspace/collaboration';
import { systemClock } from '@brandspace/shared';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import type { CustomerWorkspaceContext } from '@brandspace/auth';
import { attentionItems } from '../../apps/dashboard/src/server/command-center';
import {
  appRoleClient,
  createIsolationFixtures,
  ensureWorkspaceRbac,
  platformRoleClient,
  systemRolePermissionKeys,
  type IsolationFixtures,
} from './fixtures';

/**
 * FIX PR 1 · F3 (D-409) — A NOTE THREAD IS VISIBLE ONLY TO A MEMBER WHO MAY
 * READ ITS SUBJECT, against real PostgreSQL under the tenant role and RLS.
 *
 * Owner decision: CONTENT_ITEM needs `content.read`, CAMPAIGN `campaigns.read`,
 * ASSET `assets.read`, BRAND `brand_brain.read` — always together with
 * `content.read` (`NOTE_PERMISSION`). Before this, the Viewer (Q12) and the
 * Copywriter read and answered campaign, asset and brand threads they cannot
 * open.
 *
 * The members here hold their SYSTEM role's real grants from this database,
 * and each subject is checked with a member who lacks its permission and one
 * who holds it. A refusal is the 404 of a genuine miss, never FORBIDDEN.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

interface Member {
  readonly userId: string;
  readonly actor: NoteActor;
}

let owner: Member;
let viewer: Member;
let copywriter: Member;
let approver: Member;
/** A copywriter whose BrandScope names ANOTHER brand only. */
let elsewhere: Member;
/** An approver whose membership row was written with NO brandScope at all (stored `{}` since F6). */
let unscoped: Member;

const inA = <T>(fn: (service: NotesService, db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(
    fixtures.a.workspaceId,
    async (db) =>
      fn(new NotesService({ db, workspaceId: fixtures.a.workspaceId, clock: systemClock }), db),
    { prisma: app },
  ) as Promise<T>;

async function member(
  roleKey: string,
  label: string,
  brandScope: string[] | null = [],
): Promise<Member> {
  const run = randomUUID().slice(0, 8);
  const role = await platform.role.findFirstOrThrow({
    where: { key: roleKey, workspaceId: null, realm: 'WORKSPACE' },
    select: { id: true },
  });
  const user = await platform.user.create({
    data: {
      email: `f3-${label}-${run}@example.local`,
      name: `F3 ${label} ${run}`,
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
      // `null` is written by leaving the column out, the way onboarding writes
      // an owner — stored NULL before F6 and `{}` since; both mean every brand.
      ...(brandScope === null ? {} : { brandScope }),
    },
  });
  return {
    userId: user.id,
    actor: {
      userId: user.id,
      permissionKeys: await systemRolePermissionKeys(platform, roleKey),
      brandScope: brandScope ?? [],
    },
  };
}

function subjects(): Record<NoteSubjectType, NoteSubject> {
  return {
    CONTENT_ITEM: { type: 'CONTENT_ITEM', contentItemId: fixtures.a.contentItemId },
    CAMPAIGN: { type: 'CAMPAIGN', campaignId: fixtures.a.campaignId },
    ASSET: { type: 'ASSET', assetId: fixtures.a.assetId, brandId: fixtures.a.brandId },
    BRAND: { type: 'BRAND', brandId: fixtures.a.brandId },
  };
}

/** A thread the owner starts about `subject`, naming `mention`. */
const ownersThread = (subject: NoteSubject, mention: readonly string[] = []) =>
  inA((service) =>
    service.startThread({
      actor: owner.actor,
      subject,
      body: `About ${subject.type} ${randomUUID().slice(0, 6)}`,
      mentionedUserIds: mention,
    }),
  );

const mentionRows = (noteId: string) =>
  platform.noteMention.findMany({ where: { noteId }, select: { mentionedUserId: true } });

const MISS = { code: 'NOT_FOUND' };

function session(m: Member): CustomerWorkspaceContext {
  return {
    workspaceId: fixtures.a.workspaceId,
    workspaceName: 'Fixture',
    workspaceSlug: 'fixture',
    workspaceStatus: 'ACTIVE',
    roleKey: 'client_viewer',
    roleNameEn: 'Viewer',
    roleNameAr: 'مشاهد',
    permissionKeys: [...m.actor.permissionKeys],
    brandScope: [...m.actor.brandScope],
  };
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  await ensureWorkspaceRbac(platform);
  const ownerKeys = await systemRolePermissionKeys(platform, 'workspace_owner');
  owner = {
    userId: fixtures.a.userId,
    actor: { userId: fixtures.a.userId, permissionKeys: ownerKeys, brandScope: [] },
  };
  viewer = await member('client_viewer', 'viewer');
  copywriter = await member('copywriter', 'copywriter');
  approver = await member('approver', 'approver');
  elsewhere = await member('copywriter', 'elsewhere', [randomUUID()]);
  unscoped = await member('approver', 'unscoped', null);
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('F3 · the rule, from the real role grants', () => {
  it('maps each subject to its read permission', () => {
    expect(NOTE_SUBJECT_READ_PERMISSION).toEqual({
      CONTENT_ITEM: 'content.read',
      CAMPAIGN: 'campaigns.read',
      ASSET: 'assets.read',
      BRAND: 'brand_brain.read',
    });
  });

  it('the Viewer reads content threads only; the Copywriter everything but campaigns', () => {
    expect(readableNoteSubjectTypes(viewer.actor.permissionKeys)).toEqual(['CONTENT_ITEM']);
    expect(readableNoteSubjectTypes(copywriter.actor.permissionKeys).sort()).toEqual(
      ['ASSET', 'BRAND', 'CONTENT_ITEM'].sort(),
    );
    expect(readableNoteSubjectTypes(approver.actor.permissionKeys).sort()).toEqual(
      ['ASSET', 'BRAND', 'CAMPAIGN', 'CONTENT_ITEM'].sort(),
    );
  });

  it('a subject permission without content.read opens nothing (AND, never OR)', () => {
    expect(readableNoteSubjectTypes(['assets.read', 'brand_brain.read', 'campaigns.read'])).toEqual(
      [],
    );
  });
});

describe('F3 · a member without the subject permission meets a miss on every path', () => {
  const unreadable: ReadonlyArray<readonly [NoteSubjectType, 'viewer' | 'copywriter']> = [
    ['CAMPAIGN', 'viewer'],
    ['ASSET', 'viewer'],
    ['BRAND', 'viewer'],
    ['CAMPAIGN', 'copywriter'],
  ];

  it.each(unreadable)('%s thread, as the %s', async (type, who) => {
    const reader = who === 'viewer' ? viewer : copywriter;
    const subject = subjects()[type];
    const { threadId } = await ownersThread(subject, [reader.userId]);
    const before = await platform.noteThread.findUniqueOrThrow({ where: { id: threadId } });
    const notesBefore = await platform.note.count({ where: { threadId } });

    // Starting one, and listing the subject's threads: the miss a random id gets.
    await expect(
      inA((s) => s.startThread({ actor: reader.actor, subject, body: 'Hello' })),
    ).rejects.toMatchObject(MISS);
    await expect(inA((s) => s.threadsFor(subject, reader.actor))).rejects.toMatchObject(MISS);

    // Every path on the existing thread: 404, and NEVER FORBIDDEN naming notes.manage.
    const onThread: ReadonlyArray<(s: NotesService) => Promise<unknown>> = [
      (s) => s.notesIn(threadId, reader.actor),
      (s) => s.reply({ actor: reader.actor, threadId, body: 'Me too' }),
      (s) => s.markMentionsRead({ actor: reader.actor, threadId }),
      (s) => s.resolve({ actor: reader.actor, threadId }),
      (s) => s.reopen({ actor: reader.actor, threadId }),
      (s) => s.assign({ actor: reader.actor, threadId, assignedToUserId: null }),
      (s) => s.setDue({ actor: reader.actor, threadId, dueAt: null }),
      (s) => s.setImportance({ actor: reader.actor, threadId, importance: 'IMPORTANT' }),
    ];
    for (const call of onThread) await expect(inA(call)).rejects.toMatchObject(MISS);
    // And the random-id miss looks exactly the same.
    await expect(inA((s) => s.notesIn(randomUUID(), reader.actor))).rejects.toMatchObject(MISS);

    // Nothing changed, nothing was written.
    const after = await platform.noteThread.findUniqueOrThrow({ where: { id: threadId } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.status).toBe(before.status);
    expect(await platform.note.count({ where: { threadId } })).toBe(notesBefore);

    // The inbox, the dot and the incoming notice do not carry it.
    const inbox = await inA((s) => s.inbox(reader.actor));
    const listed = [...inbox.forYou, ...inbox.open].map((entry) => entry.threadId);
    expect(listed).not.toContain(threadId);
    const incoming = await inA((s) => s.incomingMentions(reader.actor, 50));
    expect(incoming.map((m) => m.threadId)).not.toContain(threadId);
  });

  it.each(['CAMPAIGN', 'ASSET', 'BRAND'] as const)(
    'naming the Viewer in a %s thread writes no mention row; a member who may read it gets one',
    async (type) => {
      const { noteId } = await ownersThread(subjects()[type], [viewer.userId, approver.userId]);
      const named = (await mentionRows(noteId)).map((row) => row.mentionedUserId);
      expect(named).toContain(approver.userId);
      expect(named).not.toContain(viewer.userId);
    },
  );

  it('the Viewer cannot be assigned a campaign thread — refused like a non-member', async () => {
    await expect(
      inA((s) =>
        s.startThread({
          actor: owner.actor,
          subject: subjects().CAMPAIGN,
          body: 'Over to you',
          assignedToUserId: viewer.userId,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'That person is not in this workspace.',
    });
  });
});

describe('F3 · a member with the permission keeps everything', () => {
  it.each(['CONTENT_ITEM', 'CAMPAIGN', 'ASSET', 'BRAND'] as const)(
    '%s: the approver reads, replies, is named, and sees it in the inbox',
    async (type) => {
      const subject = subjects()[type];
      const { threadId, noteId } = await ownersThread(subject, [approver.userId]);
      expect((await mentionRows(noteId)).map((r) => r.mentionedUserId)).toContain(approver.userId);
      const threads = await inA((s) => s.threadsFor(subject, approver.actor));
      expect(threads.map((t) => t.id)).toContain(threadId);
      await inA((s) => s.reply({ actor: approver.actor, threadId, body: 'Looks right.' }));
      const notes = await inA((s) => s.notesIn(threadId, approver.actor));
      expect(notes.map((n) => n.body)).toContain('Looks right.');
      const inbox = await inA((s) => s.inbox(approver.actor));
      expect(inbox.forYou.map((e) => e.threadId)).toContain(threadId);
    },
  );

  it('CONTENT_ITEM: the Viewer still reads, replies and is named (Q12 unchanged)', async () => {
    const subject = subjects().CONTENT_ITEM;
    const { threadId, noteId } = await ownersThread(subject, [viewer.userId]);
    expect((await mentionRows(noteId)).map((r) => r.mentionedUserId)).toContain(viewer.userId);
    await inA((s) => s.reply({ actor: viewer.actor, threadId, body: 'Seen it.' }));
    const incoming = await inA((s) => s.incomingMentions(viewer.actor, 50));
    expect(incoming.map((m) => m.threadId)).toContain(threadId);
  });
});

describe('F3 · the picker offers exactly the people the service accepts', () => {
  it('a campaign thread offers members who may read campaigns, in the brand', async () => {
    const offered = (await inA((s) => s.mentionCandidates(subjects().CAMPAIGN, owner.actor))).map(
      (m) => m.userId,
    );
    expect(offered).toContain(approver.userId);
    expect(offered).toContain(unscoped.userId);
    expect(offered).not.toContain(viewer.userId);
    expect(offered).not.toContain(copywriter.userId);
    expect(offered).not.toContain(elsewhere.userId);
  });

  it('a content thread offers the Viewer, and still not a member scoped to another brand', async () => {
    const offered = (
      await inA((s) => s.mentionCandidates(subjects().CONTENT_ITEM, owner.actor))
    ).map((m) => m.userId);
    expect(offered).toContain(viewer.userId);
    expect(offered).toContain(copywriter.userId);
    expect(offered).not.toContain(elsewhere.userId);
  });

  it('a member scoped to another brand is dropped from a mention — new for content threads too', async () => {
    const { noteId } = await ownersThread(subjects().CONTENT_ITEM, [
      elsewhere.userId,
      unscoped.userId,
    ]);
    const named = (await mentionRows(noteId)).map((row) => row.mentionedUserId);
    expect(named).not.toContain(elsewhere.userId);
    // An omitted scope means every brand (NULL before F6, `{}` since): the row is not lost.
    expect(named).toContain(unscoped.userId);
  });

  it('the Viewer may not ask for the candidates of a subject it cannot read', async () => {
    await expect(
      inA((s) => s.mentionCandidates(subjects().CAMPAIGN, viewer.actor)),
    ).rejects.toMatchObject(MISS);
  });
});

describe('F3 · rows written before the rule are kept, and hidden', () => {
  it('an old mention and assignment of the Viewer on a campaign thread count nowhere', async () => {
    // As rows written before D-409: a campaign thread assigned to the Viewer,
    // with an unread mention of the Viewer.
    const thread = await platform.noteThread.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        subjectType: 'CAMPAIGN',
        campaignId: fixtures.a.campaignId,
        status: 'OPEN',
        createdByUserId: owner.userId,
        assignedToUserId: viewer.userId,
      },
    });
    const note = await platform.note.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        threadId: thread.id,
        authorUserId: owner.userId,
        body: 'Written before the rule.',
      },
    });
    await platform.noteMention.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        noteId: note.id,
        mentionedUserId: viewer.userId,
      },
    });

    const count = await inA((s) => s.unreadMentionCount(viewer.actor));
    const incoming = await inA((s) => s.incomingMentions(viewer.actor, 50));
    expect(incoming.map((m) => m.threadId)).not.toContain(thread.id);
    const assigned = await inA((s) => s.assignedOpenCount(viewer.actor));
    const items = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => attentionItems(db, session(viewer), viewer.userId),
      { prisma: app },
    );
    // Kept, not deleted: the rows are still there.
    expect(await platform.noteMention.count({ where: { noteId: note.id } })).toBe(1);
    // And counted nowhere for the Viewer.
    const mentionItem = items.find((i) => i.kind === 'notes-mentions');
    const assignedItem = items.find((i) => i.kind === 'notes-assigned');
    const campaignMentions = await platform.noteMention.count({
      where: {
        mentionedUserId: viewer.userId,
        readAt: null,
        note: { thread: { subjectType: 'CONTENT_ITEM' }, authorUserId: { not: viewer.userId } },
      },
    });
    expect(count).toBe(campaignMentions);
    expect(mentionItem?.count ?? 0).toBe(campaignMentions);
    expect(assigned).toBe(0);
    expect(assignedItem).toBeUndefined();
  });
});
