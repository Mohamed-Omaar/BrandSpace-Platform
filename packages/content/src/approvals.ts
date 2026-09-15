import {
  writeAuditEvent,
  type Approval,
  type ApprovalStatus,
  type ContentItem,
  type TenantScopedClient,
} from '@brandspace/database';
import { assertBrandInScope, systemClock, type Clock } from '@brandspace/shared';
import {
  alreadyInReview,
  approvalAlreadyDecided,
  approvalNotFound,
  approvalNotPermitted,
  contentItemNotFound,
  noteTooLong,
  notSubmittable,
  reviewCycleLimitReached,
  selfApprovalNotPermitted,
} from './errors';
import type { ContentPolicy } from './policy';

/**
 * Approvals — Phase 5 scope item 6 (docs/PRODUCT.md §5 module 14,
 * docs/DATABASE.md §4.8), and the module that closes the AC-14.6 / D-120 gap.
 *
 * WHAT THIS SERVICE IS FOR, and the invariants that make it safe:
 *
 *   - THERE IS ONE CONTENT LIFECYCLE, NOT TWO. `content_item.status` remains
 *     the source of truth. An `approval` row records a review CYCLE over that
 *     item — who asked, who decided, when, and against which policy — and every
 *     verdict moves the item's own status in the SAME transaction. A second
 *     lifecycle living in the approval table is how a queue and a library come
 *     to disagree about what is approved.
 *
 *   - THE VERDICT IS ENFORCED HERE, NOT IN THE UI. Every entry point takes the
 *     actor's real role and permission keys — never a boolean the caller
 *     computed — and decides for itself. A hidden button is a courtesy; this is
 *     the control.
 *
 *   - SELF-APPROVAL IS DENIED BY DEFAULT (D-122). The author and the requester
 *     are both barred from deciding, unless this brand's policy deliberately
 *     permits it. The policy in force is SNAPSHOTTED onto the row, so relaxing
 *     the rule tomorrow does not rewrite what yesterday's approval meant.
 *
 *   - VIEWER APPROVAL COMES FROM THE BRAND, NOT THE ROLE (D-121, resolving
 *     U-06). `client_viewer` still holds `workspace.read` and nothing else. The
 *     right is granted per brand and applies to that brand only, so no other
 *     Viewer anywhere gains anything.
 *
 *   - EVERY DECISION IS AUDITED — `content.review_requested`,
 *     `content.approved`, `content.changes_requested`, `content.rejected`,
 *     `content.review_cancelled` — carrying the verdict and the item, never the
 *     caption.
 */

/** The rules in force for one brand, after configuration and overrides. */
export interface ResolvedApprovalPolicy {
  requireApprovalBeforeScheduling: boolean;
  allowSelfApproval: boolean;
  clientApprovalEnabled: boolean;
}

/** Who is acting, as the SERVER knows them. */
export interface ApprovalActor {
  userId: string;
  roleKey: string;
  permissionKeys: readonly string[];
  brandScope: readonly string[];
}

/** A verdict a reviewer may return. */
export type ApprovalVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT';

export interface ApprovalWithItem extends Approval {
  item: Pick<ContentItem, 'id' | 'title' | 'status' | 'brandId' | 'createdByUserId'> | null;
}

/** Told when a review changes hands, so somebody is informed. */
export interface ApprovalNotifier {
  approvalRequested(input: {
    approvalId: string;
    itemId: string;
    itemTitle: string;
    brandId: string;
    requestedByUserId: string;
    assignedToUserId: string | null;
  }): Promise<void>;
  approvalDecided(input: {
    approvalId: string;
    itemId: string;
    itemTitle: string;
    brandId: string;
    verdict: ApprovalVerdict;
    decidedByUserId: string;
    notifyUserId: string;
  }): Promise<void>;
}

export interface ApprovalOptions {
  db: TenantScopedClient;
  workspaceId: string;
  policy: ContentPolicy;
  /** Optional: absent in tests that assert the transitions alone. */
  notifier?: ApprovalNotifier;
  /**
   * AC-15.6 — where a DENIED attempt gets recorded.
   *
   * IT CANNOT BE THIS SERVICE'S OWN TRANSACTION, and that is the whole reason
   * this hook exists. Every caller reaches this service inside `withWorkspace`,
   * which is one transaction; a refusal throws, the transaction rolls back, and
   * an audit row written just before the throw rolls back with it. A denial
   * that cannot be recorded is exactly the event a detection signal is for
   * (docs/SECURITY.md §7), so the write has to happen on a SEPARATE connection.
   *
   * The caller supplies that, because the caller is what owns connections. When
   * it is absent the service still writes the row on its own client — correct
   * for a caller that is not inside a transaction, and harmlessly discarded for
   * one that is.
   */
  denialSink?: DenialSink;
  clock?: Clock;
}

/** Records a refusal outside the transaction the refusal aborts. See above. */
export interface DenialSink {
  (event: {
    approvalId: string;
    brandId: string;
    actorUserId: string;
    reason: string;
  }): Promise<void>;
}

/**
 * D-121 / D-122 — may this actor decide a review for this brand?
 *
 * EXPORTED because the UI needs the same answer to decide what to render, and
 * two implementations of one rule is how a screen and a service come to
 * disagree. The screen asks so it can hide a button; the service asks so it can
 * refuse. Only the second is the control.
 */
export function mayApproveForBrand(input: {
  roleKey: string;
  permissionKeys: readonly string[];
  policy: ResolvedApprovalPolicy;
}): boolean {
  if (input.permissionKeys.includes('content.approve')) return true;
  /*
   * The ONLY lift the per-brand switch performs, and it is deliberately
   * hard-coded to one role key rather than "any role without the permission":
   * a future role that happens to lack `content.approve` must not silently
   * inherit approval rights from a customer's brand setting.
   */
  return input.roleKey === 'client_viewer' && input.policy.clientApprovalEnabled;
}

export class ContentApprovalService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: ContentPolicy;
  readonly #notifier: ApprovalNotifier | undefined;
  readonly #denialSink: DenialSink | undefined;
  readonly #clock: Clock;

  constructor(options: ApprovalOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#notifier = options.notifier;
    this.#denialSink = options.denialSink;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * The rules for one brand: the activated defaults, with any column the brand
   * deliberately set taking precedence.
   *
   * A NULL COLUMN IS NOT `false`. It means "no opinion", so a default the owner
   * changes still reaches every brand that never chose otherwise — which is why
   * `approval_policy` exists as a sparse override table rather than a row per
   * brand written at creation time.
   */
  async policyForBrand(brandId: string): Promise<ResolvedApprovalPolicy> {
    const defaults = this.#policy.approvals;
    const row = await this.#db.approvalPolicy.findFirst({
      where: { workspaceId: this.#workspaceId, brandId },
    });
    return {
      requireApprovalBeforeScheduling:
        row?.requireApprovalBeforeScheduling ?? defaults.requireApprovalBeforeScheduling,
      allowSelfApproval: row?.allowSelfApproval ?? defaults.allowSelfApproval,
      clientApprovalEnabled: row?.clientApprovalEnabled ?? defaults.clientApprovalEnabled,
    };
  }

  /** Change a brand's policy. Gated on `approvals.policy.manage` by the caller. */
  async setPolicyForBrand(input: {
    brandId: string;
    actorUserId: string;
    actorBrandScope: readonly string[];
    patch: Partial<ResolvedApprovalPolicy>;
  }): Promise<ResolvedApprovalPolicy> {
    assertBrandInScope(input.actorBrandScope, input.brandId);
    const before = await this.policyForBrand(input.brandId);

    const existing = await this.#db.approvalPolicy.findFirst({
      where: { workspaceId: this.#workspaceId, brandId: input.brandId },
      select: { id: true },
    });
    const data = {
      ...(input.patch.requireApprovalBeforeScheduling === undefined
        ? {}
        : { requireApprovalBeforeScheduling: input.patch.requireApprovalBeforeScheduling }),
      ...(input.patch.allowSelfApproval === undefined
        ? {}
        : { allowSelfApproval: input.patch.allowSelfApproval }),
      ...(input.patch.clientApprovalEnabled === undefined
        ? {}
        : { clientApprovalEnabled: input.patch.clientApprovalEnabled }),
      updatedByUserId: input.actorUserId,
    };
    if (existing) {
      await this.#db.approvalPolicy.update({ where: { id: existing.id }, data });
    } else {
      await this.#db.approvalPolicy.create({
        data: { workspaceId: this.#workspaceId, brandId: input.brandId, ...data },
      });
    }

    const after = await this.policyForBrand(input.brandId);
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'content.approval_policy_changed',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'ApprovalPolicy',
      resourceId: input.brandId,
      brandId: input.brandId,
      severity: 'NOTICE',
      before: { ...before },
      after: { ...after },
    });
    return after;
  }

  /**
   * Submit content for review. DRAFT or CHANGES_REQUESTED → IN_REVIEW.
   *
   * ARCHIVED AND SCHEDULED ARE NOT SUBMITTABLE, for the same reason
   * `ContentLibraryService.transition()` refuses to move a scheduled item: a
   * live plan must not be able to slide back into a queue underneath itself.
   */
  async submit(input: {
    itemId: string;
    actor: ApprovalActor;
    assignedToUserId?: string | null;
    note?: string | null;
  }): Promise<Approval> {
    const note = this.#checkNote(input.note);
    const item = await this.#db.contentItem.findUnique({ where: { id: input.itemId } });
    if (!item || item.deletedAt) throw contentItemNotFound();
    assertBrandInScope(input.actor.brandScope, item.brandId);

    if (item.status !== 'DRAFT' && item.status !== 'CHANGES_REQUESTED') {
      throw item.status === 'IN_REVIEW' ? alreadyInReview() : notSubmittable();
    }

    const priorCycles = await this.#db.approval.count({
      where: { workspaceId: this.#workspaceId, contentItemId: item.id },
    });
    if (priorCycles >= this.#policy.approvals.maxCyclesPerItem) throw reviewCycleLimitReached();

    const policy = await this.policyForBrand(item.brandId);

    /*
     * THE ROW AND THE ITEM'S STATUS MOVE TOGETHER, and they already do: every
     * caller reaches this service inside `withWorkspace`, which binds the tenant
     * GUC with `set_config(..., true)` — transaction-local — so the whole
     * callback IS one transaction. That is also why `TenantScopedClient` has no
     * `$transaction` to call. Ordering still matters: the approval is written
     * first, so a failure leaves the item a plain draft rather than an item in a
     * queue with nothing behind it.
     */
    const approval = await this.#db.approval.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: item.brandId,
        subjectType: 'CONTENT_ITEM',
        contentItemId: item.id,
        requestedByUserId: input.actor.userId,
        assignedToUserId: input.assignedToUserId ?? null,
        status: 'PENDING',
        requestNote: note,
        cycle: priorCycles + 1,
        policySnapshot: { ...policy },
      },
    });
    await this.#db.contentItem.update({ where: { id: item.id }, data: { status: 'IN_REVIEW' } });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'content.review_requested',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'Approval',
      resourceId: approval.id,
      brandId: item.brandId,
      after: {
        contentItemId: item.id,
        cycle: approval.cycle,
        assigned: approval.assignedToUserId !== null,
        hasNote: note !== null,
      },
    });

    await this.#notifier?.approvalRequested({
      approvalId: approval.id,
      itemId: item.id,
      itemTitle: item.title,
      brandId: item.brandId,
      requestedByUserId: input.actor.userId,
      assignedToUserId: approval.assignedToUserId,
    });

    return approval;
  }

  /**
   * Decide an open review.
   *
   *   APPROVE          → item APPROVED           (schedulable)
   *   REQUEST_CHANGES  → item CHANGES_REQUESTED  (editable, resubmittable)
   *   REJECT           → item DRAFT              (editable, cycle closed)
   *
   * BOTH REFUSALS RETURN THE ITEM TO AN EDITABLE STATE, which is the point:
   * content that has been turned down and cannot be worked on is content the
   * workflow has trapped. The difference between them is the RECORD — "fix
   * these points" and "no, not this" are different things to have said, and the
   * history keeps them apart.
   */
  async decide(input: {
    approvalId: string;
    verdict: ApprovalVerdict;
    actor: ApprovalActor;
    note?: string | null;
  }): Promise<Approval> {
    const note = this.#checkNote(input.note);
    const approval = await this.#db.approval.findUnique({ where: { id: input.approvalId } });
    if (!approval) throw approvalNotFound();
    assertBrandInScope(input.actor.brandScope, approval.brandId);
    if (approval.status !== 'PENDING') throw approvalAlreadyDecided();

    const policy = await this.policyForBrand(approval.brandId);
    if (
      !mayApproveForBrand({
        roleKey: input.actor.roleKey,
        permissionKeys: input.actor.permissionKeys,
        policy,
      })
    ) {
      await this.#auditDenied(input.actor.userId, approval, 'not_permitted');
      throw approvalNotPermitted();
    }

    const item = approval.contentItemId
      ? await this.#db.contentItem.findUnique({ where: { id: approval.contentItemId } })
      : null;
    if (!item || item.deletedAt) throw contentItemNotFound();

    /*
     * D-122. BOTH the author and the requester are barred, not just one: an
     * author who asks a colleague to submit on their behalf would otherwise
     * approve their own words, and a requester who did not write it has still
     * already expressed the view that it is ready.
     */
    const isSelf =
      approval.requestedByUserId === input.actor.userId ||
      item.createdByUserId === input.actor.userId;
    if (isSelf && !policy.allowSelfApproval) {
      await this.#auditDenied(input.actor.userId, approval, 'self_approval');
      throw selfApprovalNotPermitted();
    }

    const nextApproval: ApprovalStatus =
      input.verdict === 'APPROVE'
        ? 'APPROVED'
        : input.verdict === 'REQUEST_CHANGES'
          ? 'CHANGES_REQUESTED'
          : 'REJECTED';
    const nextItem =
      input.verdict === 'APPROVE'
        ? 'APPROVED'
        : input.verdict === 'REQUEST_CHANGES'
          ? 'CHANGES_REQUESTED'
          : 'DRAFT';

    const now = this.#clock.now();
    // One transaction, as in `submit()` — see the note there.
    const decided = await this.#db.approval.update({
      where: { id: approval.id },
      data: {
        status: nextApproval,
        decidedByUserId: input.actor.userId,
        decidedAt: now,
        decisionNote: note,
      },
    });
    await this.#db.contentItem.update({ where: { id: item.id }, data: { status: nextItem } });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action:
        input.verdict === 'APPROVE'
          ? 'content.approved'
          : input.verdict === 'REQUEST_CHANGES'
            ? 'content.changes_requested'
            : 'content.rejected',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'Approval',
      resourceId: approval.id,
      brandId: approval.brandId,
      severity: 'NOTICE',
      before: { approvalStatus: 'PENDING', itemStatus: item.status },
      after: {
        approvalStatus: nextApproval,
        itemStatus: nextItem,
        cycle: approval.cycle,
        selfApproval: isSelf,
        hasNote: note !== null,
      },
    });

    await this.#notifier?.approvalDecided({
      approvalId: approval.id,
      itemId: item.id,
      itemTitle: item.title,
      brandId: approval.brandId,
      verdict: input.verdict,
      decidedByUserId: input.actor.userId,
      notifyUserId: approval.requestedByUserId,
    });

    return decided;
  }

  /**
   * Withdraw an open review, returning the item to a draft.
   *
   * The requester may always do this; so may anyone who could have decided it.
   * A member who can neither is refused — otherwise "cancel" would be an
   * unaudited way to clear someone else's queue.
   */
  async cancel(input: {
    approvalId: string;
    actor: ApprovalActor;
    note?: string | null;
  }): Promise<Approval> {
    const note = this.#checkNote(input.note);
    const approval = await this.#db.approval.findUnique({ where: { id: input.approvalId } });
    if (!approval) throw approvalNotFound();
    assertBrandInScope(input.actor.brandScope, approval.brandId);
    if (approval.status !== 'PENDING') throw approvalAlreadyDecided();

    const policy = await this.policyForBrand(approval.brandId);
    const mayCancel =
      approval.requestedByUserId === input.actor.userId ||
      mayApproveForBrand({
        roleKey: input.actor.roleKey,
        permissionKeys: input.actor.permissionKeys,
        policy,
      });
    if (!mayCancel) {
      await this.#auditDenied(input.actor.userId, approval, 'not_permitted');
      throw approvalNotPermitted();
    }

    const cancelled = await this.#db.approval.update({
      where: { id: approval.id },
      data: { status: 'CANCELLED', decisionNote: note },
    });
    if (approval.contentItemId) {
      const current = await this.#db.contentItem.findUnique({
        where: { id: approval.contentItemId },
        select: { id: true, status: true },
      });
      /*
       * Only an item still IN_REVIEW is returned to DRAFT. If something else has
       * already moved it on, withdrawing a stale request must not drag it
       * backwards out of the state it now legitimately holds.
       */
      if (current?.status === 'IN_REVIEW') {
        await this.#db.contentItem.update({ where: { id: current.id }, data: { status: 'DRAFT' } });
      }
    }

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'content.review_cancelled',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'Approval',
      resourceId: approval.id,
      brandId: approval.brandId,
      before: { approvalStatus: 'PENDING' },
      after: { approvalStatus: 'CANCELLED', cycle: approval.cycle },
    });
    return cancelled;
  }

  /**
   * The review queue: everything still waiting, newest first.
   *
   * BRAND-SCOPED AT THE QUERY, not filtered afterwards. A queue that fetched
   * the workspace and then dropped rows in JavaScript would leak a count, and a
   * count of another brand's pending work is exactly the sort of inference
   * CLAUDE.md §2.1 forbids.
   */
  async queue(input: {
    brandScope: readonly string[];
    assignedToUserId?: string;
    take?: number;
  }): Promise<ApprovalWithItem[]> {
    return this.#db.approval.findMany({
      where: {
        workspaceId: this.#workspaceId,
        status: 'PENDING',
        brandId: { in: [...input.brandScope] },
        ...(input.assignedToUserId ? { assignedToUserId: input.assignedToUserId } : {}),
      },
      include: {
        item: {
          select: { id: true, title: true, status: true, brandId: true, createdByUserId: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(input.take ?? 50, 200),
    });
  }

  /** How many reviews are open in the caller's brands. For the Command Center. */
  async pendingCount(brandScope: readonly string[]): Promise<number> {
    if (brandScope.length === 0) return 0;
    return this.#db.approval.count({
      where: {
        workspaceId: this.#workspaceId,
        status: 'PENDING',
        brandId: { in: [...brandScope] },
      },
    });
  }

  /** Every cycle this item has been through, oldest first. The history. */
  async historyForItem(input: {
    itemId: string;
    brandScope: readonly string[];
  }): Promise<Approval[]> {
    const item = await this.#db.contentItem.findUnique({
      where: { id: input.itemId },
      select: { id: true, brandId: true, deletedAt: true },
    });
    if (!item || item.deletedAt) throw contentItemNotFound();
    assertBrandInScope(input.brandScope, item.brandId);
    return this.#db.approval.findMany({
      where: { workspaceId: this.#workspaceId, contentItemId: item.id },
      orderBy: { cycle: 'asc' },
    });
  }

  /** The open review for one item, when there is one. */
  async openForItem(itemId: string): Promise<Approval | null> {
    return this.#db.approval.findFirst({
      where: { workspaceId: this.#workspaceId, contentItemId: itemId, status: 'PENDING' },
    });
  }

  #checkNote(note: string | null | undefined): string | null {
    if (note === null || note === undefined) return null;
    const trimmed = note.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > this.#policy.approvals.maxNoteLength) throw noteTooLong();
    return trimmed;
  }

  /**
   * AC-15.6 — a denied attempt is audited, with its reason and no payload.
   *
   * Through `denialSink` when the caller supplied one, because this method is
   * always called immediately before a throw and the throw rolls this
   * transaction back. See `ApprovalOptions.denialSink`.
   */
  async #auditDenied(actorUserId: string, approval: Approval, reason: string): Promise<void> {
    if (this.#denialSink) {
      // A denial that cannot be recorded is still a denial: the refusal must
      // not become a 500 because the audit connection was unavailable.
      await this.#denialSink({
        approvalId: approval.id,
        brandId: approval.brandId,
        actorUserId,
        reason,
      }).catch(() => undefined);
      return;
    }
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'content.approval_denied',
      actorType: 'USER',
      actorId: actorUserId,
      resourceType: 'Approval',
      resourceId: approval.id,
      brandId: approval.brandId,
      severity: 'WARNING',
      outcome: 'DENIED',
      reason,
    });
  }
}
