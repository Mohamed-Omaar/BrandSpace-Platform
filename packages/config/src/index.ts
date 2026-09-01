/**
 * Versioned Configuration Service — docs/ARCHITECTURE.md §7.
 *
 * PHASE 2. This package exists in Phase 1 only to establish the module boundary
 * (lint-enforced in eslint.config.mjs) and to reserve the import graph position.
 * It intentionally exports no runtime behaviour yet.
 */
export const CONFIG_PACKAGE_PHASE = 2 as const;

/** Configuration domains this service will own. Listed so the boundary is explicit. */
export const PLANNED_CONFIG_DOMAINS = [
  'ai.providers',
  'ai.models',
  'ai.routing',
  'ai.credit-costs',
  'plans',
  'features',
  'entitlements',
  'feature-flags',
  'integrations.social',
  'integrations.email',
  'integrations.payment',
  'integrations.storage',
  'notifications.templates',
  'billing.settings',
  'currencies',
  'trial',
  'limits',
  'policies',
  'cms',
] as const;
