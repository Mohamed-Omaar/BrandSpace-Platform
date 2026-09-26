import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotesService, type NoteActor } from '@brandspace/collaboration';
import { systemClock } from '@brandspace/shared';
import type { TenantScopedClient } from '@brandspace/database';

/**
 * PHASE 6 · P6-05 — NOTES, THREADS AND MENTIONS ARE TENANT-OWNED, AND THIS IS
 * THE ISOLATION TEST CLAUDE.md §2.1 REQUIRES IN THE SAME CHANGE AS THE MODEL.
 *
 * Three new tables carrying the most quotable content in the product: what
 * people said to each other about work in progress. A leak here is not a count
 * or a name, it is a sentence somebody wrote believing it stayed inside their
 * workspace.
 *
 * WHAT THIS FILE PINS:
 *
 *   - a thread, a note and a mention in workspace B are invisible from A —
 *     read, list and count alike;
 *   - a cross-tenant write is refused, and refused as a 404 shaped identically
 *     to a genuine miss, so the refusal does not confirm the row exists;
 *   - brand scope is honoured, so a member scoped to one brand cannot read or
 *     start a conversation about another;
 *   - a mention only ever names an ACTIVE MEMBER of this workspace, so it
 *     cannot become an account-enumeration oracle or put a notification in a
 *     stranger's list;
 *   - NOTES NEVER BECOME BRAND BRAIN KNOWLEDGE — the separation the whole
 *     design rests on, asserted rather than assumed.
 */

let platform: PrismaClient;

interface Fixture {
  readonly workspaceId: string;
  readonly brandId: string;
  readonly userId: string;
  readonly contentItemId: string;
}

async function freshWorkspace(label: string): Promise<Fixture> {
  const run = crypto.randomUUID();
  const user = await platform.user.create({
    data: {
      email: `notes-${label}-${run}@example.local`,
      name: `Notes ${label}`,
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  const workspace = await platform.workspace.create({
    data: {
      id: run,
      workspaceId: run,
      slug: `notes-${run.slice(0, 12)}`,
      name: `Notes ${label}`,
      ownerUserId: user.id,
      status: 'ACTIVE',
      country: 'SA',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
    },
  });
  const role = await platform.role.findFirstOrThrow({
    where: { key: 'workspace_owner', realm: 'WORKSPACE', workspaceId: null },
    select: { id: true },
  });
  await platform.membership.create({
    data: {
      workspaceId: workspace.id,
      userId: user.id,
      roleId: role.id,
      status: 'ACTIVE',
      acceptedAt: new Date(),
    },
  });
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
      status: 'DRAFT',
    },
  });
  return {
    workspaceId: workspace.id,
    brandId: brand.id,
    userId: user.id,
    contentItemId: item.id,
  };
}

function actorFor(fixture: Fixture, overrides: Partial<NoteActor> = {}): NoteActor {
  return {
    userId: fixture.userId,
    // Every role that reads content also triages notes (Q12, `notes.manage`).
    permissionKeys: ['content.read', 'notes.manage'],
    brandScope: [],
    ...overrides,
  };
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

describe('P6-05 · a conversation belongs to exactly one workspace', () => {
  it('cross-tenant read of a thread returns not-found, not the thread', async () => {
    const a = await freshWorkspace('read-a');
    const b = await freshWorkspace('read-b');

    const { threadId } = await serviceFor(b.workspaceId).startThread({
      actor: actorFor(b),
      subject: { type: 'CONTENT_ITEM', contentItemId: b.contentItemId },
      body: "B's private conversation",
    });

    // A's service, asked for B's thread by id.
    await expect(serviceFor(a.workspaceId).notesIn(threadId, actorFor(a))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('listing excludes the other tenant entirely', async () => {
    const a = await freshWorkspace('list-a');
    const b = await freshWorkspace('list-b');
    await serviceFor(b.workspaceId).startThread({
      actor: actorFor(b),
      subject: { type: 'CONTENT_ITEM', contentItemId: b.contentItemId },
      body: "B's thread",
    });

    // A asking about its OWN subject sees nothing of B's.
    const threads = await serviceFor(a.workspaceId).threadsFor(
      { type: 'CONTENT_ITEM', contentItemId: a.contentItemId },
      actorFor(a),
    );
    expect(threads).toEqual([]);
  });

  it("a cross-tenant write is refused — A cannot start a thread on B's content", async () => {
    const a = await freshWorkspace('write-a');
    const b = await freshWorkspace('write-b');

    await expect(
      serviceFor(a.workspaceId).startThread({
        actor: actorFor(a),
        subject: { type: 'CONTENT_ITEM', contentItemId: b.contentItemId },
        body: 'reaching across',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // And nothing was written on the way to refusing.
    expect(await platform.noteThread.count({ where: { contentItemId: b.contentItemId } })).toBe(0);
  });

  it('a refusal is shaped identically to a genuine miss', async () => {
    /*
     * THE WHOLE POINT OF §2.1's 404 RULE. If "you may not see this" and "this
     * does not exist" differ in any way a caller can observe, the difference
     * confirms the row exists — which is the fact being protected.
     */
    const a = await freshWorkspace('shape-a');
    const b = await freshWorkspace('shape-b');
    const { threadId } = await serviceFor(b.workspaceId).startThread({
      actor: actorFor(b),
      subject: { type: 'CONTENT_ITEM', contentItemId: b.contentItemId },
      body: 'exists, but not for A',
    });

    /** The error a call threw, or null if it unexpectedly succeeded. */
    const refusal = async (id: string): Promise<{ code: string; message: string } | null> => {
      try {
        await serviceFor(a.workspaceId).notesIn(id, actorFor(a));
        return null;
      } catch (error: unknown) {
        const failure = error as { code: string; message: string };
        return { code: failure.code, message: failure.message };
      }
    };

    const forbidden = await refusal(threadId);
    const genuinelyAbsent = await refusal(crypto.randomUUID());

    // Both refused — a success on either side would make the comparison vacuous.
    expect(forbidden).not.toBeNull();
    expect(genuinelyAbsent).not.toBeNull();
    expect(forbidden).toEqual(genuinelyAbsent);
  });

  it('a mention in B is never counted for a person in A', async () => {
    const a = await freshWorkspace('mention-a');
    const b = await freshWorkspace('mention-b');
    await serviceFor(b.workspaceId).startThread({
      actor: actorFor(b),
      subject: { type: 'CONTENT_ITEM', contentItemId: b.contentItemId },
      body: 'naming B',
      mentionedUserIds: [b.userId],
    });

    expect(await serviceFor(b.workspaceId).unreadMentionCount(actorFor(b))).toBe(1);
    // The same person, asked about from A's workspace, has nothing here.
    expect(await serviceFor(a.workspaceId).unreadMentionCount(actorFor(b))).toBe(0);
  });
});

describe('P6-05 · brand scope is honoured inside a workspace', () => {
  it('a member scoped to one brand cannot start a thread about another', async () => {
    const fixture = await freshWorkspace('scope');
    const other = await platform.brand.create({
      data: {
        workspaceId: fixture.workspaceId,
        name: 'Other brand',
        slug: `other-${crypto.randomUUID().slice(0, 8)}`,
      },
    });

    await expect(
      serviceFor(fixture.workspaceId).startThread({
        actor: actorFor(fixture, { brandScope: [fixture.brandId] }),
        subject: { type: 'BRAND', brandId: other.id },
        body: 'out of scope',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('and cannot read a thread about it either', async () => {
    const fixture = await freshWorkspace('scope-read');
    const other = await platform.brand.create({
      data: {
        workspaceId: fixture.workspaceId,
        name: 'Other brand',
        slug: `other-${crypto.randomUUID().slice(0, 8)}`,
      },
    });
    // Created by somebody unrestricted...
    const { threadId } = await serviceFor(fixture.workspaceId).startThread({
      actor: actorFor(fixture),
      subject: { type: 'BRAND', brandId: other.id },
      body: 'about the other brand',
    });

    // ...and invisible to somebody scoped away from it.
    await expect(
      serviceFor(fixture.workspaceId).notesIn(
        threadId,
        actorFor(fixture, { brandScope: [fixture.brandId] }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('P6-05 · a mention names a member of this workspace, or nobody', () => {
  it('drops a user id that belongs to another workspace', async () => {
    /*
     * NOT AN ERROR — A DROP. Rejecting the note would tell the mentioner that
     * the id is real but not here, which is the enumeration oracle. Dropping it
     * means an unresolvable name simply raises no notification, and the note is
     * still posted.
     */
    const a = await freshWorkspace('name-a');
    const b = await freshWorkspace('name-b');

    const { noteId } = await serviceFor(a.workspaceId).startThread({
      actor: actorFor(a),
      subject: { type: 'CONTENT_ITEM', contentItemId: a.contentItemId },
      body: "naming somebody who is not in A's workspace",
      mentionedUserIds: [b.userId],
    });

    expect(await platform.noteMention.count({ where: { noteId } })).toBe(0);
    // And B was not notified about a workspace they do not belong to.
    expect(await serviceFor(b.workspaceId).unreadMentionCount(actorFor(b))).toBe(0);
  });

  it('refuses to assign a thread to somebody who is not a member', async () => {
    // Assignment DOES refuse rather than drop: silently assigning to nobody
    // would leave the thread looking unowned to the person who assigned it.
    const a = await freshWorkspace('assign-a');
    const b = await freshWorkspace('assign-b');

    await expect(
      serviceFor(a.workspaceId).startThread({
        actor: actorFor(a),
        subject: { type: 'CONTENT_ITEM', contentItemId: a.contentItemId },
        body: 'assigning a stranger',
        assignedToUserId: b.userId,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('names the same person once however many times they are listed', async () => {
    const fixture = await freshWorkspace('dedupe');
    const { noteId } = await serviceFor(fixture.workspaceId).startThread({
      actor: actorFor(fixture),
      subject: { type: 'CONTENT_ITEM', contentItemId: fixture.contentItemId },
      body: 'you, and you, and you',
      mentionedUserIds: [fixture.userId, fixture.userId, fixture.userId],
    });
    expect(await platform.noteMention.count({ where: { noteId } })).toBe(1);
  });
});

describe('P6-05 · a member without the permission sees nothing', () => {
  it('refuses a read with a 404, not a 403', async () => {
    const fixture = await freshWorkspace('perm');
    const { threadId } = await serviceFor(fixture.workspaceId).startThread({
      actor: actorFor(fixture),
      subject: { type: 'CONTENT_ITEM', contentItemId: fixture.contentItemId },
      body: 'members only',
    });

    await expect(
      serviceFor(fixture.workspaceId).notesIn(
        threadId,
        actorFor(fixture, { permissionKeys: ['workspace.read'] }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('P6-05 · NOTES ARE NOT BRAND BRAIN KNOWLEDGE', () => {
  it('writing a note creates no brand knowledge whatsoever', async () => {
    /*
     * THE SENTENCE THE WHOLE DESIGN RESTS ON, asserted rather than trusted.
     *
     * `BrandKnowledgeItem` is what the brand has DECIDED is true: it carries
     * provenance, an authority level, and the precedence rule that no
     * AI-inferred item may overwrite a human one. Every AI surface in the
     * product generates from it. A note is an opinion in a thread.
     *
     * If a remark could become governed memory by being typed into the wrong
     * box, the four-layer model would be describing a guarantee the product does
     * not have — and nobody would notice until the Copilot started repeating it.
     */
    const fixture = await freshWorkspace('not-knowledge');
    const before = await platform.brandKnowledgeItem.count({
      where: { workspaceId: fixture.workspaceId },
    });

    const { threadId } = await serviceFor(fixture.workspaceId).startThread({
      actor: actorFor(fixture),
      subject: { type: 'BRAND', brandId: fixture.brandId },
      body: 'Our tone of voice should be much more formal from now on.',
      mentionedUserIds: [fixture.userId],
    });
    await serviceFor(fixture.workspaceId).reply({
      actor: actorFor(fixture),
      threadId,
      body: 'Agreed — treat that as settled.',
    });
    await serviceFor(fixture.workspaceId).resolve({ actor: actorFor(fixture), threadId });

    const after = await platform.brandKnowledgeItem.count({
      where: { workspaceId: fixture.workspaceId },
    });
    expect(after).toBe(before);
  });

  it('the collaboration package imports nothing from brand-brain', async () => {
    // Structural, not behavioural: the assertion above proves today's methods
    // write nothing, and this proves a future one cannot quietly start to.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('packages/collaboration/src/notes.ts', 'utf8');
    expect(source).not.toContain('brand-brain');
    expect(source).not.toContain('brandKnowledgeItem');

    const manifest = JSON.parse(readFileSync('packages/collaboration/package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@brandspace/brand-brain');
  });
});

describe('P6-05 · the conversation behaves like a conversation', () => {
  it('replying to a resolved thread reopens it', async () => {
    // Somebody typing into a closed thread is saying it is not closed. Leaving
    // it resolved hides the reply from every "what is open" view.
    const fixture = await freshWorkspace('reopen');
    const { threadId } = await serviceFor(fixture.workspaceId).startThread({
      actor: actorFor(fixture),
      subject: { type: 'CONTENT_ITEM', contentItemId: fixture.contentItemId },
      body: 'first',
    });
    await serviceFor(fixture.workspaceId).resolve({ actor: actorFor(fixture), threadId });
    await serviceFor(fixture.workspaceId).reply({
      actor: actorFor(fixture),
      threadId,
      body: 'actually, one more thing',
    });

    const thread = await platform.noteThread.findUniqueOrThrow({ where: { id: threadId } });
    expect(thread.status).toBe('OPEN');
    expect(thread.resolvedAt).toBeNull();
    expect(thread.resolvedByUserId).toBeNull();
  });

  it('every state change writes an audit event, and none of them carries the body', async () => {
    /*
     * WHAT CHANGED IS AUDITABLE; WHAT WAS SAID IS NOT COPIED. The audit trail
     * has its own readers and its own retention, and duplicating a private
     * remark into it would put the conversation somewhere the conversation's own
     * permissions do not reach.
     */
    const fixture = await freshWorkspace('audit');
    const secret = 'Do not repeat this outside the thread.';
    const { threadId } = await serviceFor(fixture.workspaceId).startThread({
      actor: actorFor(fixture),
      subject: { type: 'CONTENT_ITEM', contentItemId: fixture.contentItemId },
      body: secret,
    });
    await serviceFor(fixture.workspaceId).resolve({ actor: actorFor(fixture), threadId });

    const events = await platform.auditEvent.findMany({
      where: { workspaceId: fixture.workspaceId, resourceId: threadId },
    });
    expect(events.map((e) => e.action).sort()).toEqual([
      'customer.note.resolved',
      'customer.note.thread_started',
    ]);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('marking mentions read clears them for that person only', async () => {
    const fixture = await freshWorkspace('read-state');
    const other = await platform.user.create({
      data: {
        email: `notes-other-${crypto.randomUUID()}@example.local`,
        name: 'Other member',
        status: 'ACTIVE',
        timezone: 'UTC',
      },
    });
    const role = await platform.role.findFirstOrThrow({
      where: { key: 'workspace_owner', realm: 'WORKSPACE', workspaceId: null },
      select: { id: true },
    });
    await platform.membership.create({
      data: {
        workspaceId: fixture.workspaceId,
        userId: other.id,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });

    const service = serviceFor(fixture.workspaceId);
    const { threadId } = await service.startThread({
      actor: actorFor(fixture),
      subject: { type: 'CONTENT_ITEM', contentItemId: fixture.contentItemId },
      body: 'both of you',
      mentionedUserIds: [fixture.userId, other.id],
    });

    const otherActor = actorFor(fixture, { userId: other.id });
    expect(await service.unreadMentionCount(actorFor(fixture))).toBe(1);
    expect(await service.unreadMentionCount(otherActor)).toBe(1);

    await service.markMentionsRead({ actor: actorFor(fixture), threadId });

    expect(await service.unreadMentionCount(actorFor(fixture))).toBe(0);
    // The other person has not read anything, and nothing pretended they had.
    expect(await service.unreadMentionCount(otherActor)).toBe(1);
  });

  it('refuses an empty note', async () => {
    const fixture = await freshWorkspace('empty');
    await expect(
      serviceFor(fixture.workspaceId).startThread({
        actor: actorFor(fixture),
        subject: { type: 'CONTENT_ITEM', contentItemId: fixture.contentItemId },
        body: '   ',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('Q12 · a member who may only comment starts and answers threads, and triages nothing', () => {
  /*
   * `content.read` WITHOUT `notes.manage` — the Viewer once it is given read
   * access to content (a later release grants it; the permission model is
   * proven here). Starting a thread and replying to an OPEN one are allowed;
   * everything that changes the state other people see is refused with a
   * FORBIDDEN that names `notes.manage`, and leaves the thread as it was.
   */
  const commenter = (fixture: Fixture): NoteActor =>
    actorFor(fixture, { permissionKeys: ['workspace.read', 'content.read'] });

  async function threadIn(fixture: Fixture): Promise<string> {
    const { threadId } = await serviceFor(fixture.workspaceId).startThread({
      actor: actorFor(fixture),
      subject: { type: 'CONTENT_ITEM', contentItemId: fixture.contentItemId },
      body: 'A thread the team runs',
    });
    return threadId;
  }

  const forbiddenNotesManage = {
    code: 'FORBIDDEN',
    publicDetails: { permission: 'notes.manage' },
  };

  it('may start a thread and reply to an open one', async () => {
    const w = await freshWorkspace('q12-comment');
    const service = serviceFor(w.workspaceId);
    const { threadId } = await service.startThread({
      actor: commenter(w),
      subject: { type: 'CONTENT_ITEM', contentItemId: w.contentItemId },
      body: 'Could the headline be shorter?',
    });
    await service.reply({ actor: commenter(w), threadId, body: 'And the colour warmer.' });
    const notes = await service.notesIn(threadId, commenter(w));
    expect(notes.map((n) => n.body)).toEqual([
      'Could the headline be shorter?',
      'And the colour warmer.',
    ]);
  });

  it('may not assign a thread, even when starting it', async () => {
    const w = await freshWorkspace('q12-assign');
    const service = serviceFor(w.workspaceId);
    await expect(
      service.startThread({
        actor: commenter(w),
        subject: { type: 'CONTENT_ITEM', contentItemId: w.contentItemId },
        body: 'Over to you',
        assignedToUserId: w.userId,
      }),
    ).rejects.toMatchObject(forbiddenNotesManage);
    const threadId = await threadIn(w);
    await expect(
      service.assign({ actor: commenter(w), threadId, assignedToUserId: w.userId }),
    ).rejects.toMatchObject(forbiddenNotesManage);
    const row = await platform.noteThread.findUniqueOrThrow({ where: { id: threadId } });
    expect(row.assignedToUserId).toBeNull();
  });

  it('may not resolve, reopen, set a due date or set importance', async () => {
    const w = await freshWorkspace('q12-triage');
    const service = serviceFor(w.workspaceId);
    const threadId = await threadIn(w);
    const before = await platform.noteThread.findUniqueOrThrow({ where: { id: threadId } });

    await expect(service.resolve({ actor: commenter(w), threadId })).rejects.toMatchObject(
      forbiddenNotesManage,
    );
    await expect(
      service.setDue({ actor: commenter(w), threadId, dueAt: new Date('2026-12-01') }),
    ).rejects.toMatchObject(forbiddenNotesManage);
    await expect(
      service.setImportance({ actor: commenter(w), threadId, importance: 'IMPORTANT' }),
    ).rejects.toMatchObject(forbiddenNotesManage);

    await service.resolve({ actor: actorFor(w), threadId });
    await expect(service.reopen({ actor: commenter(w), threadId })).rejects.toMatchObject(
      forbiddenNotesManage,
    );

    const after = await platform.noteThread.findUniqueOrThrow({ where: { id: threadId } });
    expect(after.status).toBe('RESOLVED');
    expect(after.dueAt).toBe(before.dueAt);
    expect(after.importance).toBe(before.importance);
  });

  it('may not reply to a resolved thread, which would reopen it', async () => {
    const w = await freshWorkspace('q12-resolved');
    const service = serviceFor(w.workspaceId);
    const threadId = await threadIn(w);
    await service.resolve({ actor: actorFor(w), threadId });

    await expect(
      service.reply({ actor: commenter(w), threadId, body: 'One more thing' }),
    ).rejects.toMatchObject(forbiddenNotesManage);
    const row = await platform.noteThread.findUniqueOrThrow({ where: { id: threadId } });
    expect(row.status).toBe('RESOLVED');
    expect(await service.notesIn(threadId, actorFor(w))).toHaveLength(1);
    // Nothing refused was audited as if it had happened.
    const reopened = await platform.auditEvent.count({
      where: { workspaceId: w.workspaceId, action: 'customer.note.reopened' },
    });
    expect(reopened).toBe(0);
  });

  /**
   * A client whose FIRST `noteThread.findFirst` — the reply's own read of the
   * thread — is followed, before the reply goes on, by a resolve committed on
   * another connection. That is the gap between reading the status and writing.
   */
  function resolvedRightAfterRead(fixture: Fixture, threadId: string): NotesService {
    let fired = false;
    const noteThread = new Proxy(platform.noteThread, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver) as unknown;
        if (key !== 'findFirst' || typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const row = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          if (!fired) {
            fired = true;
            await serviceFor(fixture.workspaceId).resolve({ actor: actorFor(fixture), threadId });
          }
          return row;
        };
      },
    });
    const db = new Proxy(platform, {
      get: (target, key, receiver) =>
        key === 'noteThread' ? noteThread : Reflect.get(target, key, receiver),
    });
    return new NotesService({
      db: db as unknown as TenantScopedClient,
      workspaceId: fixture.workspaceId,
      clock: systemClock,
    });
  }

  it('a thread resolved between the read and the write takes no reply from a commenter', async () => {
    const w = await freshWorkspace('q12-race');
    const threadId = await threadIn(w);
    await expect(
      resolvedRightAfterRead(w, threadId).reply({
        actor: commenter(w),
        threadId,
        body: 'Slipped in after it closed',
      }),
    ).rejects.toMatchObject(forbiddenNotesManage);
    const row = await platform.noteThread.findUniqueOrThrow({ where: { id: threadId } });
    expect(row.status).toBe('RESOLVED');
    expect(await serviceFor(w.workspaceId).notesIn(threadId, actorFor(w))).toHaveLength(1);
  });

  it('a manager replying across the same race reopens the thread, and says so', async () => {
    const w = await freshWorkspace('q12-race-manager');
    const threadId = await threadIn(w);
    await resolvedRightAfterRead(w, threadId).reply({
      actor: actorFor(w),
      threadId,
      body: 'Not finished yet',
    });
    const row = await platform.noteThread.findUniqueOrThrow({ where: { id: threadId } });
    expect(row.status).toBe('OPEN');
    const replied = await platform.auditEvent.findFirstOrThrow({
      where: { workspaceId: w.workspaceId, action: 'customer.note.replied' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(replied.after).toMatchObject({ reopened: true });
  });

  it('another workspace’s thread is still a 404, not a FORBIDDEN', async () => {
    const a = await freshWorkspace('q12-cross-a');
    const b = await freshWorkspace('q12-cross-b');
    const threadId = await threadIn(b);
    await expect(
      serviceFor(a.workspaceId).resolve({ actor: commenter(a), threadId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
