import { writeAuditEvent, type TenantScopedClient } from '@brandspace/database';
import type { NotificationTemplateKey } from './templates';

/**
 * PER-PERSON NOTIFICATION PREFERENCES (A10 / G2, prototype v94 Phase 2B-1,
 * D-331).
 *
 * A member switches whole CATEGORIES of their own in-app notifications on or
 * off. The switches filter the bell and nothing else: notifications stay
 * in-app only (D-123), and a switched-off notification is simply not written
 * for that person — the event, its audit record and everybody else's copy
 * are untouched.
 *
 * NO ROW MEANS ON. A member who never opened the screen gets everything, as
 * before; only an explicit "off" is stored.
 *
 * NOT EVERYTHING IS SWITCHABLE. A notice about the workspace itself (its
 * deletion was requested or cancelled) and an analytics anomaly belong to no
 * category and always arrive: the first is a safety notice, the second has no
 * switch in the approved design. So do the two publishing notices that say a
 * post will NOT go out unless someone acts — an account that needs
 * reconnecting, and a scheduled post a time-zone change sent back to planned
 * (PR #47 review item 17): switching off "Publishing" mutes the routine
 * published/failed news, never these.
 */
export const NOTIFICATION_CATEGORIES = [
  'approvals',
  'publishing',
  /** "An automation notifies me or needs my OK." */
  'automations',
  /** "Brand Brain facts wait for my review." */
  'brand_brain_reviews',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * EVERY TEMPLATE IS CLASSIFIED. A `Record` over the closed template catalogue,
 * so a new template that nobody placed in a category (or deliberately left
 * out of one) is a compile error rather than a notification nobody can mute.
 */
const CATEGORY_OF: Readonly<Record<NotificationTemplateKey, NotificationCategory | null>> = {
  'approval.requested': 'approvals',
  'approval.approved': 'approvals',
  'approval.changes_requested': 'approvals',
  'approval.rejected': 'approvals',
  'approval.withdrawn_after_edit': 'approvals',
  /** Phase 2B-3 PR 3 — muted with every other review notice. */
  'approval.reminder': 'approvals',
  'publishing.published': 'publishing',
  'publishing.failed': 'publishing',
  /** Critical: nothing publishes on that account until someone acts (review item 17). */
  'publishing.connection_needs_reauth': null,
  'automation.confirmation_required': 'automations',
  'automation.blocked': 'automations',
  'automation.notice': 'automations',
  'brand_brain.learning_proposed': 'brand_brain_reviews',
  'analytics.anomaly_detected': null,
  'workspace.deletion_requested': null,
  'workspace.deletion_cancelled': null,
  /** Critical: a scheduled post will no longer go out unless someone acts (review item 17). */
  'calendar.unplanned_by_timezone_change': null,
};

export function categoryOf(templateKey: NotificationTemplateKey): NotificationCategory | null {
  return CATEGORY_OF[templateKey];
}

export function isNotificationCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

export type NotificationPreferences = Readonly<Record<NotificationCategory, boolean>>;

/**
 * Of these recipients, the ones who switched this template's category OFF.
 * Read inside the caller's workspace transaction (RLS), for exactly these
 * people and this one category.
 */
export async function mutedRecipients(
  db: TenantScopedClient,
  workspaceId: string,
  userIds: readonly string[],
  templateKey: NotificationTemplateKey,
): Promise<ReadonlySet<string>> {
  /*
   * AN UNCLASSIFIED KEY FAILS CLOSED (Fix PR 1 · F5, D-412). `CATEGORY_OF`
   * covers every template, so this cannot happen through a typed caller; it did
   * through an automation rule's free-text key, and `category: undefined` made
   * the query below drop its category filter, muting everyone who had switched
   * ANY category off. Refusing sends nothing, which is the safe side.
   */
  if (!Object.hasOwn(CATEGORY_OF, templateKey)) {
    throw new Error('Refusing a notification whose template is not in the catalogue.');
  }
  const category = categoryOf(templateKey);
  if (category === null || userIds.length === 0) return new Set();
  const rows = await db.notificationPreference.findMany({
    where: { workspaceId, userId: { in: [...userIds] }, category, enabled: false },
    select: { userId: true },
  });
  return new Set(rows.map((row) => row.userId));
}

/**
 * One member's own switches. Every read and write names the member's OWN
 * `userId` in the query, so nobody can read or change another person's.
 */
export class NotificationPreferenceService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;

  constructor(options: { db: TenantScopedClient; workspaceId: string }) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
  }

  async forUser(userId: string): Promise<NotificationPreferences> {
    const rows = await this.#db.notificationPreference.findMany({
      where: { workspaceId: this.#workspaceId, userId },
      select: { category: true, enabled: true },
    });
    const stored = new Map(rows.map((row) => [row.category, row.enabled] as const));
    return Object.fromEntries(
      NOTIFICATION_CATEGORIES.map((category) => [category, stored.get(category) ?? true]),
    ) as Record<NotificationCategory, boolean>;
  }

  /** Save all four switches at once, and audit what changed. */
  async set(userId: string, next: NotificationPreferences): Promise<void> {
    const before = await this.forUser(userId);
    const changed = NOTIFICATION_CATEGORIES.filter(
      (category) => before[category] !== next[category],
    );
    if (changed.length === 0) return;
    for (const category of changed) {
      await this.#db.notificationPreference.upsert({
        where: {
          workspaceId_userId_category: { workspaceId: this.#workspaceId, userId, category },
        },
        create: { workspaceId: this.#workspaceId, userId, category, enabled: next[category] },
        update: { enabled: next[category] },
      });
    }
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'notification.preferences.updated',
      actorType: 'USER',
      actorId: userId,
      resourceType: 'user',
      resourceId: userId,
      severity: 'INFO',
      before: Object.fromEntries(changed.map((category) => [category, before[category]])),
      after: Object.fromEntries(changed.map((category) => [category, next[category]])),
    });
  }
}
