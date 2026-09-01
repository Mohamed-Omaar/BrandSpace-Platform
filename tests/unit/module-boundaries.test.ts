import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/**
 * Module boundary enforcement — docs/ARCHITECTURE.md §4.1.
 *
 * These tests exist because the boundary rules were, at one point, silently NOT
 * enforced: in ESLint flat config a later block setting the same rule replaces it
 * entirely, so a separate `no-restricted-imports` block wiped the boundary
 * patterns. Lint passed and every violation was allowed.
 *
 * A lint rule nobody has watched fail is not known to work, so each boundary is
 * asserted in both directions: forbidden imports are rejected, permitted ones are
 * not.
 */

function lintSnippet(relativeFile: string, source: string): string {
  const absolute = path.join(repoRoot, relativeFile);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${source}\nexport const probe = 1;\n`);
  try {
    execFileSync('pnpm', ['eslint', relativeFile], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return '';
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  } finally {
    rmSync(absolute, { force: true });
  }
}

const VIOLATION = /Module boundary violation|Only packages\/database/;

describe('forbidden imports are rejected', () => {
  it.each([
    [
      'packages/shared/src/__boundary_probe.ts',
      "import '@brandspace/billing';",
      'shared may import nothing',
    ],
    [
      'packages/config/src/__boundary_probe.ts',
      "import '@brandspace/billing';",
      'config may not import billing',
    ],
    [
      'packages/billing/src/__boundary_probe.ts',
      "import '@brandspace/ai-gateway';",
      'sibling domain packages',
    ],
    [
      'packages/config/src/__boundary_probe.ts',
      "import '@brandspace/worker';",
      'a package may not import an app',
    ],
    [
      'packages/entitlements/src/__boundary_probe.ts',
      "import '@prisma/client';",
      'direct Prisma outside database',
    ],
    ['apps/api/src/__boundary_probe.ts', "import 'pg';", 'direct pg connection from an app'],
    [
      'apps/web/src/__boundary_probe.ts',
      "import '@brandspace/admin';",
      'an app may not import another app',
    ],
  ])('rejects %s (%s)', (file, source) => {
    expect(lintSnippet(file, source)).toMatch(VIOLATION);
  });
});

describe('permitted imports are allowed', () => {
  it.each([
    [
      'packages/entitlements/src/__boundary_probe.ts',
      "import '@brandspace/config';",
      'declared in the allowlist',
    ],
    [
      'packages/database/src/__boundary_probe.ts',
      "import '@prisma/client';",
      'database is the one DB exception',
    ],
    [
      'apps/api/src/__boundary_probe.ts',
      "import '@brandspace/database';",
      'apps may use any package',
    ],
  ])('allows %s (%s)', (file, source) => {
    expect(lintSnippet(file, source)).not.toMatch(VIOLATION);
  });
});
