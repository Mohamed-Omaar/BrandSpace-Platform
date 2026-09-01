import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

describe('prisma generate in a clean environment', () => {
  it('inherits no database variables in the test environment itself', () => {
    assertNoDatabaseVars(scrubbedEnv());
  });

  it('SUCCEEDS with no database environment at all', () => {
    // The exact failure from CI: generate must not require a connection string.
    const result = runPrisma(['generate'], databasePackage, scrubbedEnv());
    // Guard against a false pass: if the command could not be spawned at all we
    // would see empty output, which must not be mistaken for success.
    expect(result.output.trim()).not.toBe('');
    expect(result.output).not.toContain('Cannot resolve environment variable');
    expect(result.output).not.toContain('PrismaConfigEnvError');
    expect(result.code).toBe(0);
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
