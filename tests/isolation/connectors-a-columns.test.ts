import type { PrismaClient } from '@prisma/client';
import { withWorkspace } from '@brandspace/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * CONNECTORS STEP A (D-505) — THE FOUR NEW COLUMNS, AGAINST REAL POSTGRESQL.
 *
 *   - `providerHandle` on `publish_job` and `publish_attempt` (W5): any
 *     non-empty text up to 512 characters; empty or longer is refused by the
 *     database whatever the application layer does;
 *   - `providerSubjectHash` / `pendingSubjectHash` (W10): only "v<n>:" + 64
 *     lowercase hex — a bare hash with no key version is refused, so a lookup
 *     after a key rotation always knows which key to use;
 *   - each can be written and read only inside its own workspace: they are
 *     columns of rows the tenant policies already guard.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const HEX = 'a'.repeat(64);

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 90_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

async function refusal(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return String((error as Error).message);
  }
}

describe('connectors A — providerHandle shape', () => {
  it('publish_job admits a handle up to 512 characters and NULL', async () => {
    for (const value of ['17895695668004550', 'x'.repeat(512), null]) {
      expect(
        await refusal(() =>
          platform.publishJob.update({
            where: { id: fixtures.a.publishJobId },
            data: { providerHandle: value },
          }),
        ),
        String(value).slice(0, 20),
      ).toBeNull();
    }
  });

  it('publish_job refuses an empty handle and one over 512 characters', async () => {
    for (const value of ['', 'x'.repeat(513)]) {
      expect(
        await refusal(() =>
          platform.publishJob.update({
            where: { id: fixtures.a.publishJobId },
            data: { providerHandle: value },
          }),
        ),
      ).toContain('publish_job_provider_handle_shape');
    }
  });

  it('publish_attempt has the same rule (attempts are append-only, so on insert)', async () => {
    const attempt = (attemptNumber: number, providerHandle: string) =>
      platform.publishAttempt.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          publishJobId: fixtures.a.publishJobId,
          attemptNumber,
          outcome: 'INDETERMINATE',
          failureClass: 'TIMEOUT',
          providerHandle,
        },
      });
    expect(await refusal(() => attempt(901, ''))).toContain(
      'publish_attempt_provider_handle_shape',
    );
    expect(await refusal(() => attempt(902, 'x'.repeat(513)))).toContain(
      'publish_attempt_provider_handle_shape',
    );
    expect(await refusal(() => attempt(903, 'v1_publish_id_7'))).toBeNull();
  });
});

describe('connectors A — the subject hash carries its key version', () => {
  it('admits "v<n>:" + 64 lowercase hex, and NULL', async () => {
    for (const value of [`v1:${HEX}`, `v12:${HEX}`, `v9999:${HEX}`, null]) {
      expect(
        await refusal(() =>
          platform.socialConnection.update({
            where: { id: fixtures.a.socialConnectionId },
            data: { providerSubjectHash: value },
          }),
        ),
        String(value),
      ).toBeNull();
      expect(
        await refusal(() =>
          platform.socialOAuthState.update({
            where: { id: fixtures.a.socialOAuthStateId },
            data: { pendingSubjectHash: value },
          }),
        ),
        String(value),
      ).toBeNull();
    }
  });

  it('refuses a hash with no version, a raw id, upper case and the wrong length', async () => {
    for (const value of [
      HEX,
      '1234567890123456',
      `v1:${'A'.repeat(64)}`,
      `v1:${'a'.repeat(63)}`,
      `v:${HEX}`,
      `v10000:${HEX}`,
    ]) {
      expect(
        await refusal(() =>
          platform.socialConnection.update({
            where: { id: fixtures.a.socialConnectionId },
            data: { providerSubjectHash: value },
          }),
        ),
        value,
      ).toContain('social_connection_provider_subject_hash_shape');
      expect(
        await refusal(() =>
          platform.socialOAuthState.update({
            where: { id: fixtures.a.socialOAuthStateId },
            data: { pendingSubjectHash: value },
          }),
        ),
        value,
      ).toContain('social_oauth_state_pending_subject_hash_shape');
    }
  });
});

describe('connectors A — the columns stay inside their workspace', () => {
  it('Workspace B can neither write nor read A’s handle or subject hash', async () => {
    await platform.publishJob.update({
      where: { id: fixtures.a.publishJobId },
      data: { providerHandle: 'a-handle' },
    });
    await platform.socialConnection.update({
      where: { id: fixtures.a.socialConnectionId },
      data: { providerSubjectHash: `v1:${HEX}` },
    });

    const written = await withWorkspace(
      fixtures.b.workspaceId,
      async (db) => ({
        jobs: await db.publishJob.updateMany({
          where: { id: fixtures.a.publishJobId },
          data: { providerHandle: 'b-was-here' },
        }),
        connections: await db.socialConnection.updateMany({
          where: { id: fixtures.a.socialConnectionId },
          data: { providerSubjectHash: `v2:${'b'.repeat(64)}` },
        }),
      }),
      { prisma: app },
    );
    expect(written.jobs.count).toBe(0);
    expect(written.connections.count).toBe(0);

    const seen = await withWorkspace(
      fixtures.b.workspaceId,
      async (db) => ({
        byHandle: await db.publishJob.count({ where: { providerHandle: 'a-handle' } }),
        bySubject: await db.socialConnection.count({
          where: { providerSubjectHash: `v1:${HEX}` },
        }),
      }),
      { prisma: app },
    );
    expect(seen).toEqual({ byHandle: 0, bySubject: 0 });

    const own = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => ({
        byHandle: await db.publishJob.count({ where: { providerHandle: 'a-handle' } }),
        bySubject: await db.socialConnection.count({
          where: { providerSubjectHash: `v1:${HEX}` },
        }),
      }),
      { prisma: app },
    );
    expect(own).toEqual({ byHandle: 1, bySubject: 1 });

    await platform.publishJob.update({
      where: { id: fixtures.a.publishJobId },
      data: { providerHandle: null },
    });
    await platform.socialConnection.update({
      where: { id: fixtures.a.socialConnectionId },
      data: { providerSubjectHash: null },
    });
  });
});
