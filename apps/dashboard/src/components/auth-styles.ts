import type { CSSProperties } from 'react';

/**
 * The auth form's input and button. D-468: the prototype's `.in` (a 58px
 * `#f4f4f5` field, radius 14, 15.5px) and `.btn` (56px, radius 14, 15px /
 * 800) are drawn by `prototype.css` (§3-AUTH) on the card; these keep only the
 * full width, so the page's forms need not change.
 */
export function authInputStyle(): CSSProperties {
  return { inlineSize: '100%' };
}

export function authButtonStyle(): CSSProperties {
  return { inlineSize: '100%' };
}
