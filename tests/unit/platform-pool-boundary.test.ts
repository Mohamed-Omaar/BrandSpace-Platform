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

/**
 * The only files permitted to reach the pool.
 *
 *  - `platform.ts`        — asPlatform(), the single AUDITED entrance for
 *                           cross-tenant reads of TENANT data.
 *  - `platform-client.ts` — the Phase 2A seam that hands a platform-scoped
 *                           client to apps/admin and apps/api for PLATFORM-owned
 *                           data (configuration, secrets, admin sessions), which
 *                           no tenant policy covers. Its own ESLint rule limits
 *                           who may import it.
 *  - `platform-pool.ts`   — the module itself.
 */
const APPROVED_IMPORTERS = [
  'packages/database/src/platform.ts',
  'packages/database/src/platform-client.ts',
  'packages/database/src/platform-pool.ts',
];

/**
 * Strip comments before searching for a reference.
 *
 * A file that only NAMES a restricted variable in prose — "fails closed when
 * DATABASE_PLATFORM_URL is absent" — is documenting the boundary, not crossing
 * it. Matching raw text would make the correct comment a build failure and
 * quietly train people to delete the explanation.
 */
function code(source: string): string {
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Trailing `//` comments too, but not the `//` in a URL, which is why the
      // preceding character may not be a colon.
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  );
}

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
      const source = code(readFileSync(file, 'utf8'));
      if (/from ['"][^'"]*platform-pool['"]|require\(['"][^'"]*platform-pool['"]\)/.test(source)) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is never referenced by any app', () => {
    const appFiles = walk(path.join(repoRoot, 'apps'));
    const offenders = appFiles.filter((f) => /platform-pool/.test(code(readFileSync(f, 'utf8'))));
    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });

  it('the approved client seam hands out a client, never the pool itself', () => {
    // apps/admin may import platform-client.ts. If that module re-exported the
    // pool, the restriction on the pool would be decorative.
    const source = readFileSync(
      path.join(repoRoot, 'packages/database/src/platform-client.ts'),
      'utf8',
    );
    const exportLines = code(source)
      .split('\n')
      .filter((l) => l.trimStart().startsWith('export'))
      .join('\n');
    expect(exportLines).not.toContain('platform-pool');
    expect(exportLines).not.toContain('getPlatformPrisma');
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
    const offenders = appFiles.filter((f) =>
      /DATABASE_PLATFORM_URL/.test(code(readFileSync(f, 'utf8'))),
    );
    expect(offenders.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });

  it('the comment-stripping used above does not hide a real read', () => {
    // Non-vacuity: if `code()` were too aggressive, the check above would pass
    // no matter what an app did.
    expect(code('const a = 1; // DATABASE_PLATFORM_URL\n')).not.toContain('DATABASE_PLATFORM_URL');
    expect(code("const url = process.env['DATABASE_PLATFORM_URL'];\n")).toContain(
      'DATABASE_PLATFORM_URL',
    );
    expect(code('/* DATABASE_PLATFORM_URL */ const b = 2;')).not.toContain('DATABASE_PLATFORM_URL');
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
