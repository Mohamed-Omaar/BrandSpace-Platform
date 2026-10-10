import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * D-484 — THE CUSTOMER APP IS THE PROTOTYPE AT 0.88.
 *
 * The owner's choice (batch 7): one factor on every size the prototype states,
 * each value rounded to the nearest 0.5px, type never below 11px. The size
 * checks measure the prototype as it is and expect the product at this scale.
 */
export const SCALE = 0.88;

/** A prototype length as the product draws it. */
export function scaled(px: number): number {
  return Math.round(px * SCALE * 2) / 2;
}

/** A prototype font size as the product draws it: scaled, never below 11px. */
export function scaledType(px: number): number {
  return Math.max(11, scaled(px));
}

/**
 * Every size token at the PROTOTYPE's own value, read from `tokens.css` (which
 * keeps them unscaled for the Control Center and the public site). Set on the
 * customer page's root, they undo the 0.88 scale and the 11px type floor, so a
 * check can read an element's SOURCE size — what the prototype's markup asks
 * for — rather than the size the floor lets it reach on screen.
 */
export function prototypeSizes(): Record<string, string> {
  const source = readFileSync(
    fileURLToPath(new URL('../../packages/ui/src/tokens.css', import.meta.url)),
    'utf8',
  );
  const sizes: Record<string, string> = {};
  const pattern =
    /^\s*(--(?:bsp-(?:px|rem|fs)-[0-9a-z-]+|bs-(?:space|radius)-[0-9a-z]+|bsp-target-min))\s*:\s*([^;]+);/gm;
  for (const [, name, value] of source.matchAll(pattern)) {
    if (!(name! in sizes)) sizes[name!] = value!.trim();
  }
  return sizes;
}
