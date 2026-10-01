import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { workspaceMonthLabel, workspaceMonthWindow } from '@brandspace/entitlements';

/**
 * PHASE 2B-3 PR 6 — THE WORKSPACE-LOCAL MONTH THE AI CAP COUNTS IN (D-460).
 *
 * Every instant below is fixed. The label is the workspace's own calendar
 * month; the window is that label's UTC anchors, so DST cannot move it.
 */

const at = (iso: string) => new Date(iso);

describe('workspaceMonthLabel', () => {
  it('Riyadh (UTC+3) is already in November at 21:30 UTC on 31 October', () => {
    expect(workspaceMonthLabel('Asia/Riyadh', at('2026-10-31T20:59:59.000Z'))).toBe('2026-10');
    expect(workspaceMonthLabel('Asia/Riyadh', at('2026-10-31T21:00:00.000Z'))).toBe('2026-11');
  });

  it('Los Angeles crosses into November at local midnight, on the night DST ends', () => {
    // 2026-11-01 00:00 PDT is 07:00 UTC; DST ends at 02:00 local that night.
    expect(workspaceMonthLabel('America/Los_Angeles', at('2026-11-01T06:59:59.000Z'))).toBe(
      '2026-10',
    );
    expect(workspaceMonthLabel('America/Los_Angeles', at('2026-11-01T07:00:00.000Z'))).toBe(
      '2026-11',
    );
    expect(workspaceMonthLabel('America/Los_Angeles', at('2026-11-01T10:00:00.000Z'))).toBe(
      '2026-11',
    );
  });

  it('Kiritimati (UTC+14) starts the new year first', () => {
    expect(workspaceMonthLabel('Pacific/Kiritimati', at('2026-12-31T09:59:59.000Z'))).toBe(
      '2026-12',
    );
    expect(workspaceMonthLabel('Pacific/Kiritimati', at('2026-12-31T10:00:00.000Z'))).toBe(
      '2027-01',
    );
  });

  it('UTC, and an unknown zone read as UTC', () => {
    expect(workspaceMonthLabel('UTC', at('2026-03-01T00:00:00.000Z'))).toBe('2026-03');
    expect(workspaceMonthLabel('Not/AZone', at('2026-02-28T23:59:59.000Z'))).toBe('2026-02');
  });
});

describe('workspaceMonthWindow', () => {
  it('anchors the label at UTC midnight on the 1st, through the year end', () => {
    expect(workspaceMonthWindow('2026-10')).toEqual({
      start: at('2026-10-01T00:00:00.000Z'),
      end: at('2026-11-01T00:00:00.000Z'),
    });
    expect(workspaceMonthWindow('2026-12')).toEqual({
      start: at('2026-12-01T00:00:00.000Z'),
      end: at('2027-01-01T00:00:00.000Z'),
    });
  });

  it('refuses anything that is not YYYY-MM', () => {
    for (const bad of ['2026-13', '2026-1', '26-10', '2026-10-01', '']) {
      expect(() => workspaceMonthWindow(bad), bad).toThrow();
    }
  });
});

describe('no caller builds the window by hand', () => {
  it('only the helper names the cap feature together with billing_cycle', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
      }
    };
    walk(path.join(root, 'apps'));
    walk(path.join(root, 'packages'));
    const offenders = files.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return (
        /AUTOMATION_AI_ACTIONS_FEATURE|limit\.automation_ai_actions/.test(source) &&
        /period:\s*'billing_cycle'/.test(source) &&
        !file.endsWith(path.join('entitlements', 'src', 'automation-ai-quota.ts'))
      );
    });
    expect(offenders).toEqual([]);
  });
});
