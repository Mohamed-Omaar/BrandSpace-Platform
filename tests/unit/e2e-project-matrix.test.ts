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

/** The files Playwright says it would run, from its own listing. */
function listedFiles(): ReadonlySet<string> {
  const output = execFileSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=list'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, CI: '' },
  });
  const files = new Set<string>();
  for (const match of output.matchAll(/›\s+([A-Za-z0-9._-]+\.spec\.ts):/g)) {
    files.add(match[1] as string);
  }
  return files;
}

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

  it('lists at least the suites the phases have added', () => {
    // A sanity floor, so a broken `--list` that returns nothing cannot make the
    // assertion above pass vacuously.
    expect(listedFiles().size).toBeGreaterThanOrEqual(15);
  }, 120_000);
});
