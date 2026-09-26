/**
 * The notification catalogue — Phase 5B-3 (docs/PRODUCT.md §5 module 16).
 *
 * A CLOSED SET, not a free-text producer. Every notification this platform can
 * create is named here with the payload it carries and the route it points at,
 * so a reader of this file can answer "what can the product tell me?" without
 * grepping for call sites. A template nobody declared cannot be written.
 *
 * THE RENDERED STRING IS NOT HERE EITHER. `templateKey` and a payload go to the
 * database; the words come from the dashboard's own message catalogue at READ
 * time, in the reader's locale. Storing a rendered sentence would make a
 * bilingual workspace's inbox monolingual in whichever language the ACTOR
 * happened to be using, which is precisely backwards.
 */

export const NOTIFICATION_TEMPLATES = {
  /** Someone asked for this content to be reviewed. Goes to the reviewers. */
  'approval.requested': { severity: 'info' },
  /** A reviewer approved it. Goes to whoever asked. */
  'approval.approved': { severity: 'success' },
  /** A reviewer asked for changes. Goes to whoever asked. */
  'approval.changes_requested': { severity: 'warning' },
  /** A reviewer turned it down. Goes to whoever asked. */
  'approval.rejected': { severity: 'warning' },
  /**
   * B-3 — the post was edited while it waited, so the open review was
   * withdrawn: what the reviewer was asked to judge no longer exists. Goes to
   * the reviewers who were asked. The author sends it again when ready.
   */
  'approval.withdrawn_after_edit': { severity: 'info' },

  /*
   * Phase 6 — Social Publishing.
   *
   * THREE TEMPLATES, NOT ONE PER STATE. A queued post becoming a publishing
   * post is not news; a post that went out, a post that did not, and an account
   * that has stopped working are. Notifying on every transition is how an inbox
   * becomes something people stop reading, and an unread inbox is worse than no
   * inbox for exactly the message that matters.
   */
  /** It went out. Goes to whoever scheduled it. */
  'publishing.published': { severity: 'success' },
  /** It did not, and will not without a person. Goes to whoever scheduled it. */
  'publishing.failed': { severity: 'warning' },
  /**
   * A connected account stopped working. Goes to the members who can fix it,
   * because everyone else can only worry about it.
   */
  'publishing.connection_needs_reauth': { severity: 'warning' },

  /*
   * Phase 7 — Analytics, Insights and Automations.
   *
   * FOUR TEMPLATES, AND EACH ONE IS SOMETHING A PERSON HAS TO DECIDE ABOUT OR
   * ACT ON. A refreshed chart is not news; a number that moved unusually, an
   * inference waiting for review, and an automation that will not proceed
   * without a human are.
   */
  /**
   * AN AUTOMATION WANTS TO DO SOMETHING EXTERNAL AND IS WAITING FOR A PERSON.
   *
   * ITS OWN TEMPLATE RATHER THAN `publishing.published`, deliberately. "Something
   * was published" and "something wants to be published and will not be until you
   * say so" are opposite messages, and sharing one would teach people to skim
   * both — which is exactly what must not happen to the one notification that
   * stands between an automation and the outside world.
   */
  'automation.confirmation_required': { severity: 'warning' },
  /** An automation stopped because its creator no longer has the authority. */
  'automation.blocked': { severity: 'warning' },
  /**
   * P6-12 — A NOTIFY rule fired. Its OWN template: authoring used to write
   * `automation.confirmation_required` into every NOTIFY rule, so a plain
   * "tell me when content is approved" rule arrived saying something was
   * waiting for confirmation — the one message that must never be cried wolf.
   */
  'automation.notice': { severity: 'info' },
  /** A metric moved far enough from its baseline to be worth a look. */
  'analytics.anomaly_detected': { severity: 'info' },
  /** An inferred learning is waiting in the Brand Brain review queue. */
  'brand_brain.learning_proposed': { severity: 'info' },

  /*
   * Prototype v94 Phase 2B-1, A8 (D-328) — the owner's deletion request. Both go
   * to every active member but the one who acted: people lose access to the
   * workspace while it waits, and they are owed the reason and the date.
   */
  /** An owner asked for this workspace to be deleted, on `scheduledFor`. */
  'workspace.deletion_requested': { severity: 'warning' },
  /** An owner took the deletion request back; the workspace is open again. */
  'workspace.deletion_cancelled': { severity: 'info' },
  /**
   * Prototype v94 Phase 2B-1, G5 / Q22 (D-334) — the workspace's time zone
   * changed and this post's local time would now be in the past or too soon,
   * so it went back to planned. Goes to the post's author.
   */
  'calendar.unplanned_by_timezone_change': { severity: 'warning' },
} as const;

export type NotificationTemplateKey = keyof typeof NOTIFICATION_TEMPLATES;

export const NOTIFICATION_TEMPLATE_KEYS = Object.keys(
  NOTIFICATION_TEMPLATES,
) as NotificationTemplateKey[];

/**
 * What a template's payload may contain.
 *
 * NO BODY TEXT, NO CAPTION, NO SECRET. A notification is a pointer — a title, a
 * brand and an actor — and the reader follows the link to the thing itself,
 * where the ordinary permission checks apply. Copying content into a
 * notification would route it around those checks.
 */
export interface NotificationPayload {
  itemTitle?: string;
  brandName?: string;
  actorName?: string;
  /*
   * Phase 6. The PLATFORM and the ACCOUNT NAME — both public on the platform in
   * question, and both needed for the message to mean anything: "a post
   * failed" is not actionable, "your LinkedIn post to Acme Ltd failed" is.
   *
   * STILL NO BODY, NO CAPTION, NO PROVIDER TEXT AND NO TOKEN. The failure is
   * carried as a stable CLASS the reader's own dashboard translates, never as
   * the provider's sentence, which routinely echoes the content it rejected.
   */
  providerKey?: string;
  accountName?: string;
  failureClass?: string;
  /*
   * Phase 7. The rule and the metric, both of which are OUR OWN identifiers or a
   * name the customer wrote — never a figure, and never a provider string.
   *
   * NO METRIC VALUE TRAVELS IN A NOTIFICATION. "Engagement fell to 412" in an
   * inbox is a performance figure sitting outside every freshness, scope and
   * permission check the analytics surface applies; the reader follows the link
   * and sees the number under those checks, where it belongs.
   */
  automationName?: string;
  actionType?: string;
  metricKey?: string;
  /** A8 (D-328): when a pending deletion takes effect, as an ISO instant. */
  scheduledFor?: string;
}
