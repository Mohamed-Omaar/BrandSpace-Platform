import type { CSSProperties } from 'react';
import { colorTokens, radiusTokens, spacingTokens, typographyTokens } from './tokens';

/**
 * The menu-item style, in a module that is NOT `'use client'`.
 *
 * WHY IT LIVES HERE. A pure style function exported from a `'use client'`
 * module cannot be called by a server component: React treats every export of
 * a client module as a client reference, so the call fails at runtime with
 * "Attempted to call menuItemStyle() from the server". The end-to-end suite
 * caught exactly that — every authenticated page 500'd.
 *
 * The rule this file exists to enforce: styles and tokens are shared by both
 * runtimes and belong in a neutral module; only components that need state,
 * effects or event handlers go in a `'use client'` one.
 */
export function menuItemStyle(): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: spacingTokens.sm,
    inlineSize: '100%',
    minBlockSize: '2.5rem',
    paddingInline: spacingTokens.md,
    paddingBlock: spacingTokens.sm,
    borderRadius: radiusTokens.control,
    border: 0,
    color: colorTokens.textPrimary,
    ...typographyTokens.bodySm,
    textAlign: 'start',
    textDecoration: 'none',
    cursor: 'pointer',
  };
}
