import type { KnowledgeValidityPort, LocalCalendarPort } from './due-events';

/**
 * THE PORTS AN AUTOMATION ACTION REACHES THE PRODUCT THROUGH.
 *
 * WHY PORTS AND NOT IMPORTS. An automation acts when nobody is watching, so the
 * question "what can an automation do?" has to be answerable by reading one short
 * list rather than by reasoning about the transitive surface of every package
 * this one could import. Each port below is a single method with a narrow
 * signature; the set of them IS the answer, and it is visible at the wiring site
 * as well as here.
 *
 * It also keeps the dependency graph honest. `@brandspace/automation` imports
 * `shared`, `database`, `config`, `entitlements` and `jobs` — and nothing that
 * can publish, generate or send. A future action that needed one of those would
 * have to add a port, which is a deliberate act a reviewer sees, rather than a
 * new import inside an existing file.
 *
 * This is the pattern the publish pipeline already established with
 * `ApprovalGate`: "a package dependency would have bought the same answer and a
 * cycle risk".
 *
 * EVERY PORT IS OPTIONAL AT THE WIRING SITE. A surface that does not supply one
 * cannot perform that action — the run records `BLOCKED_BY_POLICY` and says so,
 * rather than appearing to succeed.
 */

import type { AutomationNotificationTemplate } from './registry';

export interface NotificationPort {
  /**
   * Notify the members who can act on this.
   *
   * A POINTER, NOT CONTENT. The template key and a small payload of ids and
   * names; never a caption, never a body. Copying content into a notification
   * would route it around the permission checks that apply when somebody follows
   * the link.
   */
  notify(input: {
    readonly workspaceId: string;
    readonly brandId: string;
    /** A closed set (D-412): never a string a rule or a model chose. */
    readonly templateKey: AutomationNotificationTemplate;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly recipients: number }>;
  /**
   * PHASE 2B-3 PR 2 (owner decision D4) — notify ONE member the rule names.
   *
   * The same notice legacy NOTIFY sends — `automation.notice`, fixed here and
   * not a parameter — through the one notification writer, so the member's own
   * mute setting applies. No payload, no rule name, no link: a pointer to the
   * row the event names, exactly as NOTIFY. The engine has already checked that
   * the member is ACTIVE and may see the brand.
   */
  notifyPerson?(input: {
    readonly workspaceId: string;
    readonly brandId: string;
    readonly userId: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly recipients: number }>;
}

export interface ApprovalPort {
  /**
   * PHASE 2B-3 PR 3 — REMIND THE REVIEWERS of a review still waiting, with
   * `approval.reminder` (owner decisions B and C): the assigned reviewer if
   * still eligible, else every eligible reviewer of the brand; the post's
   * title and a link to the review, exactly as `approval.requested`. The
   * engine has already read the review FOR SHARE and found it PENDING.
   */
  remindReviewers?(input: {
    readonly workspaceId: string;
    /** The RULE's brand: a review of any other brand is not this rule's. */
    readonly brandId: string;
    readonly approvalId: string;
    readonly idempotencyKey: string;
  }): Promise<
    | { readonly kind: 'reminded'; readonly recipients: number }
    | { readonly kind: 'refused'; readonly reason: 'occurrence_stale' | 'no_eligible_reviewer' }
  >;
  /** Move an eligible draft into the review queue, as the rule's creator. */
  submitForApproval(input: {
    readonly workspaceId: string;
    readonly contentItemId: string;
    readonly actorUserId: string;
    /**
     * The creator's LIVE permissions, resolved by the engine on this run.
     *
     * PASSED THROUGH RATHER THAN ASSUMED. The approval service performs its own
     * authorization against them, so the port carries the caller's real authority
     * instead of asserting the one permission it happens to need — which would
     * make the port a place where authority is manufactured.
     */
    readonly actorPermissionKeys: readonly string[];
    readonly actorRoleKey: string;
    readonly actorBrandScope: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<{ readonly approvalId: string }>;
}

export interface CalendarPort {
  /** Place an eligible item on the calendar, as the rule's creator. */
  placeOnCalendar(input: {
    readonly workspaceId: string;
    readonly contentItemId: string;
    /** `YYYY-MM-DDTHH:mm`, in the workspace's own zone. */
    readonly localTime: string;
    readonly actorUserId: string;
    readonly actorBrandScope: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<{ readonly slotId: string }>;
  /**
   * PHASE 2B-3 PR 2 — schedule the item in the brand's next free slot, as the
   * rule's creator, under the calendar's own rules and the workspace's
   * calendar-capacity lock. A reason not to schedule comes back as a code;
   * nothing is written for it.
   */
  scheduleNextFreeSlot?(input: {
    readonly workspaceId: string;
    readonly contentItemId: string;
    readonly actorUserId: string;
    readonly actorBrandScope: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<
    | { readonly kind: 'scheduled'; readonly slotId: string; readonly localTime: string }
    | {
        readonly kind: 'refused';
        readonly reason:
          | 'already_has_time'
          | 'no_free_day'
          | 'approval_required'
          | 'schedule_quota_reached'
          | 'channel_disconnected'
          | 'not_schedulable'
          | 'content_unavailable';
      }
  >;
}

/**
 * PHASE 2B-3 PR 2 (owner decision D8) — ADD A POST TO A CAMPAIGN, attach-only.
 *
 * The automation's own precondition comes FIRST, and the campaign service's
 * general `setContentCampaign` is called only when every part of it holds: the
 * post has no campaign, is not waiting for review (a review is never withdrawn
 * by an automation), can still be edited, and the campaign the rule names is
 * still a live campaign of the post's brand. Otherwise a code, and no change.
 */
export interface CampaignPort {
  addToCampaign(input: {
    readonly workspaceId: string;
    readonly contentItemId: string;
    /** The rule's configured campaign — never anything the event names. */
    readonly campaignId: string;
    readonly actorUserId: string;
    readonly actorBrandScope: readonly string[];
    readonly actorPermissionKeys: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<
    | { readonly kind: 'attached' }
    | {
        readonly kind: 'refused';
        readonly reason:
          | 'content_unavailable'
          | 'already_in_campaign'
          | 'content_in_review'
          | 'content_not_editable'
          | 'campaign_unavailable';
      }
  >;
}

/**
 * PHASE 2B-3 PR 2 — MAKE A DRAFT COPY of the post the event names, through the
 * content library's one duplicate path (`duplicateItem`), as the rule's
 * creator: a new draft with its own identity, keeping the source's title, its
 * campaign (D-318) and nothing of its lifecycle. Idempotent on the run.
 */
export interface ContentCopyPort {
  makeDraftCopy(input: {
    readonly workspaceId: string;
    readonly contentItemId: string;
    readonly actorUserId: string;
    readonly actorBrandScope: readonly string[];
    readonly actorPermissionKeys: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<
    | { readonly kind: 'copied'; readonly contentItemId: string }
    | {
        readonly kind: 'refused';
        readonly reason:
          'content_unavailable' | 'source_campaign_unavailable' | 'draft_limit_reached';
      }
  >;
}

export interface PublishPort {
  /**
   * Publish, AFTER a human has confirmed this exact run.
   *
   * The engine calls this from exactly one place — the confirmation path — and
   * never from the trigger path. There is no argument by which an unconfirmed run
   * reaches it, because the code that would pass one does not exist.
   */
  publishNow(input: {
    readonly workspaceId: string;
    readonly brandId: string;
    readonly contentItemId: string;
    readonly actorUserId: string;
    /**
     * THE CONFIRMER'S LIVE BRANDSCOPE (P7-R3).
     *
     * Required, not optional, and for the same reason the Copilot's port
     * requires it: the implementation used to build a calendar with
     * `actorBrandScope: []`, and empty means UNRESTRICTED here — so the literal
     * turned the brand check OFF on the one action that leaves the platform. A
     * required field cannot be forgotten, and an optional one would default to
     * the permissive value.
     */
    readonly actorBrandScope: readonly string[];
    readonly idempotencyKey: string;
  }): Promise<{ readonly jobsCreated: number; readonly slotId: string }>;
}

/** The workspace's IANA zone, so a scheduled rule fires at a local hour. */
export interface TimezonePort {
  timezoneFor(workspaceId: string): Promise<string>;
}

/**
 * PHASE 2B-3 (PR 1) — IS THE WORKSPACE ENTITLED TO THIS FEATURE, NOW?
 *
 * Asked on every run for every key the action declares in `entitlements`, so a
 * plan change takes effect on the next run rather than on the next edit. The
 * implementation is the same `EntitlementService` over `TenantCatalogueSource`
 * the Copilot's gate uses: one answer to "is this plan allowed this".
 *
 * AN ACTION THAT DECLARES AN ENTITLEMENT AND FINDS NO PORT IS REFUSED. Every
 * action that ships today declares none, so for them the port is never asked.
 */
export interface EntitlementPort {
  allows(featureKey: string): Promise<boolean>;
}

export interface AutomationPorts {
  readonly entitlements?: EntitlementPort | undefined;
  readonly notifications?: NotificationPort | undefined;
  readonly approvals?: ApprovalPort | undefined;
  readonly calendar?: CalendarPort | undefined;
  readonly campaigns?: CampaignPort | undefined;
  readonly content?: ContentCopyPort | undefined;
  readonly publishing?: PublishPort | undefined;
  readonly timezone?: TimezonePort | undefined;
  /**
   * Phase 2B-3 PR 3 — local 00:00 on a calendar day, for the delivery re-check
   * of the timed G13 events. Absent, an event that needs it fails closed.
   */
  readonly calendarDays?: LocalCalendarPort | undefined;
  /**
   * Phase 2B-3 PR 3 — Brand Brain's usable-fact rule, for the FACT_EXPIRING
   * re-check. Absent, that event fails closed.
   */
  readonly knowledge?: KnowledgeValidityPort | undefined;
}
