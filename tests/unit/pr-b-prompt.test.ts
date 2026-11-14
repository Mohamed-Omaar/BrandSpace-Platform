import { describe, expect, it } from 'vitest';
import {
  brandImagePrompt,
  findCreativeFormat,
  type BrandIdentityInput,
} from '@brandspace/creative';

/**
 * PR B — THE IMAGE PROMPT KNOWS THE BRAND: each colour with its role, the
 * industry, the voice and the do's and don'ts (fenced as data), and it never
 * asks the model for a logo or lettering — the real logo and the headline are
 * put on afterwards, so their corner and band are kept calm.
 */

const square = findCreativeFormat('square')!;
const identity: BrandIdentityInput = {
  name: 'Bayt Coffee',
  industry: 'Speciality coffee',
  description: 'A roastery in Riyadh.',
  palette: ['#7935FE', '#FFDD15', '#111114', '#F4F4F2'],
  typography: ['Tajawal'],
  knowledge: ['Founded in 2019.'],
  voice: ['Warm, calm and precise; never shouty.'],
  doDont: ['Do show real cups. Do not show alcohol.'],
};

describe('PR B · the brand-aware image prompt', () => {
  const prompt = brandImagePrompt('A cup on a sunny table', square, identity, {
    addLogo: true,
    headline: 'Autumn blend is here',
  });

  it('names each colour with its role, in the Brand Kit order', () => {
    expect(prompt).toContain(
      'Brand colours, by role: #7935FE (primary), #FFDD15 (secondary), #111114 (accent), #F4F4F2 (supporting).',
    );
  });

  it('carries the industry, the voice and the do’s and don’ts — fenced as data', () => {
    expect(prompt).toContain('Industry: Speciality coffee.');
    expect(prompt).toMatch(/BRAND VOICE[\s\S]*Warm, calm and precise/);
    expect(prompt).toMatch(/BRAND DO'S AND DON'TS[\s\S]*Do not show alcohol/);
    expect(prompt).toContain('Match the visual style and mood to the brand voice below.');
  });

  it('never asks for a logo or lettering; keeps the logo corner and the headline band calm', () => {
    expect(prompt).toContain('Do not render a logo, a wordmark or any brand lettering.');
    expect(prompt).toContain('bottom-right corner calm');
    expect(prompt).toContain('Do not render any text.');
    // The headline's words never reach the model: they are drawn afterwards.
    expect(prompt).not.toContain('Autumn blend is here');
  });

  it('no logo, no headline: neither space is asked for', () => {
    const plain = brandImagePrompt('A cup', square, identity, { addLogo: false, headline: null });
    expect(plain).not.toContain('bottom-right corner');
    expect(plain).not.toContain('Do not render any text.');
  });
});
