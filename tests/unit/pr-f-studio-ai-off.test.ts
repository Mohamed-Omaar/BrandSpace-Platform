import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * PR F review (2) — WITH AI OFF, THE STUDIO OFFERS NO AI BRIEF.
 *
 * "What is the post about?", "Or start from: Start from an idea / Repurpose a
 * post" and "AI writes the caption below from this idea" all need a caption
 * model. While `aiAvailableFor('caption.generate')` is false they are absent
 * for everyone, and the caption box asks only for the caption. Writing the
 * caption by hand stays. (The rendered result is in the review screenshots.)
 */

const composer = readFileSync(
  'apps/dashboard/src/app/[locale]/content/compose/composer-view.tsx',
  'utf8',
);
const page = readFileSync('apps/dashboard/src/app/[locale]/content/compose/page.tsx', 'utf8');

/** The source from the brief's gate to the caption field that follows it. */
function gatedBlock(): string {
  const open = composer.indexOf('{aiWriting ? (');
  expect(open, 'the brief has a gate').toBeGreaterThan(-1);
  // The gate closes before the caption field, which stays for everyone.
  const close = composer.indexOf('className="bsp-st-caphead"', open);
  expect(close, 'the caption field follows the gate').toBeGreaterThan(open);
  const block = composer.slice(open, close);
  expect(block.trimEnd()).toMatch(/\) : null\}\s*<div className="bsp-st-field">\s*<div$/);
  return block;
}

describe('the Studio brief follows caption availability', () => {
  it('the page passes whether a caption model can run', () => {
    expect(page).toMatch(/aiWriting=\{aiCaption\}/);
    expect(page).toMatch(/aiAvailableFor\('caption\.generate'\)/);
  });

  it('the brief, both start-from links and the AI hint are inside the gate', () => {
    const block = gatedBlock();
    for (const piece of [
      "t['studio.briefLabel']",
      'data-testid="content-brief"',
      'data-testid="create-mode-idea"',
      'data-testid="create-mode-repurpose"',
      "t['studio.briefHint']",
    ]) {
      expect(block, piece).toContain(piece);
    }
  });

  it('the caption box stays, and does not mention AI while AI is off', () => {
    expect(composer).toContain('data-testid="content-caption"');
    expect(composer).toMatch(
      /placeholder=\{\s*aiWriting \? t\['studio\.capPlaceholder'\] : t\['studio\.capPlaceholderManual'\]\s*\}/,
    );
  });
});
