import 'server-only';
import { TtlCache } from '@brandspace/shared';
import type { ContentPolicy } from '@brandspace/content';

/**
 * PERF A (#4) — THIS PROCESS'S COPY OF THE GLOBAL CATALOGUE, at most 30 s old.
 *
 * The activated plans, entitlements, feature flags and content policy: the
 * same rows for every workspace, read on every page several times over. They
 * are now read at most once per 5 s (the catalogue) or 30 s (the content
 * policy) per dashboard process, so an activation or a rollback in the Control
 * Center reaches every dashboard process within that time; nothing is shared
 * between processes. Sessions, memberships, roles,
 * permissions, subscriptions and overrides are never kept here.
 */
/**
 * The entitlement catalogue — plans, entitlements and FEATURE FLAGS — at most
 * 5 s: a kill switch is a feature flag, and docs/ADMIN-CONTROL-CENTER.md §5.5
 * contains one "within seconds" (the same 5 s the catalogue's own cache has,
 * docs/ARCHITECTURE.md §7).
 */
export const CATALOGUE_CACHE_TTL_MS = 5_000;
export const catalogueCache = new TtlCache<Record<string, unknown>>(CATALOGUE_CACHE_TTL_MS);
/** The content policy: at most 30 s. */
export const contentPolicyCache = new TtlCache<ContentPolicy>();
