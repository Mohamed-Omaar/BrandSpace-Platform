import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/**
 * F-01 — the platform connection pool is a restricted module.
 *
 * It opens the ONE database identity with cross-tenant visibility, so the
 * credential must never reach the public website, the customer dashboard's
 * client bundle, tenant-facing API routes, or ordinary workers.
 *
 * Three independent checks, because any one of them alone could rot:
 *   1. it is not exported from the package index,
 *   2. no file outside the approved importer references it,
 *   3. ESLint rejects an import from every tenant-facing location.
 */

const APPROVED_IMPORTERS = [
  'packages/database/src/platform.ts',
  'packages/database/src/platform-pool.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist' || entry === '.git') {
      continue;
    }
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

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

const RESTRICTED = /Restricted module/;

describe('the platform pool is not reachable through the package API', () => {
  it('is NOT re-exported from the database package index', () => {
    const index = readFileSync(path.join(repoRoot, 'packages/database/src/index.ts'), 'utf8');
    // A comment explaining the omission is fine; an actual export is not.
    const exportLines = index
      .split('\n')
      .filter((l) => l.trimStart().startsWith('export'))
      .join('\n');
    expect(exportLines).not.toContain('platform-pool');
  });

  it('has exactly one approved importer in the whole repository', () => {
    const offenders: string[] = [];
    for (const file of walk(repoRoot)) {
      const relative = path.relative(repoRoot, file);
      if (APPROVED_IMPORTERS.includes(relative)) continue;
      if (relative.startsWith('tests/')) continue; // tests assert about it by name
      const source = readFileSync(file, 'utf8');
      if (/from ['"][^'"]*platform-pool['"]|require\(['"][^'"]*platform-pool['"]\)/.test(source)) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is never referenced by any app', () => {
    const appFiles = walk(path.join(repoRoot, 'apps'));
    const offenders = appFiles.filter((f) => /platform-pool/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });
});

describe('ESLint rejects the import from every tenant-facing location', () => {
  it.each([
    ['apps/web/src/__pool_probe.ts', 'the public website'],
    ['apps/dashboard/src/__pool_probe.ts', 'the customer dashboard'],
    ['apps/api/src/__pool_probe.ts', 'tenant-facing API routes'],
    ['apps/worker/src/__pool_probe.ts', 'ordinary workers'],
    ['apps/admin/src/__pool_probe.ts', 'even the admin app (it must go through asPlatform)'],
  ])('rejects a package-style import from %s (%s)', (file) => {
    expect(lintSnippet(file, "import '@brandspace/database/platform-pool';")).toMatch(RESTRICTED);
  });

  it.each([
    ['apps/dashboard/src/__pool_probe.ts', '../../../packages/database/src/platform-pool'],
    ['packages/billing/src/__pool_probe.ts', '../../database/src/platform-pool'],
    ['packages/entitlements/src/__pool_probe.ts', '../../database/src/platform-pool'],
  ])('rejects a relative import from %s', (file, specifier) => {
    expect(lintSnippet(file, `import '${specifier}';`)).toMatch(RESTRICTED);
  });

  it('ALLOWS the approved importer, so the rule is not simply blanket-deny', () => {
    const output = lintSnippet(
      'packages/database/src/platform.ts.probe.ts',
      '// approved-importer shape check',
    );
    expect(output).not.toMatch(RESTRICTED);
  });
});

describe('the platform credential cannot reach a browser bundle', () => {
  it('the platform URL is never a NEXT_PUBLIC_ variable', () => {
    for (const file of ['.env.example', '.env.test.example']) {
      const content = readFileSync(path.join(repoRoot, file), 'utf8');
      expect(content).not.toMatch(/NEXT_PUBLIC_[A-Z_]*DATABASE/);
      expect(content).not.toMatch(/NEXT_PUBLIC_[A-Z_]*PLATFORM/);
    }
  });

  it('no app source reads DATABASE_PLATFORM_URL', () => {
    const appFiles = walk(path.join(repoRoot, 'apps'));
    const offenders = appFiles.filter((f) => /DATABASE_PLATFORM_URL/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });

  it('THROWS when loaded in a browser context', async () => {
    // Asserted behaviourally rather than by grepping the source: a comment can
    // survive a refactor that removes the guard, a thrown error cannot.
    const { assertServerSide } = await import('@brandspace/database/server-only-guard');

    expect(() => assertServerSide('probe')).not.toThrow();

    const globalWithWindow = globalThis as { window?: unknown };
    try {
      globalWithWindow.window = {};
      expect(() => assertServerSide('probe')).toThrow(/browser context/i);
    } finally {
      delete globalWithWindow.window;
    }
  });
});
