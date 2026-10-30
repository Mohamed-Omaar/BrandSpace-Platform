import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE POST AND CAMPAIGN CARDS (design-system programme, S5; D-578, KNOWN bugs
 * 15 and 16).
 */
const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const css = read('packages/ui/src/prototype.css');
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${escaped} \\{\\n([\\s\\S]*?)\\n\\}`).exec(css);
  expect(m, selector).not.toBeNull();
  return m![1]!;
};
const library = read('apps/dashboard/src/app/[locale]/content/content-library.tsx');

describe('bug 15: the campaign card +N badge', () => {
  it('sits out of the layout, centred over the frame, so the picture fills it', () => {
    const more = rule('.bsp-camp-more');
    expect(more).toMatch(/position: absolute;/);
    expect(more).toMatch(/left: 50%;\s*top: 50%;\s*translate: -50% -50%;/);
  });
});

describe('bug 16: the Posts grid', () => {
  it('the cards of a row share one height', () => {
    expect(rule('.bsp-posts-grid')).toMatch(/align-items: stretch;/);
    expect(rule('.bsp-posts-grid > li')).toMatch(/display: flex;/);
    expect(rule('.bsp-posts-grid > li > .bsp-post')).toMatch(/flex: 1 1 auto;/);
  });

  it("a text-only post's picture is the soft abstract art, never the title again", () => {
    expect(library).toContain('<AbstractMedia seed={softSeed(card.id)} alt="" />');
    expect(library).toMatch(/\(id\.charCodeAt\(id\.length - 1\) % 2 === 0 \? 2 : 5\)/);
    expect(library).not.toContain('card.excerpt || card.title');
    expect(rule('.bsp-post-overlay.bsp-post-overlay-ink')).toMatch(
      /color: var\(--bs-media-ink-soft\);/,
    );
  });
});
