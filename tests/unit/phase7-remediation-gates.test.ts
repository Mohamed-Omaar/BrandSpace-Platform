import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * TWO SOURCE GATES FOR TWO DEFECTS THAT WERE WRITTEN AS LITERALS.
 *
 * WHY A SCANNER RATHER THAN A TEST PER CALL SITE. Both defects below were
 * present at MORE THAN ONE call site, each with a comment asserting the opposite
 * of what the code did — "the calendar re-checks anyway" beside a value that
 * turned the check off, "the quota is real" above three methods that did
 * nothing. A test per site catches the sites that exist; this catches the next
 * one, which is the one that matters. The D-132 predicate gate is the precedent.
 *
 * NEITHER GATE REPLACES A BEHAVIOURAL TEST. `tests/isolation/phase7-remediation`
 * proves what the code now does; these prove nobody can write the old thing
 * again without a reviewer seeing a failure.
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
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Strip block and line comments.
 *
 * The rules below are about CODE. Every one of these defects is documented in a
 * comment near where it used to be, and a gate that matched prose would fail on
 * its own explanation.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const SCANNED = [
  ...sourceFiles(path.join(root, 'packages')),
  ...sourceFiles(path.join(root, 'apps')),
];

describe('P7-R3: an empty BrandScope is never written as a substitute for authorization', () => {
  it('finds the source it is supposed to be checking', () => {
    // A gate that silently matches nothing passes for ever.
    const mentioning = SCANNED.filter((file) => read(file)?.includes('actorBrandScope'));
    expect(mentioning.length).toBeGreaterThan(3);
  });

  it('no call site passes a literal empty brand scope', () => {
    /*
     * EMPTY MEANS UNRESTRICTED on this platform, so `actorBrandScope: []` does
     * not "re-check anyway" — it switches the brand check OFF. It appeared at
     * two call sites, and both were the publish path: the single action in the
     * product that leaves the platform and cannot be undone.
     */
    const offenders: string[] = [];
    for (const file of SCANNED) {
      const text = read(file);
      if (text === null) continue;
      for (const match of code(text).matchAll(/actorBrandScope\s*:\s*\[\s*\]/g)) {
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push(`${path.relative(root, file)}:${line}`);
      }
    }
    expect(
      offenders,
      'pass the caller’s LIVE brandScope; empty means UNRESTRICTED, not "already checked"',
    ).toEqual([]);
  });
});

describe('P7-R6: every calendar in an app gets the SHARED scheduling quota', () => {
  const calendarSites = SCANNED.filter(
    (file) =>
      file.includes(`${path.sep}apps${path.sep}`) &&
      read(file)?.includes('new ContentCalendarService('),
  );

  it('finds the app call sites it is supposed to be checking', () => {
    expect(calendarSites.length).toBeGreaterThan(0);
  });

  it('no app builds its own quota adapter', () => {
    /*
     * THE DEFECT. `apps/worker` supplied `limit: () => null`, `consume: () =>
     * true` and a `refund` that did nothing, under a comment stating that the
     * quota was real — so a rule could schedule past the plan's monthly ceiling
     * and counted nothing while doing it. It did that because the only
     * implementation lived inside `apps/api/src/routes`, where the worker could
     * not reach it; the implementation now lives in `@brandspace/entitlements`.
     *
     * THE RULE: in an app, the `quota:` a calendar receives is a CALL, never an
     * object literal.
     */
    const offenders: string[] = [];
    for (const file of calendarSites) {
      const text = read(file);
      /* c8 ignore next -- the list was built from files that read cleanly. */
      if (text === null) continue;
      const stripped = code(text);
      for (const match of stripped.matchAll(/quota\s*:\s*\{/g)) {
        const line = stripped.slice(0, match.index).split('\n').length;
        offenders.push(`${path.relative(root, file)}:~${line}`);
      }
      // And every `quota:` that IS a call names one of the two shared helpers.
      for (const match of stripped.matchAll(/quota\s*:\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = match[1];
        if (name === 'scheduleQuota' || name === 'createScheduleQuota') continue;
        const line = stripped.slice(0, match.index).split('\n').length;
        offenders.push(`${path.relative(root, file)}:~${line} — ${String(name)}()`);
      }
    }
    expect(
      offenders,
      'use createScheduleQuota (or the app’s scheduleQuota binding); a hand-written quota is a bypass',
    ).toEqual([]);
  });
});
