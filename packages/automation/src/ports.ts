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
    readonly templateKey: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly recipients: number }>;
}

export interface ApprovalPort {
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
    readonly idempotencyKey: string;
  }): Promise<{ readonly jobsCreated: number; readonly slotId: string }>;
}

/** The workspace's IANA zone, so a scheduled rule fires at a local hour. */
export interface TimezonePort {
  timezoneFor(workspaceId: string): Promise<string>;
}

export interface AutomationPorts {
  readonly notifications?: NotificationPort | undefined;
  readonly approvals?: ApprovalPort | undefined;
  readonly calendar?: CalendarPort | undefined;
  readonly publishing?: PublishPort | undefined;
  readonly timezone?: TimezonePort | undefined;
}
