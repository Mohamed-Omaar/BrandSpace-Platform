import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from '@brandspace/database';

/**
 * Environment for the end-to-end run.
 *
 * The E2E suite ALWAYS targets the test database, never the development one:
 * it signs in, activates configuration and stores secrets, and doing that to a
 * developer's working database would be a nasty surprise. `.env.test` is the
 * same file the isolation suite uses and the same one CI generates.
 *
 * `loadEnvFile` never overrides a variable already present, so CI-injected
 * values still win.
 *
 * NOTE: no `import.meta.url` here. Playwright transpiles the config and its
 * imports to CommonJS, where `import.meta` is a syntax error, so the repository
 * root is found by walking up to the workspace marker instead. This file is
 * loaded by both the Playwright config (CJS) and the seed script (ESM).
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not locate the repository root (no pnpm-workspace.yaml found above the working directory).',
  );
}

export const repoRoot = findRepoRoot();

export function loadE2eEnv(): void {
  loadEnvFile(path.join(repoRoot, '.env.test'));
}

/**
 * Where the seed writes the throwaway admin credentials it just created.
 *
 * NOT under `test-results/`: Playwright clears that directory at the start of
 * every run, which would delete the credentials before the first test read them.
 * Git-ignored, written with mode 0600, and replaced on every seed.
 */
export const E2E_CREDENTIALS_FILE = path.join(repoRoot, '.e2e-admin.json');

export interface E2eAdminCredentials {
  readonly email: string;
  readonly password: string;
  /** TOTP seed, so the test can act as the authenticator app. */
  readonly totpSecret: string;
  readonly recoveryCode: string;
}
