/**
 * MULTI-BRAND OFF: ONE WORKSPACE, ONE BRAND (Q2b, D-327).
 *
 * The rules live in `@brandspace/entitlements` (`brand-access.ts`) since D-566,
 * so the dashboard and the MCP server read a member's brands through one rule.
 * Re-exported here so every existing import keeps its path.
 */
export {
  assertMayCreateAnotherBrand,
  multiBrandEnabled,
  readAccessibleBrands,
  type BrandRulesClient,
  type FeatureGate,
} from '@brandspace/entitlements';
