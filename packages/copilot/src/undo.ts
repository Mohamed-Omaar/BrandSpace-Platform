import {
  writeAuditEvent,
  type CopilotActionPlan,
  type CopilotToolCall,
  type TenantScopedClient,
} from '@brandspace/database';
import type {
  CampaignService,
  ContentCalendarService,
  ContentLibraryService,
} from '@brandspace/content';
import { brandIdQueryFilter, systemClock, type Clock } from '@brandspace/shared';
import { copilotPlanNotFound, undoUnsafe, undoWindowClosed } from './errors';
import type { LiveAuthorization } from './authorization';
import { resolveLiveAuthorization, holds } from './authorization';
import { findTool } from './tools';

/**
 * UNDO — EXPLICIT COMPENSATION CONTRACTS, NOT "RUN THE OPPOSITE COMMAND".
 *
 * THE DIFFERENCE MATTERS, AND IT IS THE WHOLE FILE. "The opposite command" is
 * what a naive undo does: it deletes what was created and reschedules what was
 * moved, without asking whether anything happened in between. But something
 * usually did. A colleague submitted the draft for review. A manager rescheduled
 * the slot. Somebody renamed the campaign. An undo that steamrolls any of those
 * is not a restoration — it is a SECOND, SILENT CHANGE, made on the authority of
 * a button that promised the opposite.
 *
 * So every compensation carries what to restore AND WHAT THE WORLD LOOKED LIKE
 * WHEN THE PROMISE WAS MADE: a version number, a status, an instant. Each one is
 * re-checked here, and a mismatch is REFUSED WITH A REASON rather than forced.
 * The customer is told their campaign changed since the assistant touched it, and
 * nothing is destroyed.
 *
 * AND SOME THINGS ARE NOT UNDOABLE AT ALL. A post that has reached a platform is
 * on that platform; people may have seen it. `publishing.publish_now` declares
 * `undoable: false` in the registry, produces no compensation, and this service
 * never offers one for it. Never claim an undo where the external system cannot
 * guarantee one — that is the one promise this design must not make.
 *
 * UNDO IS ITSELF AUTHORIZED, at undo time, against the LIVE membership. A person
 * who has lost the permission that let the step happen may not reverse it either;
 * a compensation is a mutation, and it obeys the same rules the mutation did.
 */

export type CompensationKind =
  'campaign.archive' | 'campaign.restore_values' | 'content.archive' | 'calendar.cancel';

export interface UndoServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly clock?: Clock;
}

export interface UndoCollaborators {
  readonly campaigns: CampaignService;
  readonly calendar: ContentCalendarService;
  /**
   * The content domain's own archive. REQUIRED, not optional (P7-R4): the
   * compensation used to reach past the domain with raw Prisma, and an optional
   * collaborator would let the next surface do it again.
   */
  readonly library: ContentLibraryService;
}

export interface UndoOutcome {
  readonly plan: CopilotActionPlan;
  readonly undone: readonly { ordinal: number; toolKey: string }[];
  readonly refused: readonly { ordinal: number; toolKey: string; reason: string }[];
}

export class CopilotUndoService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #clock: Clock;

  constructor(options: UndoServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Undo everything a plan did that can still be undone safely.
   *
   * IN REVERSE ORDER, which is not cosmetic. The plan created a campaign, then a
   * draft inside it, then a calendar slot for that draft. Undoing forwards would
   * try to archive the campaign while its content still pointed at it and its
   * slot was still live; undoing backwards takes the outermost change off first,
   * so each compensation sees the state its own precondition was written against.
   *
   * PARTIAL IS A REAL OUTCOME. Some steps undo and some refuse, and the result
   * says which — because "we undid two of your three changes, and here is why the
   * third stayed" is the truth, and a single boolean would have to lie either way.
   */
  async undo(input: {
    planId: string;
    userId: string;
    collaborators: UndoCollaborators;
  }): Promise<UndoOutcome> {
    const plan = await this.#db.copilotActionPlan.findFirst({
      where: { id: input.planId, workspaceId: this.#workspaceId, userId: input.userId },
    });
    if (!plan) throw copilotPlanNotFound();

    if (plan.undoStatus === 'UNDONE') return { plan, undone: [], refused: [] };
    if (plan.undoStatus === 'NOT_APPLICABLE') throw undoUnsafe('nothing_to_undo');
    if (plan.undoExpiresAt && plan.undoExpiresAt < this.#clock.now()) {
      await this.#db.copilotActionPlan.update({
        where: { id: plan.id },
        data: { undoStatus: 'EXPIRED' },
      });
      throw undoWindowClosed();
    }

    // THE LIVE MEMBERSHIP AGAIN. An undo is a mutation and is authorized like one.
    const authorization = await resolveLiveAuthorization(this.#db, this.#workspaceId, input.userId);
    if (!authorization) throw copilotPlanNotFound();

    const calls = await this.#db.copilotToolCall.findMany({
      where: { workspaceId: this.#workspaceId, planId: plan.id, status: 'SUCCEEDED' },
      orderBy: { ordinal: 'desc' },
    });

    const undone: { ordinal: number; toolKey: string }[] = [];
    const refused: { ordinal: number; toolKey: string; reason: string }[] = [];

    for (const call of calls) {
      const tool = findTool(call.toolKey);
      if (!tool?.undoable || call.compensation === null) continue;

      if (!holds(authorization, tool.permission)) {
        refused.push({ ordinal: call.ordinal, toolKey: call.toolKey, reason: 'permission_denied' });
        continue;
      }

      const reason = await this.#compensate(call, plan, authorization, input.collaborators);
      if (reason === null) {
        await this.#db.copilotToolCall.update({
          where: { id: call.id },
          data: { status: 'UNDONE', finishedAt: this.#clock.now() },
        });
        undone.push({ ordinal: call.ordinal, toolKey: call.toolKey });
      } else {
        refused.push({ ordinal: call.ordinal, toolKey: call.toolKey, reason });
      }
    }

    const status =
      refused.length === 0 && undone.length > 0
        ? 'UNDONE'
        : undone.length > 0
          ? 'PARTIALLY_UNDONE'
          : 'REFUSED';

    const updated = await this.#db.copilotActionPlan.update({
      where: { id: plan.id },
      data: {
        undoStatus: status,
        undoneAt: this.#clock.now(),
        undoneByUserId: input.userId,
        // A MACHINE CODE THE UI TRANSLATES, so the refusal is explained in the
        // reader's own language rather than in whichever one the code was written
        // in.
        undoRefusedCode: refused[0]?.reason ?? null,
      },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'copilot.plan_undone',
      actorType: 'USER',
      actorId: input.userId,
      resourceType: 'CopilotActionPlan',
      resourceId: plan.id,
      ...(plan.brandId ? { brandId: plan.brandId } : {}),
      traceId: plan.correlationId,
      outcome: refused.length > 0 ? 'ERROR' : 'SUCCESS',
      after: {
        undone: undone.length,
        refused: refused.length,
        refusedReasons: [...new Set(refused.map((r) => r.reason))].join(','),
        undoStatus: status,
      },
    });

    return { plan: updated, undone, refused };
  }

  /**
   * Run one compensation, or return the machine code for why it was refused.
   *
   * NULL MEANS DONE. Every other return is a reason a person can be shown.
   */
  async #compensate(
    call: CopilotToolCall,
    plan: CopilotActionPlan,
    authorization: LiveAuthorization,
    collaborators: UndoCollaborators,
  ): Promise<string | null> {
    const contract = call.compensation as Record<string, unknown> | null;
    if (!contract) return 'no_contract';

    const actor = { userId: authorization.userId, brandScope: authorization.brandScope };

    /*
     * THE PREDICATE EVERY PRECONDITION READ CARRIES (P7-R4).
     *
     * Two things at once, and both were missing:
     *
     *   - THE LIVE SCOPE. Undo is re-authorized against the membership as it is
     *     NOW, and an administrator who narrowed somebody's BrandScope after a
     *     plan ran expects that to close the undo button too. Reading the target
     *     by `{ id, workspaceId }` meant it did not.
     *   - THE PLAN'S OWN BRAND. A compensation contract is stored JSON on a row;
     *     binding the target id to the brand the plan ran against means a
     *     contract naming some other brand's resource finds nothing.
     *
     * An out-of-scope target therefore reads as `already_gone` — the same
     * machine code a genuinely missing one produces, so the refusal reason
     * cannot be used to probe for ids (CLAUDE.md §2.1).
     */
    const scoped = brandIdQueryFilter({
      brandId: plan.brandId ?? undefined,
      brandScope: authorization.brandScope,
    });

    switch (contract['kind'] as CompensationKind) {
      case 'campaign.archive': {
        const campaignId = String(contract['campaignId']);
        const expectedVersion = Number(contract['expectedVersion']);
        const campaign = await this.#db.campaign.findFirst({
          where: { id: campaignId, workspaceId: this.#workspaceId, ...scoped },
          select: { version: true, deletedAt: true },
        });
        if (!campaign) return 'already_gone';
        if (campaign.deletedAt) return null; // Already archived; nothing to do.
        // SOMEBODY EDITED IT. Archiving now would discard their edit along with
        // the assistant's change.
        if (campaign.version !== expectedVersion) return 'changed_since';

        if (contract['requireNoContent'] === true) {
          const attached = await this.#db.contentItem.count({
            where: { workspaceId: this.#workspaceId, campaignId, deletedAt: null, ...scoped },
          });
          // CONTENT WAS FILED UNDER IT. Archiving would take somebody's work out
          // of view along with an empty shell nobody minded.
          if (attached > 0) return 'campaign_has_content';
        }

        await collaborators.campaigns.archive({ campaignId, actor });
        return null;
      }

      case 'campaign.restore_values': {
        const campaignId = String(contract['campaignId']);
        const expectedVersion = Number(contract['expectedVersion']);
        const previous = (contract['previous'] ?? {}) as Record<string, unknown>;
        const campaign = await this.#db.campaign.findFirst({
          where: { id: campaignId, workspaceId: this.#workspaceId, ...scoped },
          select: { version: true },
        });
        if (!campaign) return 'already_gone';
        if (campaign.version !== expectedVersion) return 'changed_since';

        await collaborators.campaigns.update({
          campaignId,
          expectedVersion,
          ...(previous['name'] === undefined ? {} : { name: String(previous['name']) }),
          ...(previous['status'] === undefined ? {} : { status: previous['status'] as never }),
          actor,
          reason: 'copilot_undo',
        });
        return null;
      }

      case 'content.archive': {
        /*
         * THROUGH THE CONTENT DOMAIN, NOT PAST IT. `archiveItem` carries the
         * BrandScope and the plan's brand into BOTH the read and a conditional
         * write, and audits the change with the brand it actually touched. This
         * service no longer knows how to archive a content item, which is the
         * point: a rule enforced in one place cannot be forgotten in a second.
         *
         * IT LEFT THE UNDO-SAFE STATE — a draft since submitted, approved or
         * scheduled is part of somebody else's workflow now, and archiving it
         * out from under them is not an undo.
         */
        const outcome = await collaborators.library.archiveItem({
          contentItemId: String(contract['contentItemId']),
          brandId: plan.brandId,
          brandScope: authorization.brandScope,
          actorUserId: authorization.userId,
          requireStatusIn: (contract['requireStatusIn'] as string[] | undefined) ?? ['DRAFT'],
          reason: 'copilot_undo',
          now: this.#clock.now(),
        });
        switch (outcome.outcome) {
          case 'ARCHIVED':
          case 'ALREADY_ARCHIVED':
            return null;
          case 'NOT_FOUND':
            return 'already_gone';
          default:
            return 'content_no_longer_draft';
        }
      }

      case 'calendar.cancel': {
        const slotId = String(contract['slotId']);
        const allowed = (contract['requireStatusIn'] as string[] | undefined) ?? ['SCHEDULED'];
        const expectedAt = contract['expectedScheduledAtUtc'];
        const slot = await this.#db.calendarSlot.findFirst({
          where: { id: slotId, workspaceId: this.#workspaceId, ...scoped },
          select: { status: true, scheduledAtUtc: true },
        });
        if (!slot) return 'already_gone';
        if (slot.status === 'CANCELLED') return null;
        // ALREADY PUBLISHING OR PUBLISHED. Past this point an undo is not a
        // restoration — the external effect has begun.
        if (!allowed.includes(slot.status)) return 'slot_no_longer_scheduled';
        if (typeof expectedAt === 'string' && slot.scheduledAtUtc.toISOString() !== expectedAt) {
          // SOMEBODY MOVED IT. Cancelling now would discard their decision.
          return 'slot_rescheduled';
        }

        await collaborators.calendar.cancel({
          slotId,
          actorUserId: authorization.userId,
          actorBrandScope: authorization.brandScope,
        });
        return null;
      }

      default:
        return 'unknown_contract';
    }
  }
}
