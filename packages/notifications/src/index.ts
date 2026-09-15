/**
 * Workspace notifications — Phase 5B-3 (docs/PRODUCT.md §5 module 16).
 *
 * In-app only (D-123). No transport, no external delivery, no third party.
 */
export { NotificationService } from './service';
export type { CreateNotificationInput, NotificationOptions, NotificationView } from './service';
export { NOTIFICATION_TEMPLATES, NOTIFICATION_TEMPLATE_KEYS } from './templates';
export type { NotificationPayload, NotificationTemplateKey } from './templates';
