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
}
