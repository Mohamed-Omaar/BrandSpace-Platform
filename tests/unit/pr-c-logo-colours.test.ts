import { describe, expect, it } from 'vitest';
import { logoColours } from '@brandspace/shared';

/** PR C — colours suggested from a logo's pixels (pure; the browser runs it). */

const pixels = (...runs: [number, [number, number, number, number]][]) => {
  const out: number[] = [];
  for (const [count, rgba] of runs) for (let i = 0; i < count; i += 1) out.push(...rgba);
  return out;
};

describe('PR C · colours from the logo', () => {
  it('the logo’s colours, most present first, as hex', () => {
    const logo = pixels(
      [600, [0x79, 0x35, 0xfe, 255]], // purple, the most
      [300, [0xff, 0xdd, 0x15, 255]], // yellow
      [100, [0x11, 0x11, 0x14, 255]], // ink
    );
    expect(logoColours(logo)).toEqual(['#7935FE', '#FFDD15', '#111114']);
  });

  it('transparent pixels and a white background are not colours', () => {
    const logo = pixels(
      [5000, [255, 255, 255, 255]],
      [5000, [0, 0, 0, 0]],
      [200, [0x79, 0x35, 0xfe, 255]],
    );
    expect(logoColours(logo)).toEqual(['#7935FE']);
  });

  it('near shades merge into one colour; a speck under 3% is left out; at most four', () => {
    const logo = pixels(
      [500, [0x79, 0x35, 0xfe, 255]],
      [500, [0x7d, 0x39, 0xf8, 255]], // the same purple, anti-aliased
      [10, [0x00, 0xad, 0xee, 255]], // a speck
      [300, [255, 0, 0, 255]],
      [300, [0, 160, 0, 255]],
      [300, [0, 0, 160, 255]],
      [300, [200, 120, 0, 255]],
    );
    const colours = logoColours(logo);
    expect(colours).toHaveLength(4);
    expect(colours[0]).toBe('#7B37FB');
    expect(colours).not.toContain('#00ADEE');
  });

  it('an empty or fully transparent logo suggests nothing', () => {
    expect(logoColours([])).toEqual([]);
    expect(logoColours(pixels([100, [10, 10, 10, 0]]))).toEqual([]);
  });
});
