import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/** Minimal .env parser — avoids a dependency for something this small. */
function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

/**
 * Prepare the test database once per run: apply all migrations, including the
 * row-level-security migration the isolation suite exists to verify.
 */
export default function globalSetup(): void {
  loadEnvFile(path.join(repoRoot, '.env.test'));

  if (!process.env['DATABASE_URL'] || !process.env['DATABASE_MIGRATION_URL']) {
    throw new Error(
      'Isolation tests need DATABASE_URL and DATABASE_MIGRATION_URL. ' +
        'Copy .env.test.example to .env.test (see README §Local development).',
    );
  }

  const databasePackage = path.join(repoRoot, 'packages', 'database');
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: databasePackage,
    stdio: 'inherit',
    env: process.env,
  });
}
