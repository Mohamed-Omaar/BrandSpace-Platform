import { describe, expect, it } from 'vitest';
import {
  compactCount,
  deltaText,
  homeKindFor,
  sparkPath,
} from '../../apps/dashboard/src/server/home-prototype';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * D-468 — HOME, PORTED FROM `prototype-2026-09-27`.
 *
 * The prototype's own presentation formulas (`kfmt`, `delta`, `spark`) are
 * transcribed in `home-prototype.ts`; these tests pin them to the prototype's
 * outputs so a later "tidy-up" cannot drift from the specification. Which Home
 * a member gets is decided from permissions (A6), never from a role name.
 */

describe('homeKindFor — the prototype’s VA_meKind, from permissions', () => {
  it('creates AND approves: the full Home', () => {
    expect(homeKindFor(['content.create', 'content.approve'])).toBe('owner');
    expect(homeKindFor(['content.submit', 'content.approve'])).toBe('owner');
  });
  it('approves only: the review queue', () => {
    expect(homeKindFor(['content.approve', 'analytics.read'])).toBe('approver');
  });
  it('creates or submits only: my work', () => {
    expect(homeKindFor(['content.create'])).toBe('creator');
    expect(homeKindFor(['content.submit', 'analytics.read'])).toBe('creator');
  });
  it('reads analytics and nothing above: top posts', () => {
    expect(homeKindFor(['content.read', 'analytics.read'])).toBe('analyst');
  });
  it('reads only: waiting for your feedback', () => {
    expect(homeKindFor(['workspace.read', 'content.read'])).toBe('client');
    expect(homeKindFor([])).toBe('client');
  });
});

describe('compactCount — `kfmt`', () => {
  it('rounds to whole thousands from 10,000', () => {
    expect(compactCount(12400)).toBe('12K');
    expect(compactCount(10000)).toBe('10K');
    expect(compactCount(61499)).toBe('61K');
  });
  it('keeps one decimal between 1,000 and 10,000', () => {
    expect(compactCount(1240)).toBe('1.2K');
    expect(compactCount(1000)).toBe('1K');
    expect(compactCount(9950)).toBe('10K');
  });
  it('prints smaller values whole', () => {
    expect(compactCount(124)).toBe('124');
    expect(compactCount(0)).toBe('0');
  });
});

describe('deltaText — `delta(a, b)` from the analytics layer’s change', () => {
  it('reads up, down, and no baseline', () => {
    expect(deltaText(50)).toEqual({ text: '↑ +5%', tone: 'up' });
    expect(deltaText(0)).toEqual({ text: '↑ +0%', tone: 'up' });
    expect(deltaText(-80)).toEqual({ text: '↓ -8%', tone: 'down' });
    expect(deltaText(null)).toEqual({ text: '—', tone: 'none' });
  });
});

describe('sparkPath — `spark(vals)` on a 120×30 box', () => {
  it('is the prototype’s flat default when nothing was measured', () => {
    expect(sparkPath([])).toBe('M0 15 L120 15');
    expect(sparkPath([null, null])).toBe('M0 15 L120 15');
  });
  it('maps the lowest value to y = 28 and the highest to y = 2', () => {
    expect(sparkPath([0, 10])).toBe('M0 28 L120 2');
    expect(sparkPath([10, 0, 10])).toBe('M0 2 L60 28 L120 2');
  });
  it('a flat series sits on the floor (max(1, max − min) keeps it finite)', () => {
    expect(sparkPath([5, 5, 5])).toBe('M0 28 L60 28 L120 28');
  });
  it('a day with no observation is a gap, never a zero', () => {
    expect(sparkPath([0, null, 10])).toBe('M0 28 M120 2');
  });
});

describe('one Arabic for every country (round 4, Step 6 — the Egyptian layer is retired)', () => {
  it('no dashboard source imports an Arabic dialect layer, and the file is gone', async () => {
    const { existsSync, readdirSync, readFileSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../../apps/dashboard/src');
    expect(existsSync(path.join(root, 'i18n', 'ar-eg.ts'))).toBe(false);
    const readers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) {
          if (/from ['"][^'"]*ar-eg['"]/.test(readFileSync(full, 'utf8'))) readers.push(full);
        }
      }
    };
    walk(root);
    expect(readers).toEqual([]);
  });

  it('formal Arabic is the one Arabic dictionary', () => {
    expect(Object.keys(messages.ar).length).toBeGreaterThan(1000);
  });
});
