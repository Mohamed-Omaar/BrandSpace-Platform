import { type Notification, type TenantScopedClient } from '@brandspace/database';
import { systemClock, type Clock } from '@brandspace/shared';
import type { NotificationPayload, NotificationTemplateKey } from './templates';

/**
 * Workspace notifications — Phase 5B-3 (docs/PRODUCT.md §5 module 16,
 * docs/DATABASE.md §9.3).
 *
 * THE INVARIANTS:
 *
 *   - WRITTEN FROM DOMAIN EVENTS, never from a UI handler. The service that
 *     changed the state calls this one; a button does not. Scattering creation
 *     through route code is how a notification comes to exist for something
 *     that did not happen, and how one stops existing for something that did.
 *
 *   - IDEMPOTENT PER RECIPIENT PER EVENT. `(workspaceId, idempotencyKey)` is
 *     unique, so a retried action never doubles an inbox. The key is derived
 *     from the event and the reader, never from a clock.
 *
 *   - SERVER-ENFORCED READ STATE. `markRead` and `markAllRead` filter on the
 *     reader's OWN `userId` inside the query. A member cannot mark another
 *     member's notification read even by guessing its id, and cannot read one
 *     either: the row simply is not in their result set.
 *
 *   - IN-APP ONLY (D-123). No mail, no SMS, no push, no webhook. There is no
 *     transport in this platform to send one with, and a `channel` column that
 *     claimed otherwise would be a promise the product cannot keep. A database
 *     CHECK enforces it alongside this comment.
 */

export interface NotificationOptions {
  db: TenantScopedClient;
  workspaceId: string;
  clock?: Clock;
}

export interface CreateNotificationInput {
  /** The recipients. Duplicates are collapsed; an empty list is a no-op. */
  userIds: readonly string[];
  templateKey: NotificationTemplateKey;
  payload?: NotificationPayload;
  /** Workspace-relative and locale-less; the reader's locale is prefixed later. */
  linkPath?: string;
  brandId?: string;
  resourceType?: string;
  resourceId?: string;
  /**
   * Identifies the EVENT. The recipient's id is appended per row, so one event
   * reaching five people is five rows that each dedupe independently.
   */
  idempotencyKey: string;
}

export interface NotificationView {
  id: string;
  templateKey: string;
  payload: NotificationPayload;
  linkPath: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export class NotificationService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #clock: Clock;

  constructor(options: NotificationOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#clock = options.clock ?? systemClock;
  }

  /** Fan one event out to its recipients. Returns how many rows were new. */
  async create(input: CreateNotificationInput): Promise<number> {
    const recipients = [...new Set(input.userIds)].filter((id) => id.length > 0);
    if (recipients.length === 0) return 0;

    const rows = recipients.map((userId) => ({
      workspaceId: this.#workspaceId,
      userId,
      templateKey: input.templateKey,
      payload: (input.payload ?? {}) as object,
      channel: 'IN_APP' as const,
      linkPath: input.linkPath ?? null,
      brandId: input.brandId ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      idempotencyKey: `${input.idempotencyKey}:${userId}`,
    }));

    /*
     * `skipDuplicates` rather than a pre-read: the unique index is the authority
     * and a check-then-write would race two concurrent producers of the same
     * event into two inboxes.
     */
    const result = await this.#db.notification.createMany({ data: rows, skipDuplicates: true });
    return result.count;
  }

  /** One member's inbox, newest first. */
  async list(input: {
    userId: string;
    unreadOnly?: boolean;
    take?: number;
  }): Promise<NotificationView[]> {
    const rows = await this.#db.notification.findMany({
      where: {
        workspaceId: this.#workspaceId,
        userId: input.userId,
        ...(input.unreadOnly ? { readAt: null } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(input.take ?? 30, 100),
    });
    return rows.map(toView);
  }

  /** The badge. Counted in the database rather than by listing and measuring. */
  async unreadCount(userId: string): Promise<number> {
    return this.#db.notification.count({
      where: { workspaceId: this.#workspaceId, userId, readAt: null },
    });
  }

  /**
   * Mark one notification read.
   *
   * THE `userId` IS IN THE `where`, not checked afterwards. An id belonging to
   * another member matches nothing and updates nothing — the same shape as a
   * genuine miss, so the caller learns nothing about whether it exists.
   */
  async markRead(input: { id: string; userId: string; at?: Date }): Promise<boolean> {
    const result = await this.#db.notification.updateMany({
      where: {
        id: input.id,
        workspaceId: this.#workspaceId,
        userId: input.userId,
        readAt: null,
      },
      data: { readAt: input.at ?? this.#clock.now() },
    });
    return result.count > 0;
  }

  /** Mark everything in this member's inbox read. Returns how many changed. */
  async markAllRead(input: { userId: string; at?: Date }): Promise<number> {
    const result = await this.#db.notification.updateMany({
      where: { workspaceId: this.#workspaceId, userId: input.userId, readAt: null },
      data: { readAt: input.at ?? this.#clock.now() },
    });
    return result.count;
  }
}

function toView(row: Notification): NotificationView {
  return {
    id: row.id,
    templateKey: row.templateKey,
    payload: (row.payload ?? {}) as NotificationPayload,
    linkPath: row.linkPath,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}
