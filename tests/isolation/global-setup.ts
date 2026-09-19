import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
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

  warnIfQueueUnreachable();
}

/**
 * Say so, loudly, when Redis is configured and not there.
 *
 * WHY THIS IS WORTH A FUNCTION. Several suites dispatch a background job and
 * assert on what the worker did with it. With `REDIS_URL` set and nothing
 * listening, the client does not fail fast — it retries — so each of those
 * tests burns its full sixty- or ninety-second ceiling and the run reports a
 * timeout with no cause. In Phase 10 that turned a three-minute suite into a
 * seventeen-minute one with five files "failing", and it read exactly like a
 * regression in the code under test.
 *
 * It WARNS rather than throwing. A developer running one isolation file that
 * touches no queue should not be blocked by a service that file does not use,
 * and CI runs a Redis service so this never fires there.
 */
function warnIfQueueUnreachable(): void {
  const url = process.env['REDIS_URL'];
  if (!url) return;
  let host = '127.0.0.1';
  let port = 6379;
  try {
    const parsed = new URL(url);
    host = parsed.hostname || host;
    port = parsed.port ? Number(parsed.port) : port;
  } catch {
    return;
  }

  const socket = connect({ host, port });
  socket.setTimeout(1_000);
  socket.on('connect', () => socket.destroy());
  socket.on('timeout', () => {
    socket.destroy();
    announce(url);
  });
  socket.on('error', () => announce(url));
  // Never hold the process open for a diagnostic.
  socket.unref();
}

function announce(url: string): void {
  console.warn(
    `\n  REDIS_URL is set to ${url} and nothing is listening there.\n` +
      '  Suites that dispatch a background job will each wait out their full timeout,\n' +
      '  which looks like a regression and is not. Start Redis, or unset REDIS_URL.\n',
  );
}
