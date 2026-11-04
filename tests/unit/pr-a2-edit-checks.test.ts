import { describe, expect, it } from 'vitest';
import {
  checkEdit,
  checkHashtags,
  measurableDirective,
  refuseBeforeCall,
  similarity,
  strongerDirective,
  taskKeyForTool,
} from '@brandspace/content';

/**
 * PR A2 (item 10) — the edit chips are MEASURABLE: Shorter cuts at least 30%,
 * Longer adds at least 30%, a tone change is visible, and a nearly identical
 * answer is not charged. These are the pure rules; the isolation suite proves
 * the wallet does not move when they refuse.
 */
const before = 'a'.repeat(100);

describe('PR A2 (item 10) — what each AI edit must achieve', () => {
  // PR 2 (D-598): the instruction asks for 30%; an answer is ACCEPTED at 15%.
  it('Shorter: accepted at most 85% of the characters', () => {
    expect(checkEdit('shorten', before, 'b'.repeat(85), 2200)).toBeNull();
    expect(checkEdit('shorten', before, 'b'.repeat(86), 2200)).toBe('EDIT_NOT_SHORTER');
  });

  it('Longer: accepted at least 115% of the characters', () => {
    expect(checkEdit('expand', before, 'b'.repeat(115), 2200)).toBeNull();
    expect(checkEdit('expand', before, 'b'.repeat(114), 2200)).toBe('EDIT_NOT_LONGER');
  });

  it('PR 2: the retry says plainly what the first answer got wrong', () => {
    expect(strongerDirective('shorten', 'EDIT_NOT_SHORTER')).toContain('not short enough');
    expect(strongerDirective('expand', 'EDIT_NOT_LONGER')).toContain('not long enough');
    expect(strongerDirective('tone', 'EDIT_NO_CHANGE')).toContain('requested tone');
  });

  it('counts characters as a reader does (Arabic and emoji are one each)', () => {
    const arabic = 'مرحبا بكم في متجرنا الجديد'; // 26 code points
    expect(checkEdit('shorten', arabic, 'مرحبا بكم', 2200)).toBeNull();
    expect(checkEdit('shorten', '🌸'.repeat(10), '🌸'.repeat(7), 2200)).toBe('EDIT_NO_CHANGE');
  });

  it('a nearly identical answer is refused for every rewriting edit', () => {
    const text = 'Our spring collection arrives this Friday in every store.';
    expect(similarity(text, `${text.toUpperCase()}!`)).toBe(1);
    for (const tool of ['rewrite', 'tone']) {
      expect(checkEdit(tool, text, text.replace('Friday', 'Friday,'), 2200)).toBe('EDIT_NO_CHANGE');
      expect(
        checkEdit(tool, text, 'Hey friends! Spring lands Friday at every store.', 2200),
      ).toBeNull();
    }
  });

  it('translation and the changed-fact rewrite are not judged by length or likeness', () => {
    expect(checkEdit('translate', before, before, 2200)).toBeNull();
    expect(checkEdit('refresh_facts', before, before, 2200)).toBeNull();
  });

  it('the hashtag tool is charged only when it proposes a tag the post lacks', () => {
    expect(checkHashtags(['Spring'], ['#spring'])).toBe('EDIT_NO_CHANGE');
    expect(checkHashtags(['Spring'], [])).toBe('EDIT_NO_CHANGE');
    expect(checkHashtags(['Spring'], ['sale'])).toBeNull();
  });

  it('Longer is refused before the call when 30% more would not fit the channel', () => {
    expect(refuseBeforeCall('expand', 'a'.repeat(250), 280)).toBe('EDIT_CANNOT_GROW');
    expect(refuseBeforeCall('expand', 'a'.repeat(200), 280)).toBeNull();
  });

  it('each instruction states its measurable target', () => {
    expect(measurableDirective('shorten', before, 2200)).toContain('Return at most 70 characters');
    expect(measurableDirective('expand', before, 2200)).toContain(
      'Return at least 130 characters (at least 30% longer) and at most 2200',
    );
    expect(measurableDirective('tone', before, 2200)).toContain('clearly visible');
  });

  it('Translate is routed and priced as content.translate; every other edit as a caption', () => {
    expect(taskKeyForTool('translate')).toBe('content.translate');
    for (const tool of [
      'rewrite',
      'shorten',
      'expand',
      'tone',
      'hashtags',
      'refresh_facts',
    ] as const) {
      expect(taskKeyForTool(tool)).toBe('caption.generate');
    }
  });
});
