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
}
