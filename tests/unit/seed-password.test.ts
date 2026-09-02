import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MIN_SEED_PASSWORD_LENGTH,
  assertUsableSeedPassword,
  resolveSeedPassword,
} from '../../packages/database/prisma/seed-password';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/**
 * Regression suite for the independent security review — finding 4.
 *
 * The seed fell back to a literal password when `SEED_PLATFORM_PASSWORD` was
 * unset. A password in source control is a known credential for every database
 * the seed is ever pointed at, and nothing stopped it being pointed at
 * something that mattered.
 */

describe('the seed refuses to invent a password', () => {
  it('has no hard-coded fallback anywhere in the seed', () => {
    const seed = readFileSync(path.join(repoRoot, 'packages/database/prisma/seed.ts'), 'utf8');
    expect(seed).not.toContain('brandspace-dev-owner-2026');
    // No `?? '...'` default on the variable, in any spelling.
    expect(seed).not.toMatch(/SEED_PLATFORM_PASSWORD'?\]?\s*\?\?\s*['"`]/);
  });

  it('returns null when the variable is absent, so no credential is created', () => {
    expect(resolveSeedPassword({})).toBeNull();
  });

  it('rejects an empty value', () => {
    expect(() => resolveSeedPassword({ SEED_PLATFORM_PASSWORD: '   ' })).toThrow(/empty/i);
  });

  it('rejects a value shorter than the minimum', () => {
    const short = 'a'.repeat(MIN_SEED_PASSWORD_LENGTH - 1);
    expect(() => resolveSeedPassword({ SEED_PLATFORM_PASSWORD: short })).toThrow(
      new RegExp(`${MIN_SEED_PASSWORD_LENGTH} characters`),
    );
  });

  it.each([
    'REPLACE_WITH_A_STRONG_LOCAL_ONLY_VALUE',
    'replace-with-something-better',
    'changeme-changeme-changeme',
    'this-is-a-placeholder-value',
    'example-password-for-testing',
    'brandspace-dev-owner-2026-x',
    'TODO-pick-a-real-password',
  ])('rejects the placeholder %s', (value) => {
    expect(() => assertUsableSeedPassword(value)).toThrow(/placeholder/i);
  });

  it('accepts a strong, non-placeholder value', () => {
    const good = 'q7Zt-Marmalade-Turbine-91xx';
    expect(resolveSeedPassword({ SEED_PLATFORM_PASSWORD: good })).toBe(good);
  });

  it('NEVER puts the rejected value in the error message', () => {
    const secretish = 'hunter2-hunter2-changeme-hunter2';
    const message = (() => {
      try {
        assertUsableSeedPassword(secretish);
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();

    expect(message).not.toBe('');
    expect(message).not.toContain(secretish);
    expect(message).not.toContain('hunter2');
  });

  it('never puts a short value in the error message either', () => {
    const short = 'tiny-secret';
    const message = (() => {
      try {
        assertUsableSeedPassword(short);
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(message).not.toContain(short);
  });
});

/**
 * Composed at runtime on purpose. If this file spelled the assignment out as a
 * literal, the repository-wide scan below would match its own source and read
 * the tail of a regular expression as a committed password. Composing it keeps
 * the scan honest: it covers every tracked file, this one included, with no
 * exclusion list to hide a credential behind.
 */
const VARIABLE = ['SEED', 'PLATFORM', 'PASSWORD'].join('_');
const ASSIGNMENT = new RegExp(`${VARIABLE}=(.+)$`);

describe('the example environment files carry a placeholder only', () => {
  it.each(['.env.example', '.env.test.example'])('%s documents but does not set it', (file) => {
    const content = readFileSync(path.join(repoRoot, file), 'utf8');
    expect(content).toContain(VARIABLE);

    // Every occurrence must be commented out, and must not be usable.
    for (const line of content.split('\n')) {
      if (!line.includes(`${VARIABLE}=`)) continue;
      expect(line.trimStart().startsWith('#')).toBe(true);
      const value = line.slice(line.indexOf('=') + 1).trim();
      expect(() => assertUsableSeedPassword(value)).toThrow();
    }
  });
});

describe('no working credential is tracked in the repository', () => {
  it(`finds no committed ${VARIABLE} with a usable value`, () => {
    const tracked = execFileSync('git', ['grep', '-nI', VARIABLE, '--', '.'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    // The scan must actually see the repository; an empty result would pass
    // vacuously and hide a regression in the scan itself.
    expect(tracked).toContain('.env.example');
    expect(tracked).toContain(path.relative(repoRoot, fileURLToPath(import.meta.url)));

    for (const line of tracked.split('\n')) {
      const match = ASSIGNMENT.exec(line);
      if (!match) continue;
      // A tracked assignment is only acceptable if the value would be refused.
      const value = match[1]!.trim();
      expect(
        () => assertUsableSeedPassword(value),
        `${line} assigns a value the seed would accept`,
      ).toThrow();
    }
  });
});
