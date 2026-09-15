/**
 * The customer Activity Log — Phase 5B-3 (docs/PRODUCT.md §5 module 17).
 *
 * A READ MODEL over `audit_event`. It adds no table, writes nothing, and
 * leaves the append-only guarantee exactly where it found it.
 */
export { ActivityLogService } from './service';
export type { ActivityEntry, ActivityFilter, ActivityOptions, ActivityPage } from './service';
export { resolveActivityScope } from './scope';
export type { ActivityScope } from './scope';
