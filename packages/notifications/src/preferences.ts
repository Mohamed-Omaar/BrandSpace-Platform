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
 * switch in the approved design.
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
  'publishing.published': 'publishing',
  'publishing.failed': 'publishing',
  'publishing.connection_needs_reauth': 'publishing',
  'automation.confirmation_required': 'automations',
  'automation.blocked': 'automations',
  'automation.notice': 'automations',
  'brand_brain.learning_proposed': 'brand_brain_reviews',
  'analytics.anomaly_detected': null,
  'workspace.deletion_requested': null,
  'workspace.deletion_cancelled': null,
  'calendar.unplanned_by_timezone_change': 'publishing',
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
