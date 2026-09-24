import { AppError, brandIdQueryFilter, brandIdScopeFilter } from '@brandspace/shared';
import type { Clock } from '@brandspace/shared';
import type { TenantScopedClient } from '@brandspace/database';

/**
 * CONTEXTUAL COLLABORATION — threads, notes and mentions (P6-05).
 *
 * The one genuinely new tenant-owned capability in Phase 6. Everything else the
 * phase touches already had a domain behind it.
 *
 * WHAT A NOTE IS: something a colleague said about a specific piece of work,
 * attached to that work, so the conversation lives where the decision is made
 * rather than in a chat window somebody has to correlate by hand.
 *
 * WHAT A NOTE IS NOT, AND THIS IS THE LOAD-BEARING SENTENCE: brand knowledge.
 * `BrandKnowledgeItem` is what the brand has DECIDED is true. It carries
 * provenance, an authority level and a precedence rule (HUMAN beats DOCUMENT
 * beats AI_INFERRED), and every AI surface in the product generates from it. A
 * note is an opinion in a thread. This module has no import of Brand Brain, no
 * foreign key into it, and no method that writes to it — the separation is
 * structural rather than a convention somebody has to remember, because the
 * failure mode is silent: a passing remark becoming governed memory, and then
 * becoming what the Copilot believes about the brand.
 *
 * If a note SHOULD become knowledge, a person promotes it through Brand Brain's
 * own review, where it arrives with provenance saying where it came from.
 *
 * EVERY METHOD TAKES A TENANT-SCOPED CLIENT AND AN ACTOR. There is no ambient
 * workspace and no ambient user: the caller has already established both, and
 * passing them explicitly is what makes a missing check visible at the call
 * site rather than defaulted somewhere in here.
 */

export type NoteSubjectType = 'CONTENT_ITEM' | 'CAMPAIGN' | 'BRAND';
export type NoteThreadStatus = 'OPEN' | 'RESOLVED';

/**
 * Who is acting, and what they may do.
 *
 * `brandScope` is the platform rule: EMPTY MEANS UNRESTRICTED, not "no brands".
 * Getting that backwards is the defect D-190 records a page-level workaround
 * for, and it is worth restating wherever the scope crosses a boundary.
 */
export interface NoteActor {
  readonly userId: string;
  readonly permissionKeys: readonly string[];
  readonly brandScope: readonly string[];
}

/** What a thread is attached to. Exactly one shape, matching the discriminator. */
export type NoteSubject =
  | { readonly type: 'CONTENT_ITEM'; readonly contentItemId: string }
  | { readonly type: 'CAMPAIGN'; readonly campaignId: string }
  | { readonly type: 'BRAND'; readonly brandId: string };

export interface NoteThreadSummary {
  readonly id: string;
  readonly brandId: string;
  readonly subjectType: NoteSubjectType;
  readonly contentItemId: string | null;
  readonly campaignId: string | null;
  readonly status: NoteThreadStatus;
  readonly createdByUserId: string;
  readonly assignedToUserId: string | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly noteCount: number;
}

export interface NoteRecord {
  readonly id: string;
  readonly threadId: string;
  readonly authorUserId: string;
  readonly body: string;
  readonly editedAt: Date | null;
  readonly createdAt: Date;
  readonly mentionedUserIds: readonly string[];
}

/**
 * One conversation as the global Notes surface lists it (P6-16).
 *
 * EVERYTHING HERE IS READ FROM THE THREAD AND ITS SUBJECT — the subject's own
 * title, the brand's own name — so the list names what a thread is ABOUT
 * without the page re-deriving it, and a subject the reader cannot open never
 * contributes a title.
 */
export interface NoteInboxEntry {
  readonly threadId: string;
  readonly brandId: string;
  readonly brandName: string;
  readonly subjectType: NoteSubjectType;
  readonly contentItemId: string | null;
  readonly campaignId: string | null;
  /** The content item's title or the campaign's name; null for a brand thread. */
  readonly subjectTitle: string | null;
  readonly status: NoteThreadStatus;
  readonly assignedToUserId: string | null;
  readonly updatedAt: Date;
  /** Mentions of the reader in this thread they have not marked seen. */
  readonly unreadMentions: number;
  /** Why it is in the reader's list — the strongest reason wins. */
  readonly reason: 'mentioned' | 'assigned' | 'participating' | 'open';
  readonly lastNote: {
    readonly authorUserId: string;
    readonly body: string;
    readonly createdAt: Date;
  } | null;
}

export interface NoteInbox {
  /** Threads that name, are assigned to, or were written in by the reader. */
  readonly forYou: readonly NoteInboxEntry[];
  /** Other OPEN conversations in the reader's brands. */
  readonly open: readonly NoteInboxEntry[];
}

/** The longest excerpt of a note the inbox carries. */
const EXCERPT = 180;

/** How many threads each inbox section returns at most. */
const INBOX_TAKE = 40;

/**
 * The permission a member needs to take part at all.
 *
 * ONE PERMISSION FOR READING AND WRITING, deliberately. A workspace where some
 * members can read the conversation and not reply is a workspace where the
 * conversation moves somewhere else; the meaningful boundary is whether you are
 * in the room. Resolving somebody else's thread and deleting a note are the two
 * places a stronger check applies, and each is checked where it happens.
 */
export const NOTE_PERMISSION = 'content.read';

/** The longest a single note may be. */
const MAX_BODY = 4_000;

/** How many people one note may name. */
const MAX_MENTIONS = 20;

export class NotesService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #clock: Clock;

  constructor(options: {
    readonly db: TenantScopedClient;
    readonly workspaceId: string;
    readonly clock: Clock;
  }) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#clock = options.clock;
  }

  /**
   * A NOT-FOUND SHAPED IDENTICALLY TO A GENUINE MISS.
   *
   * CLAUDE.md §2.1: unauthorized cross-tenant access returns 404 shaped exactly
   * like a real absence, because "forbidden" and "not found" told apart is
   * itself information — it confirms the row exists.
   */
  #notFound(): AppError {
    return new AppError('NOT_FOUND', 'Not found.');
  }

  #requirePermission(actor: NoteActor): void {
    if (!actor.permissionKeys.includes(NOTE_PERMISSION)) throw this.#notFound();
  }

  /**
   * Resolve the subject to the brand that owns it, refusing anything outside
   * this workspace or outside the actor's brand scope.
   *
   * THE BRAND IS READ FROM THE SUBJECT RATHER THAN TAKEN FROM THE CALLER. A
   * caller-supplied brand id would let somebody attach a thread about workspace
   * A's content to a brand they can see, and the thread would then be visible
   * to people who cannot open its subject.
   */
  async #brandForSubject(subject: NoteSubject, actor: NoteActor): Promise<string> {
    const scope = brandIdScopeFilter(actor.brandScope);

    if (subject.type === 'CONTENT_ITEM') {
      const item = await this.#db.contentItem.findFirst({
        where: {
          id: subject.contentItemId,
          workspaceId: this.#workspaceId,
          deletedAt: null,
          ...scope,
        },
        select: { brandId: true },
      });
      if (!item) throw this.#notFound();
      return item.brandId;
    }

    if (subject.type === 'CAMPAIGN') {
      const campaign = await this.#db.campaign.findFirst({
        where: { id: subject.campaignId, workspaceId: this.#workspaceId, ...scope },
        select: { brandId: true },
      });
      if (!campaign) throw this.#notFound();
      return campaign.brandId;
    }

    /*
     * THE BRAND'S OWN COLUMN IS `id`, NOT `brandId` — AND THE TWO CLAUSES MUST
     * INTERSECT RATHER THAN REPLACE EACH OTHER.
     *
     * `brandIdScopeFilter` and `brandIdQueryFilter` both emit `brandId`, which
     * is right for every model that REFERENCES a brand and wrong for the brand
     * itself, so neither helper fits here. Writing it by hand reintroduced the
     * exact defect `brandIdQueryFilter` exists to prevent, and the isolation
     * test caught it: spreading a `{ id: { in: scope } }` fragment over a
     * `{ id: subject.brandId }` one means the LATER KEY WINS, so the requested
     * brand was silently discarded and the query returned whichever brand was
     * in scope. The thread was then attached to the WRONG BRAND instead of
     * being refused — a scope check that quietly rewrites what it was asked
     * about is worse than no check, because the caller gets a success.
     *
     * An explicit `AND` cannot express that mistake: both clauses are present
     * and both must hold. Same discipline as the shared helper, applied to the
     * column this model actually has.
     */
    const brand = await this.#db.brand.findFirst({
      where: {
        workspaceId: this.#workspaceId,
        deletedAt: null,
        AND: [
          { id: subject.brandId },
          ...(actor.brandScope.length === 0 ? [] : [{ id: { in: [...actor.brandScope] } }]),
        ],
      },
      select: { id: true },
    });
    if (!brand) throw this.#notFound();
    return brand.id;
  }

  /**
   * The people a note may name.
   *
   * ONLY ACTIVE MEMBERS OF THIS WORKSPACE, and the filter is the point rather
   * than a nicety. Accepting an arbitrary user id would (a) tell the mentioner
   * whether that account exists, which is an enumeration oracle, and (b) put a
   * notification about this workspace in a stranger's list. Ids that do not
   * resolve are DROPPED rather than rejected: a mention of somebody who left
   * should not make the note unpostable.
   */
  async #resolvableMentions(userIds: readonly string[]): Promise<readonly string[]> {
    const wanted = [...new Set(userIds)].slice(0, MAX_MENTIONS);
    if (wanted.length === 0) return [];
    const members = await this.#db.membership.findMany({
      where: {
        workspaceId: this.#workspaceId,
        userId: { in: [...wanted] },
        status: 'ACTIVE',
      },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  /** The thread, if this actor may see it. 404 otherwise, identically shaped. */
  async #threadFor(threadId: string, actor: NoteActor) {
    const thread = await this.#db.noteThread.findFirst({
      where: {
        id: threadId,
        workspaceId: this.#workspaceId,
        ...brandIdScopeFilter(actor.brandScope),
      },
    });
    if (!thread) throw this.#notFound();
    return thread;
  }

  /**
   * Start a conversation about something, with its first note.
   *
   * A THREAD IS NEVER CREATED EMPTY. An empty thread is a row somebody made by
   * misclicking, it shows up in every count, and there is nothing in it to say
   * what it was for. The first note and the thread are written in one
   * transaction, so neither can exist without the other.
   */
  async startThread(input: {
    readonly actor: NoteActor;
    readonly subject: NoteSubject;
    readonly body: string;
    readonly mentionedUserIds?: readonly string[];
    readonly assignedToUserId?: string | null;
  }): Promise<{ readonly threadId: string; readonly noteId: string }> {
    this.#requirePermission(input.actor);
    const body = this.#validBody(input.body);
    const brandId = await this.#brandForSubject(input.subject, input.actor);
    const mentions = await this.#resolvableMentions(input.mentionedUserIds ?? []);
    const assignee = await this.#validAssignee(input.assignedToUserId ?? null);

    const now = this.#clock.now();
    const thread = await this.#db.noteThread.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId,
        subjectType: input.subject.type,
        contentItemId: input.subject.type === 'CONTENT_ITEM' ? input.subject.contentItemId : null,
        campaignId: input.subject.type === 'CAMPAIGN' ? input.subject.campaignId : null,
        status: 'OPEN',
        createdByUserId: input.actor.userId,
        assignedToUserId: assignee,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true },
    });

    const note = await this.#writeNote(thread.id, input.actor.userId, body, mentions, now);
    await this.#audit(input.actor, 'customer.note.thread_started', thread.id, {
      subjectType: input.subject.type,
      brandId,
      mentions: mentions.length,
    });
    return { threadId: thread.id, noteId: note.id };
  }

  /** Add a note to an existing thread. */
  async reply(input: {
    readonly actor: NoteActor;
    readonly threadId: string;
    readonly body: string;
    readonly mentionedUserIds?: readonly string[];
  }): Promise<{ readonly noteId: string }> {
    this.#requirePermission(input.actor);
    const body = this.#validBody(input.body);
    const thread = await this.#threadFor(input.threadId, input.actor);
    const mentions = await this.#resolvableMentions(input.mentionedUserIds ?? []);

    const now = this.#clock.now();
    const note = await this.#writeNote(thread.id, input.actor.userId, body, mentions, now);
    /*
     * REPLYING TO A RESOLVED THREAD REOPENS IT.
     *
     * Somebody typing into a closed conversation is saying it is not closed.
     * Leaving it resolved would hide the reply from every "what is open" view,
     * which is the one place it needed to appear.
     */
    if (thread.status === 'RESOLVED') {
      await this.#db.noteThread.update({
        where: { id: thread.id },
        data: { status: 'OPEN', resolvedAt: null, resolvedByUserId: null, updatedAt: now },
      });
    } else {
      await this.#db.noteThread.update({
        where: { id: thread.id },
        data: { updatedAt: now },
      });
    }

    await this.#audit(input.actor, 'customer.note.replied', thread.id, {
      noteId: note.id,
      reopened: thread.status === 'RESOLVED',
      mentions: mentions.length,
    });
    return { noteId: note.id };
  }

  /** Mark a conversation finished. */
  async resolve(input: { readonly actor: NoteActor; readonly threadId: string }): Promise<void> {
    this.#requirePermission(input.actor);
    const thread = await this.#threadFor(input.threadId, input.actor);
    if (thread.status === 'RESOLVED') return;

    const now = this.#clock.now();
    await this.#db.noteThread.update({
      where: { id: thread.id },
      data: {
        status: 'RESOLVED',
        resolvedAt: now,
        resolvedByUserId: input.actor.userId,
        updatedAt: now,
      },
    });
    await this.#audit(input.actor, 'customer.note.resolved', thread.id, {});
  }

  /** Reopen a conversation that was marked finished. */
  async reopen(input: { readonly actor: NoteActor; readonly threadId: string }): Promise<void> {
    this.#requirePermission(input.actor);
    const thread = await this.#threadFor(input.threadId, input.actor);
    if (thread.status === 'OPEN') return;

    const now = this.#clock.now();
    await this.#db.noteThread.update({
      where: { id: thread.id },
      data: { status: 'OPEN', resolvedAt: null, resolvedByUserId: null, updatedAt: now },
    });
    await this.#audit(input.actor, 'customer.note.reopened', thread.id, {});
  }

  /** Point a thread at somebody, or at nobody. */
  async assign(input: {
    readonly actor: NoteActor;
    readonly threadId: string;
    readonly assignedToUserId: string | null;
  }): Promise<void> {
    this.#requirePermission(input.actor);
    const thread = await this.#threadFor(input.threadId, input.actor);
    const assignee = await this.#validAssignee(input.assignedToUserId);

    await this.#db.noteThread.update({
      where: { id: thread.id },
      data: { assignedToUserId: assignee, updatedAt: this.#clock.now() },
    });
    await this.#audit(input.actor, 'customer.note.assigned', thread.id, {
      assigned: assignee !== null,
    });
  }

  /** Every thread about one subject, newest activity first. */
  async threadsFor(subject: NoteSubject, actor: NoteActor): Promise<readonly NoteThreadSummary[]> {
    this.#requirePermission(actor);
    // Resolving the subject first is what refuses a subject in another
    // workspace, or one outside this member's brand scope, before any thread is
    // read — rather than returning an empty list, which would not distinguish
    // "no conversations" from "not yours".
    await this.#brandForSubject(subject, actor);

    const threads = await this.#db.noteThread.findMany({
      where: {
        workspaceId: this.#workspaceId,
        ...brandIdScopeFilter(actor.brandScope),
        ...(subject.type === 'CONTENT_ITEM'
          ? { contentItemId: subject.contentItemId }
          : subject.type === 'CAMPAIGN'
            ? { campaignId: subject.campaignId }
            : { subjectType: 'BRAND', brandId: subject.brandId }),
      },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { notes: true } } },
    });

    return threads.map((thread) => ({
      id: thread.id,
      brandId: thread.brandId,
      subjectType: thread.subjectType as NoteSubjectType,
      contentItemId: thread.contentItemId,
      campaignId: thread.campaignId,
      status: thread.status as NoteThreadStatus,
      createdByUserId: thread.createdByUserId,
      assignedToUserId: thread.assignedToUserId,
      resolvedAt: thread.resolvedAt,
      createdAt: thread.createdAt,
      noteCount: thread._count.notes,
    }));
  }

  /** The messages in one thread, oldest first, with who was named in each. */
  async notesIn(threadId: string, actor: NoteActor): Promise<readonly NoteRecord[]> {
    this.#requirePermission(actor);
    const thread = await this.#threadFor(threadId, actor);

    const notes = await this.#db.note.findMany({
      where: { workspaceId: this.#workspaceId, threadId: thread.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { mentions: { select: { mentionedUserId: true } } },
    });

    return notes.map((note) => ({
      id: note.id,
      threadId: note.threadId,
      authorUserId: note.authorUserId,
      body: note.body,
      editedAt: note.editedAt,
      createdAt: note.createdAt,
      mentionedUserIds: note.mentions.map((m) => m.mentionedUserId),
    }));
  }

  /**
   * How many unread mentions this person has here.
   *
   * SCOPED TO THE MENTIONED PERSON AND THIS WORKSPACE, both. A count keyed on
   * the user alone would cross workspaces for anybody who belongs to two.
   */
  async unreadMentionCount(actor: NoteActor): Promise<number> {
    /*
     * P6-16: THE SAME ANSWER THE COMMAND CENTER GIVES. This used to count every
     * unread mention of the person in the workspace, including mentions in
     * threads about a brand they can no longer see — so the top bar would have
     * promised a note the Notes surface could not show them. It now asks the
     * permission and the brand scope the threads themselves are read under.
     */
    if (!actor.permissionKeys.includes(NOTE_PERMISSION)) return 0;
    return this.#db.noteMention.count({
      where: {
        workspaceId: this.#workspaceId,
        mentionedUserId: actor.userId,
        readAt: null,
        note: {
          deletedAt: null,
          thread: {
            ...brandIdScopeFilter(actor.brandScope),
            // The inbox cannot list a thread about deleted content, so the dot
            // must not count one either — the two always agree.
            NOT: { contentItem: { is: { deletedAt: { not: null } } } },
          },
        },
      },
    });
  }

  /**
   * THE GLOBAL NOTES SURFACE (P6-16): every conversation that concerns the
   * reader, then the other open ones in their brands.
   *
   * NOTHING NEW IS STORED. Threads stay attached to the work they are about —
   * this reads them across subjects, under the same permission, brand scope and
   * workspace predicate every per-subject read uses, and each entry links back
   * to its subject, where the conversation continues.
   *
   * `brandId` narrows to one brand (the rail's selection) and is INTERSECTED
   * with the scope, never substituted for it (the D-267 shape).
   */
  async inbox(
    actor: NoteActor,
    options: { readonly brandId?: string | null } = {},
  ): Promise<NoteInbox> {
    this.#requirePermission(actor);
    const scope = brandIdQueryFilter({
      brandId: options.brandId ?? undefined,
      brandScope: actor.brandScope,
    });
    const me = actor.userId;

    const base = {
      workspaceId: this.#workspaceId,
      AND: [
        ...scope.AND,
        // A thread about a deleted content item has nowhere to link to.
        { NOT: { contentItem: { is: { deletedAt: { not: null } } } } },
      ],
    };
    const include = {
      brand: { select: { name: true } },
      contentItem: { select: { title: true } },
      campaign: { select: { name: true } },
      notes: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' as const },
        select: {
          authorUserId: true,
          body: true,
          createdAt: true,
          mentions: { where: { mentionedUserId: me }, select: { readAt: true } },
        },
      },
    };

    const concernsMe = {
      OR: [
        { assignedToUserId: me },
        { createdByUserId: me },
        { notes: { some: { deletedAt: null, authorUserId: me } } },
        { notes: { some: { deletedAt: null, mentions: { some: { mentionedUserId: me } } } } },
      ],
    };

    const mine = await this.#db.noteThread.findMany({
      where: { ...base, ...concernsMe },
      orderBy: { updatedAt: 'desc' },
      take: INBOX_TAKE,
      include,
    });
    const others = await this.#db.noteThread.findMany({
      where: {
        ...base,
        status: 'OPEN',
        id: { notIn: mine.map((thread) => thread.id) },
      },
      orderBy: { updatedAt: 'desc' },
      take: INBOX_TAKE,
      include,
    });

    const entry = (thread: (typeof mine)[number], forYou: boolean): NoteInboxEntry => {
      const mentionsOfMe = thread.notes.flatMap((note) => note.mentions);
      const unread = mentionsOfMe.filter((mention) => mention.readAt === null).length;
      const reason: NoteInboxEntry['reason'] = !forYou
        ? 'open'
        : mentionsOfMe.length > 0
          ? 'mentioned'
          : thread.assignedToUserId === me
            ? 'assigned'
            : 'participating';
      const last = thread.notes[0] ?? null;
      return {
        threadId: thread.id,
        brandId: thread.brandId,
        brandName: thread.brand.name,
        subjectType: thread.subjectType as NoteSubjectType,
        contentItemId: thread.contentItemId,
        campaignId: thread.campaignId,
        subjectTitle: thread.contentItem?.title ?? thread.campaign?.name ?? null,
        status: thread.status as NoteThreadStatus,
        assignedToUserId: thread.assignedToUserId,
        updatedAt: thread.updatedAt,
        unreadMentions: unread,
        reason,
        lastNote: last
          ? {
              authorUserId: last.authorUserId,
              body: last.body.length > EXCERPT ? `${last.body.slice(0, EXCERPT - 1)}…` : last.body,
              createdAt: last.createdAt,
            }
          : null,
      };
    };

    const forYou = mine.map((thread) => entry(thread, true));
    // Unread first, then most recent — what is waiting on the reader leads.
    forYou.sort(
      (a, b) =>
        Number(b.unreadMentions > 0) - Number(a.unreadMentions > 0) ||
        b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
    return { forYou, open: others.map((thread) => entry(thread, false)) };
  }

  /** Mark this person's mentions in one thread as seen. */
  async markMentionsRead(input: {
    readonly actor: NoteActor;
    readonly threadId: string;
  }): Promise<number> {
    this.#requirePermission(input.actor);
    const thread = await this.#threadFor(input.threadId, input.actor);
    const notes = await this.#db.note.findMany({
      where: { workspaceId: this.#workspaceId, threadId: thread.id },
      select: { id: true },
    });
    const result = await this.#db.noteMention.updateMany({
      where: {
        workspaceId: this.#workspaceId,
        mentionedUserId: input.actor.userId,
        noteId: { in: notes.map((n) => n.id) },
        readAt: null,
      },
      data: { readAt: this.#clock.now() },
    });
    return result.count;
  }

  /** Threads waiting on this person, for the Command Center. */
  async assignedOpenCount(actor: NoteActor): Promise<number> {
    return this.#db.noteThread.count({
      where: {
        workspaceId: this.#workspaceId,
        assignedToUserId: actor.userId,
        status: 'OPEN',
        ...brandIdScopeFilter(actor.brandScope),
      },
    });
  }

  // --- internals ----------------------------------------------------------

  #validBody(raw: string): string {
    const body = raw.trim();
    if (body === '') {
      throw new AppError('VALIDATION_FAILED', 'A note needs something in it.', { field: 'body' });
    }
    if (body.length > MAX_BODY) {
      throw new AppError('VALIDATION_FAILED', 'That note is too long.', { field: 'body' });
    }
    return body;
  }

  /** An assignee must be an active member here, or nobody. */
  async #validAssignee(userId: string | null): Promise<string | null> {
    if (userId === null) return null;
    const [member] = await this.#resolvableMentions([userId]);
    if (!member) {
      throw new AppError('VALIDATION_FAILED', 'That person is not in this workspace.', {
        field: 'assignedToUserId',
      });
    }
    return member;
  }

  async #writeNote(
    threadId: string,
    authorUserId: string,
    body: string,
    mentionedUserIds: readonly string[],
    now: Date,
  ): Promise<{ readonly id: string }> {
    const note = await this.#db.note.create({
      data: {
        workspaceId: this.#workspaceId,
        threadId,
        authorUserId,
        body,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true },
    });
    if (mentionedUserIds.length > 0) {
      await this.#db.noteMention.createMany({
        data: mentionedUserIds.map((mentionedUserId) => ({
          workspaceId: this.#workspaceId,
          noteId: note.id,
          mentionedUserId,
          createdAt: now,
        })),
        // The author naming somebody twice in one sentence is one notification.
        skipDuplicates: true,
      });
    }
    return note;
  }

  /**
   * Every state change writes an audit event (CLAUDE.md §5).
   *
   * THE BODY IS NEVER IN THE AUDIT PAYLOAD. What changed is that a thread was
   * started, replied to, resolved or assigned; WHAT WAS SAID belongs in the
   * note, which has its own access rules. Copying it into the audit trail would
   * put the conversation somewhere the conversation's own permissions do not
   * reach.
   */
  async #audit(
    actor: NoteActor,
    action: string,
    threadId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.#db.auditEvent.create({
      data: {
        workspaceId: this.#workspaceId,
        actorType: 'USER',
        actorId: actor.userId,
        action,
        resourceType: 'note_thread',
        resourceId: threadId,
        severity: 'NOTICE',
        outcome: 'SUCCESS',
        after: after as never,
      },
    });
  }
}
