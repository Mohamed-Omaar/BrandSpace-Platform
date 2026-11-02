import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { createIsolationFixtures, appRoleClient } from './fixtures';

/**
 * PR A2 — pg's "Calling client.query() when the client is already executing a
 * query is deprecated" warning. Prisma runs a transaction on one connection,
 * and `Promise.all` inside `withWorkspace` sent several queries to it at once.
 * The product's pools now send one query at a time per connection, in the
 * order pg itself would have queued them, so the results are unchanged.
 */
const run = promisify(execFile);
const CHILD = path.join(__dirname, 'helpers', 'pg-concurrent-child.ts');
const WARNING = 'Calling client.query() when the client is already executing a query';

async function child(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, ['--import', 'tsx', CHILD, ...args], {
    env: process.env,
    cwd: path.join(__dirname, '..', '..'),
    timeout: 60_000,
  });
}

describe('PR A2 — one query at a time per connection', () => {
  it('the control: a plain pool given concurrent queries prints pg’s warning', async () => {
    const { stdout, stderr } = await child('raw');
    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '[]')).toEqual([1, 2, 3, 4, 5]);
    expect(stderr).toContain(WARNING);
  }, 60_000);

  it('the serial pool: the same queries, the same results in order, no warning', async () => {
    const { stdout, stderr } = await child('serial');
    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '[]')).toEqual([1, 2, 3, 4, 5]);
    expect(stderr).not.toContain(WARNING);
  }, 60_000);

  it('the product path: a read Prisma loads concurrently inside withWorkspace prints no warning', async () => {
    const fixtures = await createIsolationFixtures(appRoleClient());
    // Posts with relations to load: an empty workspace gives Prisma nothing to
    // fetch concurrently, and the test would pass without proving anything.
    const platform = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL'] ?? '' }),
    });
    for (let i = 0; i < 3; i += 1) {
      const item = await platform.contentItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          title: `Serial ${i}`,
          status: 'DRAFT',
          primaryLocale: 'EN',
          createdByUserId: fixtures.a.userId,
        },
        select: { id: true },
      });
      await platform.contentVariant.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          contentItemId: item.id,
          platformKey: 'instagram',
          locale: 'EN',
          body: 'Serial',
          characterCount: 6,
          validationState: 'VALID',
        },
      });
    }
    await platform.$disconnect();
    const { stdout, stderr } = await child('prisma', fixtures.a.workspaceId);
    expect(stdout.trim().split('\n').at(-1)).toBe('4');
    expect(stderr).not.toContain(WARNING);
  }, 90_000);
});
