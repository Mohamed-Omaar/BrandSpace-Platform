import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Minimal `.env` loader — the single implementation used by the Prisma config,
 * the seed, and the isolation test setup.
 *
 * Deliberately not a dependency. The original `migrate:dev` script shelled out
 * to a `dotenv` CLI that was never installed, so the documented `pnpm db:migrate`
 * failed on a clean checkout. Three separate hand-rolled copies of this loader
 * then drifted apart. One implementation, used everywhere, removes both problems.
 *
 * NEVER overrides a variable already present in the environment, so CI and
 * container-injected configuration always take precedence over a local file.
 */
export function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (key === '' || key in process.env) continue;
    process.env[key] = trimmed.slice(separator + 1).trim();
  }
}

/**
 * Which env file a process should read. `NODE_ENV=test` selects `.env.test` so a
 * test run can never migrate or seed the development database by accident.
 */
export function envFileNameForCurrentMode(): '.env' | '.env.test' {
  return process.env['NODE_ENV'] === 'test' ? '.env.test' : '.env';
}

/** Load the env file appropriate to the current mode from the repository root. */
export function loadRepoEnv(repoRoot: string): void {
  loadEnvFile(path.join(repoRoot, envFileNameForCurrentMode()));
}

/**
 * Resolve a required database URL, or fail closed.
 *
 * The error names the variable and how to set it, and NEVER includes the value of
 * any variable — a CI log or a screenshot of a failed command must not leak a
 * connection string (docs/SECURITY.md §5.1).
 */
export function requireDatabaseUrl(
  variableNames: readonly [string, ...string[]],
  context: string,
): string {
  for (const name of variableNames) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== '') return value;
  }
  const [primary] = variableNames;
  throw new Error(
    `${primary} is not set, and ${context}.\n\n` +
      `  Set it in ${envFileNameForCurrentMode()} at the repository root, or export it.\n` +
      `  Copy .env.example to .env and replace the placeholders (README, "Local development").\n\n` +
      `  ${primary} must point at the migrator role, which owns the schema.\n` +
      `  Do not use the application role here: it is NOBYPASSRLS and owns nothing, by design.\n\n` +
      `  (The value of the variable is deliberately not shown.)`,
  );
}
