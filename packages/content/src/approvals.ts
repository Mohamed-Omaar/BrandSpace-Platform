import {
  recordAutomationEvent,
  writeAuditEvent,
  type Approval,
  type ApprovalStatus,
  type ContentItem,
  type TenantScopedClient,
} from '@brandspace/database';
import {
  assertBrandInScope,
  brandIdQueryFilter,
  brandIdScopeFilter,
  brandInScope,
  systemClock,
  type Clock,
} from '@brandspace/shared';
import {
  alreadyInReview,
  approvalAlreadyDecided,
  approvalNotFound,
  approvalNotPermitted,
  assigneeNotEligible,
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
 *   - APPROVAL AUTHORITY IS `content.approve`, AND NOTHING ELSE (D-62).
 *     D-121 briefly let a BRAND grant it to `client_viewer`; the MVP has no
 *     Client Portal or external reviewer surface for such a grant to belong
 *     to, so Viewer is strictly read-only and `mayApproveForBrand` accepts
 *     neither a role key nor a policy. The idea is deferred to a future
 *     External Review / Guest Approval capability with its own actor.
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
  /**
   * RESERVED AND INERT — D-62 supersedes D-121 for the MVP.
   *
   * Nothing reads this to decide anything. `mayApproveForBrand` cannot even
   * see it: approval authority is `content.approve` and nothing else, so a
   * Viewer is strictly read-only whatever this says. It is not patchable
   * through `setPolicyForBrand`, no screen renders it, and a CHECK constraint
   * pins the column to false or NULL.
   *
   * KEPT rather than dropped because it is part of the policy record a cycle
   * snapshots, and because a future **External Review / Guest Approval**
   * capability is expected to want a per-brand switch of this shape. That
   * capability will be a distinct narrow actor, NOT a repurposing of
   * `client_viewer`. Until it exists this field is structure, not behaviour —
   * the same treatment `ApprovalSubjectType.CAMPAIGN` and the undeliverable
   * `NotificationChannel` values already get.
   */
  clientApprovalEnabled: boolean;
}

/**
 * THE PART OF A POLICY THAT DECIDES ANYTHING.
 *
 * `ResolvedApprovalPolicy` is the whole stored record, including the reserved
 * and inert `clientApprovalEnabled`. This is the subset a verdict is actually
 * judged against — so a field that governs nothing cannot drift into a
 * decision path by being carried alongside ones that do.
 */
export type EffectiveApprovalPolicy = Pick<
  ResolvedApprovalPolicy,
  'requireApprovalBeforeScheduling' | 'allowSelfApproval'
>;

/**
 * THE POLICY A CYCLE IS JUDGED BY IS THE ONE IT WAS OPENED UNDER (D-126).
 *
 * `policySnapshot` was being written and then ignored: `decide()` re-read the
 * brand's CURRENT policy, so flipping `allowSelfApproval` on would retroactively
 * permit a self-approval on a cycle somebody submitted expecting review — and
 * the row would still carry the snapshot saying it had not been allowed. The
 * snapshot is the record of what the requester was promised, so it is what the
 * verdict is judged against.
 *
 * WHAT STAYS CURRENT: membership, role and permissions. A member removed from
 * the workspace, or moved out of the brand, must not still be able to decide a
 * cycle opened while they could. Only the WORKFLOW POLICY for the cycle is
 * historical; who you are is always read fresh.
 *
 * An unreadable or absent snapshot falls back to the current policy — a cycle
 * predating this column, or one whose JSON a future migration reshapes, must
 * still be decidable rather than permanently stuck.
 *
 * EXPORTED because the screen must reach the same verdict as the server. The
 * approvals page was computing its buttons from the brand's LIVE policy while
 * `decide()` judged the cycle by its snapshot, so flipping `allowSelfApproval`
 * on offered an Approve button for an already-open cycle that the server would
 * then refuse. A screen that offers a verdict the server rejects is worse than
 * one that withholds it: the reader learns the rule only by being denied.
 */
export function policyFromSnapshot(
  snapshot: unknown,
  current: EffectiveApprovalPolicy,
): EffectiveApprovalPolicy {
  if (snapshot === null || typeof snapshot !== 'object') return current;
  const raw = snapshot as Record<string, unknown>;
  const bool = (key: keyof EffectiveApprovalPolicy): boolean =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : current[key];
  return {
    // The scheduling gate is NOT taken from the snapshot: it governs the
    // calendar, not this decision, and the calendar reads it live so a brand
    // that turns the gate on protects content already in flight.
    requireApprovalBeforeScheduling: current.requireApprovalBeforeScheduling,
    allowSelfApproval: bool('allowSelfApproval'),
  };
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

/** What a reviewer is shown in order to decide, and the whole of it. */
export interface ReviewSubject {
  approvalId: string;
  itemId: string;
  itemTitle: string;
  brandId: string;
  brandName: string;
  itemStatus: ContentItem['status'];
  status: ApprovalStatus;
  cycle: number;
  requestNote: string | null;
  requestedByUserId: string;
  assignedToUserId: string | null;
  mayDecide: boolean;
  variants: readonly {
    id: string;
    platformKey: string;
    locale: string;
    body: string;
    hashtags: readonly string[];
    /** PHASE 8 — the media the reviewer is approving (AC-29.1). */
    assetIds: readonly string[];
  }[];
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
    /*
     * THE RECIPIENTS ARE RESOLVED BY THE SERVICE, not by the notifier.
     *
     * The first version had the dashboard adapter list everyone holding
     * `content.approve` and send to all of them — which ignored membership
     * status and BrandScope entirely, so a member restricted to Brand A was
     * told the TITLE of content in Brand B, and a member whose membership had
     * been suspended kept receiving it. A notification is a disclosure: it says
     * that content exists, in that brand, awaiting review. Who may receive one
     * is an authorization question, and it belongs where the other
     * authorization lives.
     */
    recipientUserIds: readonly string[];
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
 * May this actor decide a review? **D-62: the permission, and nothing else.**
 *
 * THE SIGNATURE IS THE GUARANTEE. This took a `roleKey` and a
 * `ResolvedApprovalPolicy` so that D-121's per-brand switch could lift
 * `client_viewer` to a reviewer. D-62 makes Viewer strictly read-only for the
 * MVP, so the switch is gone — and rather than leave the parameters in place
 * and ignore them, they are REMOVED. A rule that cannot see a role key or a
 * brand setting cannot be talked into honouring one, by this release or by an
 * accidental reintroduction in a later one.
 *
 * Approval authority is therefore exactly `content.approve`, granted by a role,
 * and a customer's brand configuration cannot widen it.
 *
 * EXPORTED because the UI needs the same answer to decide what to render, and
 * two implementations of one rule is how a screen and a service come to
 * disagree. The screen asks so it can hide a button; the service asks so it can
 * refuse. Only the second is the control.
 */
export function mayApproveForBrand(input: { permissionKeys: readonly string[] }): boolean {
  return input.permissionKeys.includes('content.approve');
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

  /**
   * Change a brand's policy. Gated on `approvals.policy.manage` by the caller.
   *
   * `clientApprovalEnabled` IS NOT PATCHABLE, and the type says so rather than
   * the body silently dropping it. Under D-62 the Viewer is strictly read-only,
   * so there is no switch for a customer to throw; `Omit` makes an attempt to
   * throw one a compile error rather than a write that appears to succeed and
   * changes nothing. The database pins the column too — see
   * `20260915223000_phase_5b_3_withdraw_viewer_approval`.
   */
  async setPolicyForBrand(input: {
    brandId: string;
    actorUserId: string;
    actorBrandScope: readonly string[];
    patch: Partial<Omit<ResolvedApprovalPolicy, 'clientApprovalEnabled'>>;
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
    // D-132: the scope is a PREDICATE. An out-of-scope item is never read.
    const item = await this.#db.contentItem.findFirst({
      where: {
        id: input.itemId,
        ...brandIdQueryFilter({ brandScope: input.actor.brandScope }),
      },
    });
    if (!item || item.deletedAt) throw contentItemNotFound();

    if (item.status !== 'DRAFT' && item.status !== 'CHANGES_REQUESTED') {
      throw item.status === 'IN_REVIEW' ? alreadyInReview() : notSubmittable();
    }

    const priorCycles = await this.#db.approval.count({
      where: { workspaceId: this.#workspaceId, contentItemId: item.id },
    });
    if (priorCycles >= this.#policy.approvals.maxCyclesPerItem) throw reviewCycleLimitReached();

    const policy = await this.policyForBrand(item.brandId);

    /*
     * AN ASSIGNMENT IS VALIDATED BEFORE IT IS PERSISTED.
     *
     * It was previously written straight from the form: any uuid at all became
     * the assignee, including a member of another brand, a suspended member, or
     * somebody with no review authority — and `decide()` then ignored the field
     * entirely, so the screen said a review was assigned to a person who could
     * never act on it. Assignment is real now (see `decide()`), so it has to
     * name somebody who can actually decide.
     *
     * The refusal is NOT_FOUND-shaped: confirming that a given uuid is a member
     * of this workspace, or is scoped to this brand, would answer a question the
     * requester has not been granted (CLAUDE.md §2.1).
     */
    const assignedToUserId = input.assignedToUserId ?? null;
    if (assignedToUserId !== null) {
      const eligible = await this.mayUserReview({
        userId: assignedToUserId,
        brandId: item.brandId,
      });
      if (!eligible) throw assigneeNotEligible();
    }

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

    /*
     * AN ASSIGNED REVIEW GOES TO THAT PERSON ALONE; an unassigned one goes to
     * everyone who could pick it up — minus the requester, who knows. Both
     * lists come from `eligibleReviewers`, so the notification cannot reach
     * somebody who may not act on it or may not see the brand.
     */
    const recipientUserIds = approval.assignedToUserId
      ? [approval.assignedToUserId]
      : await this.eligibleReviewers({
          brandId: item.brandId,
          excludeUserId: input.actor.userId,
        });

    await this.#notifier?.approvalRequested({
      approvalId: approval.id,
      itemId: item.id,
      itemTitle: item.title,
      brandId: item.brandId,
      requestedByUserId: input.actor.userId,
      assignedToUserId: approval.assignedToUserId,
      recipientUserIds,
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

    /*
     * THE ROW IS LOCKED BEFORE IT IS READ (finding 5).
     *
     * `SELECT … FOR UPDATE` on the approval, so a second verdict on the same
     * cycle BLOCKS here until the first commits and then sees `APPROVED` rather
     * than `PENDING`. The previous read-then-update by id alone let two
     * concurrent reviewers both see `PENDING`, both pass the guard, and both
     * write — last writer winning, the loser's verdict vanishing, and two audit
     * events claiming to have decided the same review. A conditional `updateMany`
     * on `status = 'PENDING'` would close the write race but not the read race:
     * the self-approval and authority checks are made against the row, so they
     * have to be made against a row nobody else can move underneath them.
     *
     * Every caller is already inside `withWorkspace`'s transaction, so the lock
     * is held until that transaction commits — which is what makes the approval
     * write, the item write, the audit event and the notification one unit.
     */
    const locked = await this.#db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "approval"
      WHERE "id" = ${input.approvalId}::uuid AND "workspaceId" = ${this.#workspaceId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) throw approvalNotFound();

    // D-132: scoped in the WHERE. The lock above is by workspace — the brand
    // predicate is what makes the row unreadable to a reviewer scoped elsewhere.
    const approval = await this.#db.approval.findFirst({
      where: {
        id: input.approvalId,
        ...brandIdQueryFilter({ brandScope: input.actor.brandScope }),
      },
    });
    if (!approval) throw approvalNotFound();
    if (approval.status !== 'PENDING') throw approvalAlreadyDecided();

    /*
     * D-126 — THE CYCLE IS JUDGED BY THE POLICY IT WAS OPENED UNDER. The
     * current policy is still read, because `policyFromSnapshot` falls back to
     * it and because the scheduling gate is deliberately live.
     */
    const current = await this.policyForBrand(approval.brandId);
    const policy = policyFromSnapshot(approval.policySnapshot, current);

    // WHO the actor is, however, is always read fresh: `mayApproveForBrand`
    // takes the permissions of the session making THIS request.
    if (!mayApproveForBrand({ permissionKeys: input.actor.permissionKeys })) {
      await this.#auditDenied(input.actor.userId, approval, 'not_permitted');
      throw approvalNotPermitted();
    }

    /*
     * AN ASSIGNED REVIEW IS THAT PERSON'S TO DECIDE. Assignment was recorded
     * and then ignored, which is a misleading half-behaviour: the screen said a
     * review was assigned and anyone who could approve could still decide it.
     */
    if (approval.assignedToUserId && approval.assignedToUserId !== input.actor.userId) {
      await this.#auditDenied(input.actor.userId, approval, 'assigned_to_another');
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
    /*
     * CONDITIONAL ON `PENDING` AS WELL AS LOCKED — belt and braces, and the
     * braces are what a future caller outside a transaction would be left with.
     * `updateMany` returns a count, so a zero says somebody else decided it.
     */
    const moved = await this.#db.approval.updateMany({
      where: { id: approval.id, workspaceId: this.#workspaceId, status: 'PENDING' },
      data: {
        status: nextApproval,
        decidedByUserId: input.actor.userId,
        decidedAt: now,
        decisionNote: note,
      },
    });
    if (moved.count === 0) throw approvalAlreadyDecided();
    const decided = await this.#db.approval.findUniqueOrThrow({ where: { id: approval.id } });
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

    /*
     * THE AUTOMATION EVENT, IN THIS TRANSACTION (A1).
     *
     * `CONTENT_APPROVED` was an authorable trigger with NO PRODUCER: a customer
     * could write the rule, the worker held a complete consumer for it, and
     * nothing in the platform ever connected the two. A rule on the most obvious
     * event in the product simply never fired.
     *
     * A ROW, NOT AN ENQUEUE. It commits with the approval or not at all — so an
     * approval never happens without its event, and an event never exists for an
     * approval that rolled back. Nothing here talks to Redis, so a queue outage
     * cannot fail somebody's approval, and the reconciliation sweep dispatches
     * what is waiting.
     *
     * ONLY ON APPROVAL. `REQUEST_CHANGES` and `REJECT` are not this trigger, and
     * a rule listening for an approval must not fire on a rejection.
     */
    if (input.verdict === 'APPROVE') {
      await recordAutomationEvent(
        this.#db,
        this.#workspaceId,
        { triggerType: 'CONTENT_APPROVED', refType: 'ContentItem' },
        { brandId: approval.brandId, refId: item.id },
      );
    }

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

    // THE SAME LOCK `decide()` TAKES, so a decide/cancel race has one
    // authoritative winner rather than a verdict landing on a withdrawn cycle
    // or a withdrawal erasing a verdict somebody already gave.
    const locked = await this.#db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "approval"
      WHERE "id" = ${input.approvalId}::uuid AND "workspaceId" = ${this.#workspaceId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) throw approvalNotFound();

    // D-132: scoped in the WHERE. The lock above is by workspace — the brand
    // predicate is what makes the row unreadable to a reviewer scoped elsewhere.
    const approval = await this.#db.approval.findFirst({
      where: {
        id: input.approvalId,
        ...brandIdQueryFilter({ brandScope: input.actor.brandScope }),
      },
    });
    if (!approval) throw approvalNotFound();
    if (approval.status !== 'PENDING') throw approvalAlreadyDecided();

    /*
     * WITHDRAWING NEEDS NO POLICY LOOKUP ANY MORE. It once resolved the cycle's
     * snapshot so `mayApproveForBrand` could weigh the brand's D-121 switch;
     * under D-62 approval authority is the permission alone, and the requester
     * may always withdraw their own request.
     */
    const mayCancel =
      approval.requestedByUserId === input.actor.userId ||
      mayApproveForBrand({ permissionKeys: input.actor.permissionKeys });
    if (!mayCancel) {
      await this.#auditDenied(input.actor.userId, approval, 'not_permitted');
      throw approvalNotPermitted();
    }

    const withdrawn = await this.#db.approval.updateMany({
      where: { id: approval.id, workspaceId: this.#workspaceId, status: 'PENDING' },
      data: { status: 'CANCELLED', decisionNote: note },
    });
    if (withdrawn.count === 0) throw approvalAlreadyDecided();
    const cancelled = await this.#db.approval.findUniqueOrThrow({ where: { id: approval.id } });
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
    brandScope: readonly string[] | null | undefined;
    assignedToUserId?: string;
    take?: number;
  }): Promise<ApprovalWithItem[]> {
    return this.#db.approval.findMany({
      where: {
        workspaceId: this.#workspaceId,
        status: 'PENDING',
        // AN EMPTY SCOPE IS UNRESTRICTED — the platform rule `brandInScope()`
        // and `brandScopeFilter()` have carried since Phase 2B. Reading it as
        // "no brands" showed an unrestricted member an empty queue, and made
        // every caller compensate by expanding the scope itself.
        ...brandIdScopeFilter(input.brandScope),
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
  async pendingCount(brandScope: readonly string[] | null | undefined): Promise<number> {
    return this.#db.approval.count({
      where: {
        workspaceId: this.#workspaceId,
        status: 'PENDING',
        ...brandIdScopeFilter(brandScope),
      },
    });
  }

  /**
   * THE REVIEW SUBJECT — the narrowest thing a reviewer needs in order to
   * decide, and nothing else.
   *
   * WHAT IT RETURNS: the title, the brand name, the captions under review, the
   * requester's note and the cycle. WHAT IT DOES NOT: anything else in the
   * library, any other draft, Brand Brain, assets, analytics, settings or
   * billing. A reviewer cannot judge words they cannot see, and they do not
   * need anything beyond the words.
   *
   * ITS ORIGINAL PURPOSE IS GONE, AND IT IS KEPT ON ITS OWN MERITS. This was
   * written to give a D-121 Viewer an authorized read without handing them the
   * library. D-62 makes Viewer strictly read-only, so no such reader exists and
   * the bypass it carried has been removed — `content.read` is now the floor.
   * What remains is a genuinely narrow projection for the reviewer's card,
   * useful to every reviewer, and the shape a future External Review actor
   * would want. It grants nothing on its own.
   *
   * AUTHORIZED PER APPROVAL and scoped to the caller's brands, with a
   * NOT_FOUND-shaped refusal so another brand's review does not betray its
   * existence.
   */
  async reviewSubject(input: { approvalId: string; actor: ApprovalActor }): Promise<ReviewSubject> {
    // D-132: scoped in the WHERE, so another brand's review is never retrieved.
    const approval = await this.#db.approval.findFirst({
      where: {
        id: input.approvalId,
        ...brandIdQueryFilter({ brandScope: input.actor.brandScope }),
      },
    });
    if (!approval) throw approvalNotFound();

    const current = await this.policyForBrand(approval.brandId);
    const policy = policyFromSnapshot(approval.policySnapshot, current);
    const mayReview = mayApproveForBrand({ permissionKeys: input.actor.permissionKeys });
    /*
     * D-62: `content.read` IS THE FLOOR, with no way past it.
     *
     * This once admitted anybody `mayApproveForBrand` admitted, EVEN WITHOUT
     * `content.read`, so that a D-121 Viewer could read the words they were
     * being asked to judge. That was the whole of the Viewer's authorized read,
     * and with the Viewer grant withdrawn it is the one door left that a
     * read-only member could have walked through. It is closed: the subject is
     * content, and seeing content requires the content permission.
     *
     * Refusing with NOT_FOUND rather than FORBIDDEN keeps the existence of
     * another brand's review out of the answer.
     */
    if (!input.actor.permissionKeys.includes('content.read')) {
      throw approvalNotFound();
    }
    if (!approval.contentItemId) throw contentItemNotFound();

    const item = await this.#db.contentItem.findUnique({
      where: { id: approval.contentItemId },
      select: {
        id: true,
        title: true,
        brandId: true,
        status: true,
        deletedAt: true,
        createdByUserId: true,
        brand: { select: { name: true } },
        variants: {
          orderBy: { platformKey: 'asc' },
          select: {
            id: true,
            platformKey: true,
            locale: true,
            body: true,
            hashtags: true,
            assetIds: true,
          },
        },
      },
    });
    if (!item || item.deletedAt) throw contentItemNotFound();

    return {
      approvalId: approval.id,
      itemId: item.id,
      itemTitle: item.title,
      brandId: item.brandId,
      brandName: item.brand.name,
      itemStatus: item.status,
      status: approval.status,
      cycle: approval.cycle,
      requestNote: approval.requestNote,
      requestedByUserId: approval.requestedByUserId,
      assignedToUserId: approval.assignedToUserId,
      /*
       * THE SAME FOUR CONDITIONS `decide()` ENFORCES, not just the first two.
       * `mayReview && PENDING` offered the review card's Approve button to the
       * person who submitted the cycle, and to a reader when the review was
       * assigned to somebody else — in both cases the server then refused. The
       * card must promise only what the verdict will honour.
       */
      mayDecide:
        mayReview &&
        approval.status === 'PENDING' &&
        !(approval.assignedToUserId && approval.assignedToUserId !== input.actor.userId) &&
        !(
          (approval.requestedByUserId === input.actor.userId ||
            item.createdByUserId === input.actor.userId) &&
          !policy.allowSelfApproval
        ),
      variants: item.variants.map((v) => ({
        id: v.id,
        platformKey: v.platformKey,
        locale: v.locale,
        // A purged body (D-116 retention) reads as empty rather than as
        // `null` reaching a template: the reviewer sees that there is nothing
        // to read, which is the honest rendering of content that has expired.
        body: v.body ?? '',
        hashtags: v.hashtags,
        assetIds: v.assetIds,
      })),
    };
  }

  /** Every cycle this item has been through, oldest first. The history. */
  async historyForItem(input: {
    itemId: string;
    brandScope: readonly string[];
  }): Promise<Approval[]> {
    // D-132: scoped in the WHERE.
    const item = await this.#db.contentItem.findFirst({
      where: { id: input.itemId, ...brandIdQueryFilter({ brandScope: input.brandScope }) },
      select: { id: true, brandId: true, deletedAt: true },
    });
    if (!item || item.deletedAt) throw contentItemNotFound();
    return this.#db.approval.findMany({
      where: { workspaceId: this.#workspaceId, contentItemId: item.id },
      orderBy: { cycle: 'asc' },
    });
  }

  /**
   * THE LATEST APPROVAL STATE FOR MANY ITEMS AT ONCE — Phase 8 (AC-29.2).
   *
   * FOR A PLANNING SURFACE, not for a decision. The Calendar shows a month of
   * scheduled posts and a planner has to see, without opening anything, which
   * of them is still waiting on a reviewer. Asking per row would be a query per
   * chip; asking here is one.
   *
   * THE LATEST CYCLE WINS, because a re-submission supersedes the round before
   * it: an item whose cycle 1 was CHANGES_REQUESTED and whose cycle 2 is
   * PENDING is waiting, not rejected.
   *
   * AN ITEM WITH NO ROW IS ABSENT FROM THE MAP, and that is meaningful: it has
   * never been submitted, so its brand does not require approval or nobody has
   * asked yet. The caller renders that as "not required" rather than inventing
   * a state.
   *
   * SCOPED IN THE QUERY (D-132). An out-of-scope item contributes no row, so a
   * member scoped to one brand cannot learn another brand's review state by
   * passing its id.
   */
  async latestForItems(input: {
    itemIds: readonly string[];
    brandScope: readonly string[];
  }): Promise<Map<string, ApprovalStatus>> {
    const ids = [...new Set(input.itemIds)];
    if (ids.length === 0) return new Map();
    const rows = await this.#db.approval.findMany({
      where: {
        workspaceId: this.#workspaceId,
        contentItemId: { in: ids },
        ...brandIdQueryFilter({ brandScope: input.brandScope }),
      },
      orderBy: { cycle: 'asc' },
      select: { contentItemId: true, status: true },
    });
    const latest = new Map<string, ApprovalStatus>();
    // Ascending cycle, so the last write for an id is its highest cycle.
    for (const row of rows) {
      if (row.contentItemId) latest.set(row.contentItemId, row.status);
    }
    return latest;
  }

  /** The open review for one item, when there is one. */
  async openForItem(itemId: string): Promise<Approval | null> {
    return this.#db.approval.findFirst({
      where: { workspaceId: this.#workspaceId, contentItemId: itemId, status: 'PENDING' },
    });
  }

  /**
   * WHO MAY DECIDE A REVIEW FOR THIS BRAND, RIGHT NOW.
   *
   * One implementation, used both to validate an assignment before it is
   * persisted and to address the notification afterwards — because "who may
   * review this" and "who may be told about it" have to be the same answer.
   *
   * Three conditions, all of them checked here rather than assumed:
   *
   *   1. ACTIVE MEMBERSHIP. An invited-but-not-accepted or suspended member is
   *      not a reviewer, however their role reads.
   *   2. BRANDSCOPE, with the platform's own semantics — empty is unrestricted,
   *      non-empty must contain this brand. Skipping it told a member scoped to
   *      one brand the title of another brand's content.
   *   3. APPROVAL AUTHORITY: `content.approve` through the role. Under D-62
   *      that is the whole of it — no brand setting and no role key adds to it,
   *      which is why `mayApproveForBrand` no longer accepts either.
   */
  async eligibleReviewers(input: { brandId: string; excludeUserId?: string }): Promise<string[]> {
    const members = await this.#db.membership.findMany({
      where: { workspaceId: this.#workspaceId, status: 'ACTIVE' },
      select: {
        userId: true,
        brandScope: true,
        role: { select: { key: true, permissions: { select: { permission: true } } } },
      },
    });
    return members
      .filter((m) => m.userId !== input.excludeUserId)
      .filter((m) => brandInScope(m.brandScope, input.brandId))
      .filter((m) =>
        mayApproveForBrand({
          permissionKeys: m.role.permissions.map((rp) => rp.permission.key),
        }),
      )
      .map((m) => m.userId);
  }

  /** Is this ONE member an eligible reviewer for this brand? Same three rules. */
  async mayUserReview(input: { userId: string; brandId: string }): Promise<boolean> {
    const eligible = await this.eligibleReviewers({
      brandId: input.brandId,
    });
    return eligible.includes(input.userId);
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
