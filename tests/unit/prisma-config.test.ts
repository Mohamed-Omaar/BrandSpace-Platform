import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const databasePackage = path.join(repoRoot, 'packages', 'database');

/**
 * Clean-environment regression tests for the Prisma CLI configuration.
 *
 * These exist because `prisma.config.ts` resolved `env('DATABASE_MIGRATION_URL')`
 * eagerly at module load. `prisma generate` does not connect to a database, but
 * loading the config threw when the variable was unset — so generation failed on
 * every clean checkout and took three CI jobs down with it.
 *
 * It passed locally only because the developer shell had `.env` exported, which
 * masked the dependency entirely. Every test here therefore runs with a SCRUBBED
 * environment: no inherited variables at all. That is the property the original
 * verification lacked, so it is the property asserted here.
 */

/**
 * An environment with NOTHING inherited except what is needed to launch a process.
 *
 * PATH and HOME are preserved deliberately. PATH is not what these tests
 * constrain — inherited DATABASE_* configuration is — and hardcoding a PATH makes
 * the suite non-portable: CI installs pnpm under PNPM_HOME
 * (/home/runner/setup-pnpm/...), so a fabricated PATH cannot find it and every
 * spawn fails with ENOENT instead of exercising Prisma at all.
 *
 * `assertNoDatabaseVars` below proves the scrubbing is real.
 */
function scrubbedEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const nodeDir = path.dirname(process.execPath);
  const inheritedPath = process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin';
  return {
    PATH: `${nodeDir}:${inheritedPath}`,
    HOME: process.env['HOME'] ?? '/root',
    ...overrides,
  };
}

function assertNoDatabaseVars(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    expect(key, `${key} must not leak into a clean-environment test`).not.toMatch(
      /DATABASE|POSTGRES|PG/i,
    );
  }
}

interface RunResult {
  code: number;
  output: string;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): RunResult {
  try {
    const output = execFileSync(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    });
    return { code: 0, output };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** Exactly how CI invokes Prisma, so the test exercises the real command path. */
function runPrisma(args: string[], cwd: string, env: NodeJS.ProcessEnv): RunResult {
  return run('pnpm', ['exec', 'prisma', ...args], cwd, env);
}

/**
 * Invoke the Prisma CLI directly. Used for the sandbox, which lives outside the
 * pnpm workspace on purpose and therefore has no package for `pnpm exec` to find.
 */
const PRISMA_ENTRYPOINT = path.join(databasePackage, 'node_modules', 'prisma', 'build', 'index.js');

function runPrismaDirect(args: string[], cwd: string, env: NodeJS.ProcessEnv): RunResult {
  return run(process.execPath, [PRISMA_ENTRYPOINT, ...args], cwd, env);
}

/**
 * THE GENERATED CLIENT EVERY OTHER TEST IMPORTS.
 *
 * Resolved through Node rather than written down, because the path contains
 * pnpm's content hash and changes with every dependency bump.
 */
function sharedClientDirectory(): string {
  const require_ = createRequire(path.join(databasePackage, 'index.js'));
  return path.join(path.dirname(require_.resolve('@prisma/client')), '..', '..', '.prisma/client');
}

/**
 * A schema that generates SOMEWHERE ELSE.
 *
 * WHY THIS EXISTS — THE DEFECT IT CLOSES (F-91).
 *
 * `prisma generate` REWRITES THE SHARED GENERATED CLIENT IN PLACE. Watching
 * that directory through a run shows it torn down and rebuilt on the same
 * inode, passing through states with as few as four files in it — and, for
 * hundreds of consecutive samples, with NO `package.json` and NO `default.js`.
 *
 * `@prisma/client/default.js` is one line: `require('.prisma/client/default')`.
 * Resolving that subpath reads `.prisma/client/package.json` for its `exports`
 * map. So while this test regenerates, any OTHER unit test file whose module
 * graph loads `@prisma/client` fails at IMPORT with
 *
 *     Error: Cannot find module '.prisma/client/default'
 *
 * which is precisely how CI failed `tests/unit/brand-brain-policy.test.ts` on
 * run 244. Nothing was wrong with that file: Vitest loads test files in
 * parallel, and it was the one holding the door when this test pulled the floor
 * out. Locally the race is usually won; a loaded CI runner loses it. The
 * failure therefore moves between files and looks like flake, which is the
 * worst property a failure can have.
 *
 * THE FIX IS NOT TO STOP GENERATING — that is the whole assertion. It is to
 * generate into a throwaway directory, so the command under test is the same
 * command and the shared client is not collateral.
 *
 * The temporary tree lives INSIDE the package on purpose: the generator
 * resolves `@prisma/client` relative to its own output, and a directory under
 * /tmp is outside every `node_modules` and fails with "Could not resolve
 * @prisma/client" — a failure of the harness that would read as a failure of
 * the thing under test.
 */
function schemaGeneratingTo(outputDirectory: string): string {
  const source = readFileSync(path.join(databasePackage, 'prisma', 'schema.prisma'), 'utf8');
  const generated = source.replace(
    /generator client \{([^}]*)\}/,
    (_match, body: string) =>
      `generator client {${body}  output   = "${outputDirectory}/client"\n}`,
  );
  // A replacement that silently matched nothing would generate to the SHARED
  // client and reintroduce the exact race this guards against.
  expect(generated, 'the generator block was not rewritten').toContain(outputDirectory);
  const schemaPath = path.join(outputDirectory, 'schema.prisma');
  writeFileSync(schemaPath, generated, 'utf8');
  return schemaPath;
}

describe('prisma generate in a clean environment', () => {
  it('inherits no database variables in the test environment itself', () => {
    assertNoDatabaseVars(scrubbedEnv());
  });

  it('SUCCEEDS with no database environment at all', () => {
    // The exact failure from CI: generate must not require a connection string.
    const scratch = mkdtempSync(path.join(databasePackage, '.tmp-generate-'));
    try {
      const result = runPrisma(
        ['generate', '--schema', schemaGeneratingTo(scratch)],
        databasePackage,
        scrubbedEnv(),
      );
      // Guard against a false pass: if the command could not be spawned at all we
      // would see empty output, which must not be mistaken for success.
      expect(result.output.trim()).not.toBe('');
      expect(result.output).not.toContain('Cannot resolve environment variable');
      expect(result.output).not.toContain('PrismaConfigEnvError');
      // The harness failure that would otherwise masquerade as the real one.
      expect(result.output).not.toContain('Could not resolve @prisma/client');
      /*
       * NO ASSERTION ON "Loaded Prisma config from prisma.config.ts". Prisma
       * writes that line to STDERR, and `run()` returns stderr only on failure
       * — so asserting it here would fail on a perfectly good run. It would
       * also be redundant: a config that threw for a missing variable is
       * exactly what makes this command exit non-zero, which is what the
       * assertion above already pins.
       */
      expect(result.code).toBe(0);
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });

  it('does not disturb the generated client the rest of the suite imports (F-91)', () => {
    /*
     * THE REGRESSION GUARD FOR THE RACE ITSELF, asserted on the filesystem
     * rather than on the command's own words. If somebody later drops the
     * `--schema` redirection for tidiness, this fails here instead of surfacing
     * a fortnight later as an unrelated test file that cannot find a module.
     *
     * `package.json` is the file watched because it is the one whose absence
     * breaks `require('.prisma/client/default')` — the exports map lives in it.
     */
    const marker = path.join(sharedClientDirectory(), 'package.json');
    const before = statSync(marker).mtimeMs;

    const scratch = mkdtempSync(path.join(databasePackage, '.tmp-generate-'));
    try {
      const result = runPrisma(
        ['generate', '--schema', schemaGeneratingTo(scratch)],
        databasePackage,
        scrubbedEnv(),
      );
      expect(result.code).toBe(0);
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }

    expect(statSync(marker).mtimeMs, 'generate rewrote the shared client').toBe(before);
  });

  it('SUCCEEDS for `validate`, which is also an offline command', () => {
    const result = runPrisma(['validate'], databasePackage, scrubbedEnv());
    expect(result.code).toBe(0);
  });
});

describe('commands that connect fail closed', () => {
  // A tree with no .env anywhere, so the loader finds nothing to fall back on.
  // Created OUTSIDE the repository so no stray .env up the directory tree — and
  // no pnpm workspace resolution — can influence the result.
  const sandbox = mkdtempSync(path.join(tmpdir(), 'brandspace-clean-env-'));
  const sandboxPackage = path.join(sandbox, 'packages', 'database');

  afterAll(() => {
    rmSync(sandbox, { force: true, recursive: true });
  });

  function buildSandbox(): void {
    rmSync(sandboxPackage, { force: true, recursive: true });
    mkdirSync(path.join(sandboxPackage, 'prisma'), { recursive: true });
    cpSync(
      path.join(databasePackage, 'prisma.config.ts'),
      path.join(sandboxPackage, 'prisma.config.ts'),
    );
    cpSync(path.join(databasePackage, 'src'), path.join(sandboxPackage, 'src'), {
      recursive: true,
    });
    cpSync(
      path.join(databasePackage, 'prisma', 'schema.prisma'),
      path.join(sandboxPackage, 'prisma', 'schema.prisma'),
    );
    symlinkSync(
      path.join(databasePackage, 'node_modules'),
      path.join(sandboxPackage, 'node_modules'),
    );
  }

  it('`migrate status` fails with a clear, actionable error when no URL is configured', () => {
    buildSandbox();
    const result = runPrismaDirect(['migrate', 'status'], sandboxPackage, scrubbedEnv());

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('DATABASE_MIGRATION_URL is not set');
    // Actionable: it says what to do, not merely that something is wrong.
    expect(result.output).toContain('.env.example');
    expect(result.output).toContain('migrator role');
  });

  it('never prints the value of any variable in the failure message', () => {
    buildSandbox();
    const secret = 'postgresql://leaked_user:leaked_password@db.internal:5432/prod';
    // A DIFFERENT variable holds a connection string: the error must not echo the
    // environment back to the user, only name the variable it needs.
    const result = runPrismaDirect(
      ['migrate', 'status'],
      sandboxPackage,
      scrubbedEnv({ SOME_OTHER_DATABASE_DSN: secret }),
    );

    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain('leaked_password');
    expect(result.output).not.toContain('leaked_user');
    expect(result.output).not.toContain(secret);
    expect(result.output).toContain('deliberately not shown');
  });

  it('does NOT silently fall back to a default database', () => {
    buildSandbox();
    const result = runPrismaDirect(['migrate', 'status'], sandboxPackage, scrubbedEnv());
    // The whole point of failing closed: no connection is attempted at all.
    expect(result.output).not.toMatch(/Datasource "db": PostgreSQL database/);
    expect(result.code).not.toBe(0);
  });
});

describe('environment precedence', () => {
  it('an explicitly exported variable wins over the .env file', () => {
    // The loader must never override configuration injected by CI or a container.
    const explicit = 'postgresql://explicit_role:explicit_pw@explicit-host:5432/explicit_db';
    const result = runPrisma(
      ['migrate', 'status'],
      databasePackage,
      scrubbedEnv({ DATABASE_MIGRATION_URL: explicit, NODE_ENV: 'development' }),
    );
    // It will fail to reach that host, which is precisely the proof that the
    // exported value was used rather than the local .env.
    expect(result.output).toMatch(/explicit-host|P1001/);
  });
});
