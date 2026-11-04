import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PR 2 (D-598) — THE THINKING DOTS ARE THE LANDING PAGE'S, EXACTLY.
 *
 * Source: Mohamed-Omaar/Brandspace-Landing-page `index.html` lines 29-35:
 *   .dots{display:flex;gap:7px} .dots i{width:8px;height:8px;border-radius:50%;
 *   background:var(--ink);opacity:.18;animation:pulse 1.35s ease-in-out infinite}
 *   .dots i:nth-child(2){animation-delay:.16s;background:var(--purple)}
 *   .dots i:nth-child(3){animation-delay:.32s;background:var(--yellow)}
 *   @keyframes pulse{0%,100%{transform:translateY(0);opacity:.18}
 *                    50%{transform:translateY(-7px);opacity:1}}
 *   @media(prefers-reduced-motion:reduce){.dots i{animation:none}}
 * with --ink:#111114, --purple:#7935fe, --yellow:#ffdd15.
 */
const root = path.resolve(__dirname, '../..');
const tokens = readFileSync(path.join(root, 'packages/ui/src/tokens.css'), 'utf8');
const value = (name: string) =>
  new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*([^;]+);`).exec(tokens)?.[1]?.trim();

describe('PR 2 · the thinking dots', () => {
  it('carry the landing page values as tokens', () => {
    expect(value('--bs-dots-size')).toBe('8px');
    expect(value('--bs-dots-gap')).toBe('7px');
    expect(value('--bs-dots-lift')).toBe('-7px');
    expect(value('--bs-dots-rest')).toBe('0.18');
    expect(value('--bs-dots-cycle')).toBe('1.35s');
    expect(value('--bs-dots-step')).toBe('0.16s');
    expect(value('--bs-dots-ease')).toBe('ease-in-out');
  });

  it('use the brand ink, purple and yellow tokens, which hold the landing colours', () => {
    expect(value('--bs-text-primary')?.toLowerCase()).toBe('#111114');
    expect(value('--bs-brand-purple')?.toLowerCase()).toBe('#7935fe');
    expect(value('--bs-brand-yellow')?.toLowerCase()).toBe('#ffdd15');
    expect(tokens).toMatch(/\.bs-dots > i \{[^}]*background: var\(--bs-text-primary\)/);
    expect(tokens).toMatch(
      /\.bs-dots > i:nth-child\(2\) \{[^}]*animation-delay: var\(--bs-dots-step\);[^}]*background: var\(--bs-brand-purple\)/,
    );
    expect(tokens).toMatch(
      /\.bs-dots > i:nth-child\(3\) \{[^}]*animation-delay: calc\(var\(--bs-dots-step\) \* 2\);[^}]*background: var\(--bs-brand-yellow\)/,
    );
  });

  it('stop moving for reduced motion', () => {
    expect(tokens).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.bs-dots > i \{\s*animation-name: none;/,
    );
  });
});
