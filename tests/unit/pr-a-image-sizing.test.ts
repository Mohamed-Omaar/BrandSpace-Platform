import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_SIZING,
  findCreditRule,
  resolveImageSize,
  type ImageSizing,
} from '@brandspace/ai-gateway';
import { CREATIVE_FORMATS } from '@brandspace/creative';

/**
 * PR A (item 6) — the size an image model is asked for, and the price per
 * quality. Sources: https://developers.openai.com/api/docs/guides/image-generation
 */

const CUSTOM: ImageSizing = {
  mode: 'custom',
  multipleOf: 16,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxEdge: 3_840,
  maxAspectRatio: 3,
};

describe('custom sizes (gpt-image-2): the smallest exact-aspect size, multiples of 16', () => {
  it.each([
    ['square', '1088x1088'],
    ['portrait', '1088x1360'],
    ['story', '1152x2048'],
    ['landscape', '1280x720'],
  ])('%s → %s', (key, expected) => {
    const format = CREATIVE_FORMATS.find((candidate) => candidate.key === key)!;
    expect(resolveImageSize(format.size, CUSTOM)).toBe(expected);
  });

  it('a size the model already accepts is kept', () => {
    expect(resolveImageSize('1536x1024', CUSTOM)).toBe('1536x1024');
  });
});

describe('fixed sizes (the standard GPT image list): the same orientation', () => {
  it.each([
    ['square', '1024x1024'],
    ['portrait', '1024x1536'],
    ['story', '1024x1536'],
    ['landscape', '1536x1024'],
  ])('%s → %s', (key, expected) => {
    const format = CREATIVE_FORMATS.find((candidate) => candidate.key === key)!;
    expect(resolveImageSize(format.size, DEFAULT_IMAGE_SIZING)).toBe(expected);
  });
});

describe('F-106 — a credit rule per quality', () => {
  const rule = (imageQuality: 'low' | 'medium' | 'high' | null, base: number) => ({
    taskKey: 'image.generate',
    modelKey: 'm',
    baseMilliCredits: base,
    perUnitMilliCredits: 0,
    unit: 'request' as const,
    imageQuality,
  });

  it('the exact quality wins; a rule with no quality prices the rest; another quality never applies', () => {
    const rules = [rule('high', 24_000), rule(null, 6_000)];
    expect(findCreditRule(rules, 'image.generate', 'm', 'high').baseMilliCredits).toBe(24_000);
    expect(findCreditRule(rules, 'image.generate', 'm', 'low').baseMilliCredits).toBe(6_000);
    expect(() => findCreditRule([rule('high', 24_000)], 'image.generate', 'm', 'low')).toThrow(
      /No credit rule/,
    );
  });
});
