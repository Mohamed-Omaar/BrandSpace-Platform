import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepoEnv } from '@brandspace/database';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/**
 * Prepare the test database once per run: apply all migrations, including the
 * row-level-security migration the isolation suite exists to verify.
 */
export default function globalSetup(): void {
  // NODE_ENV=test selects .env.test, so a test run can never migrate the
  // development database by accident.
  process.env['NODE_ENV'] = 'test';
  loadRepoEnv(repoRoot);

  if (!process.env['DATABASE_URL'] || !process.env['DATABASE_MIGRATION_URL']) {
    throw new Error(
      'Isolation tests need DATABASE_URL and DATABASE_MIGRATION_URL. ' +
        'Copy .env.test.example to .env.test (see README, "Local development"). ' +
        '(Values are deliberately not shown.)',
    );
  }

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: path.join(repoRoot, 'packages', 'database'),
    stdio: 'inherit',
    env: process.env,
  });
}
