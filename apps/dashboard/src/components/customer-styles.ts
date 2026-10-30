import type { CSSProperties } from 'react';

/**
 * The customer surfaces' shared style constants.
 *
 * WHY THEY ARE NOT IN `workspace-shell.tsx` ANY MORE. They are pure values with
 * no server dependency, and client components import them — which meant a
 * `'use client'` module was importing the SERVER SHELL to reach its style
 * constants, dragging the shell's whole module graph into the browser bundle
 * behind it. That was invisible until the shell needed `next/headers`, at which
 * point the build refused with an error naming an API the client component had
 * never heard of.
 *
 * Splitting them costs one file and makes the boundary hold by construction:
 * nothing here can ever reach a server-only API, so nothing that imports it can
 * be broken by one.
 */

/** The customer form's field width; the field itself is `.bs-control` (S5). */
export const customerInputStyle = (): CSSProperties => ({
  maxInlineSize: 'var(--bsp-rem-24)',
});
