import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUTPUT, generate } from '../../scripts/style/gallery-console';

/**
 * The gallery's console scope is generated from tokens.css and prototype.css
 * (scripts/style/gallery-console.ts). If either changes, the scope must be
 * regenerated (`pnpm style:gallery`), or the gallery would show the Control
 * Center at the wrong size.
 */
describe('gallery-console.css', () => {
  const root = path.resolve(__dirname, '../..');
  const committed = readFileSync(path.join(root, OUTPUT), 'utf8');

  it('is byte-identical to the generator output', () => {
    expect(committed).toBe(generate(root));
  });

  it('puts back the unscaled size scale prototype.css overrides', () => {
    expect(committed).toContain('.bs-gallery-console {');
    expect(committed).toMatch(/--bsp-px-12: 12px;/);
    expect(committed.split('\n').filter((l) => l.startsWith('  --')).length).toBeGreaterThan(200);
  });
});
