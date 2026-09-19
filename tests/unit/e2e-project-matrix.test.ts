import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY END-TO-END SPEC BELONGS TO A PROJECT — Phase 10 §26.
 *
 * WHY THIS EXISTS, and it is not hypothetical. The two viewport projects are
 * defined by an EXCLUSION list: a spec runs in them unless its name appears in
 * a long regular expression. Giving a suite its own serial project therefore
 * takes two edits — add the project, and add the name to both exclusion lists —
 * and doing only the second silently removes the suite from the run. Playwright
 * says nothing: there is no error for a file no project matches.
 *
 * That happened during Phase 10 itself. `phase9-commerce.spec.ts` was added to
 * both exclusion lists while a project was written for a different file, and the
 * entire acquisition journey stopped running. It was caught by accident, from a
 * "project not found" error on an unrelated command.
 *
 * SO THE GUARD ASKS PLAYWRIGHT ITSELF rather than parsing the config. `--list`
 * reports the tests that would actually run, which is the only answer that
 * cannot be wrong about its own configuration.
 */

const E2E_DIR = path.join(process.cwd(), 'tests', 'e2e');

/** Spec files on disk, excluding the opt-in screenshot suites. */
function specFiles(): readonly string[] {
  return readdirSync(E2E_DIR)
    .filter((name) => name.endsWith('.spec.ts'))
    .filter((name) => !name.endsWith('.screenshots.spec.ts'))
    .sort();
}

/** Playwright's own listing: which projects would run which spec files. */
function listing(): ReadonlyMap<string, ReadonlySet<string>> {
  const output = execFileSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=list'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, CI: '' },
  });
  const byFile = new Map<string, Set<string>>();
  for (const match of output.matchAll(
    /\[([^\]]+)\]\s+›\s+(?:[^›]*?)([A-Za-z0-9._-]+\.spec\.ts):/g,
  )) {
    const project = match[1] as string;
    const file = match[2] as string;
    const projects = byFile.get(file) ?? new Set<string>();
    projects.add(project);
    byFile.set(file, projects);
  }
  return byFile;
}

function listedFiles(): ReadonlySet<string> {
  return new Set(listing().keys());
}

/**
 * The two projects defined by EXCLUSION rather than by a `testMatch`.
 *
 * Everything else names the one file it runs, so these are the only two a spec
 * can end up in by accident.
 */
const GENERIC_PROJECTS = ['chromium-desktop', 'chromium-mobile'];

describe('the Playwright project matrix', () => {
  it('runs every spec file on disk', () => {
    /*
     * A file no project matches is a suite that has silently stopped running,
     * and nothing else in the build notices. The assertion names the missing
     * files so the fix is obvious: add it to a project, or remove it.
     */
    const listed = listedFiles();
    const missing = specFiles().filter((name) => !listed.has(name));
    expect(
      missing,
      `These spec files belong to no Playwright project and would never run:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  }, 120_000);

  it('never runs a spec in a dedicated project AND in the generic ones', () => {
    /*
     * THE OTHER HALF OF THE SAME EDIT, and the half that fails differently.
     *
     * Forgetting to ADD a name to the exclusion lists does not remove the
     * suite — it runs it twice, once in its own serial project and once more in
     * the viewport projects, in parallel. A suite given its own project
     * usually has one because it mutates shared state, so the second copy races
     * the first and the failure arrives as a product defect rather than as a
     * configuration mistake.
     *
     * `production-email.spec.ts` is the case that prompted this: it activates
     * an email provider in shared configuration, and the duplicate copy
     * disabled it midway through the original's journey.
     */
    const offenders: string[] = [];
    for (const [file, projects] of listing()) {
      const dedicated = [...projects].filter((name) => !GENERIC_PROJECTS.includes(name));
      const generic = [...projects].filter((name) => GENERIC_PROJECTS.includes(name));
      if (dedicated.length > 0 && generic.length > 0) {
        offenders.push(`${file} runs in ${dedicated.join(', ')} AND ${generic.join(', ')}`);
      }
    }
    expect(
      offenders,
      `Add these to BOTH viewport testIgnore lists:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  }, 120_000);

  it('lists at least the suites the phases have added', () => {
    // A sanity floor, so a broken `--list` that returns nothing cannot make the
    // assertion above pass vacuously.
    expect(listedFiles().size).toBeGreaterThanOrEqual(15);
  }, 120_000);
});
