import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CalendarOptions } from '@brandspace/content';

/**
 * PR 0 — A CALENDAR CANNOT BE BUILT WITHOUT THE BRAND APPROVAL GATE.
 *
 * `ContentCalendarService` used to accept `approvalGate` as optional and fall
 * back to `content.calendar.requireApprovalBeforeScheduling` — a different
 * setting from the approvals default, and one that ignores the brand's own
 * `approval_policy` row. The automation worker and the Copilot's publish-now
 * both omitted it. The behaviour is proven on real PostgreSQL in
 * `tests/isolation/pr0-calendar-approval-gate.test.ts`; this file proves the
 * old shape cannot be written again.
 *
 *   1. THE TYPE: `approvalGate` is a required property. The `@ts-expect-error`
 *      below is checked by the `tests` package's `tsc` (CI's typecheck job); if
 *      the property ever becomes optional again, the directive itself fails.
 *   2. THE SOURCE: every production `new ContentCalendarService({...})` names
 *      `approvalGate`, and the calendar no longer reads the old fallback key.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

function sourceFiles(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const full = path.join(dir, entry);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) sourceFiles(full, found);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) found.push(full);
  }
  return found;
}

/** The object literal passed to each `new ContentCalendarService(`, balanced by braces. */
function constructionArguments(source: string): string[] {
  const calls: string[] = [];
  const marker = 'new ContentCalendarService(';
  let from = source.indexOf(marker);
  while (from !== -1) {
    const open = source.indexOf('{', from);
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (character === '{') depth += 1;
      if (character === '}') depth -= 1;
      if (depth === 0) break;
    }
    calls.push(source.slice(open, end + 1));
    from = source.indexOf(marker, end);
  }
  return calls;
}

describe('PR 0 — ContentCalendarService requires the brand approval gate', () => {
  it('the TYPE refuses a calendar without `approvalGate`', () => {
    // @ts-expect-error — `approvalGate` is required (PR 0). If this line ever
    // compiles, the property became optional again and `tsc` fails here.
    const missing: CalendarOptions = {
      db: undefined as never,
      workspaceId: 'w',
      policy: undefined as never,
      timezone: 'UTC',
      quota: undefined as never,
      // Batch 7 PR C: `channelGate` is required too. It is supplied here so
      // that `approvalGate` stays the ONLY thing this object lacks, and the
      // directive above keeps testing exactly that.
      channelGate: undefined as never,
    };
    expect(missing.workspaceId).toBe('w');
  });

  it('EVERY production construction site passes `approvalGate`', () => {
    const files = [
      ...sourceFiles(path.join(root, 'apps')),
      ...sourceFiles(path.join(root, 'packages')),
    ];
    const sites: { file: string; hasGate: boolean }[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const args of constructionArguments(source)) {
        sites.push({ file: path.relative(root, file), hasGate: /\bapprovalGate\s*:/.test(args) });
      }
    }

    // The four that used to omit it, and the three that already passed it.
    expect(sites.map((site) => site.file).sort()).toEqual(
      [
        'apps/api/src/routes/automation.ts',
        'apps/api/src/routes/content.ts',
        'apps/api/src/routes/copilot.ts',
        'apps/api/src/routes/copilot.ts',
        'apps/api/src/routes/copilot.ts',
        'apps/dashboard/src/server/content-context.ts',
        'apps/worker/src/processors/automation.ts',
      ].sort(),
    );
    expect(sites.filter((site) => !site.hasGate)).toEqual([]);
  });

  it('the calendar has no local approval fallback any more', () => {
    const calendar = readFileSync(path.join(root, 'packages/content/src/calendar.ts'), 'utf8');
    expect(calendar).not.toMatch(/#policy\.calendar\.requireApprovalBeforeScheduling/);
    expect(calendar).not.toMatch(/readonly approvalGate\?:/);
  });
});
