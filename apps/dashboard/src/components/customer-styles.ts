import type { CSSProperties } from 'react';
import { buttonStyle, inputStyle, tdStyle, thStyle, typographyTokens } from '@brandspace/ui';

/**
 * The customer surfaces' shared style constants.
 *
 * WHY THEY ARE NOT IN `workspace-shell.tsx` ANY MORE. They are pure values with
 * no server dependency, and client components import them — which meant a
 * `'use client'` module was importing the SERVER SHELL to reach three style
 * objects, dragging the shell's whole module graph into the browser bundle
 * behind it. That was invisible until the shell needed `next/headers`, at which
 * point the build refused with an error naming an API the client component had
 * never heard of.
 *
 * Splitting them costs one file and makes the boundary hold by construction:
 * nothing here can ever reach a server-only API, so nothing that imports it can
 * be broken by one.
 */

export const customerTableStyle = (): CSSProperties => ({
  inlineSize: '100%',
  borderCollapse: 'collapse',
  fontSize: typographyTokens.bodySm.fontSize,
  textAlign: 'start',
});
export const customerThStyle = thStyle;
export const customerTdStyle = tdStyle;
export const customerButtonStyle = (): CSSProperties => buttonStyle('primary');
export const customerSecondaryButtonStyle = (): CSSProperties => buttonStyle('neutral');
export const customerInputStyle = (): CSSProperties => ({
  ...inputStyle(),
  maxInlineSize: '24rem',
});
