/**
 * SEVERAL BRANDS IN ONE WORKSPACE IS A PLATFORM FEATURE, OFF BY DEFAULT (Q2b).
 *
 * The owner switched multi-brand OFF for now so customers are not confused:
 * one workspace = one business = one brand. It is a feature flag in the
 * Control Center (D-314) rather than a code branch, and NOTHING REGISTERS IT IN
 * CODE — an unregistered key resolves `unknown_feature` and fails closed, which
 * is exactly "Nobody". Registering it and choosing who gets it is an operator
 * change, and switching it back on needs no deploy.
 *
 * While it is off (recorded in D-327):
 *   - the server refuses a SECOND live brand (`createBrandFor`);
 *   - brand switching is hidden: a member acts on the workspace's oldest brand
 *     they may see (`listAccessibleBrands`), so every screen names that brand;
 *   - the brand-limit rows are hidden on Plan & usage.
 * All multi-brand code stays, so it can be switched back on per plan later.
 */
export const MULTI_BRAND_FEATURE = 'feature.multi_brand';
