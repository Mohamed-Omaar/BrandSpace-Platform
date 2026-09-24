import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityLogService } from '@brandspace/activity';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { WORKSPACE_PERMISSIONS } from '@brandspace/shared';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 6 FINAL · D-289 — A CAMPAIGN'S TIMELINE IS NARROWED, NEVER WIDENED.
 *
 * The Project Room's Activity tab asks the one activity service for events
 * about the campaign and its posts. The new `resourceIds` filter must only
 * narrow what the viewer's scope already allows: another workspace's event
 * about the SAME id is never returned.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
const campaignLikeId = randomUUID();
const otherId = randomUUID();

const ALL = WORKSPACE_PERMISSIONS.map((p) => p.key);
const inWs = <T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(workspaceId, fn as never, { prisma: app }) as Promise<T>;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  for (const [workspaceId, resourceId, action] of [
    [fixtures.a.workspaceId, campaignLikeId, 'campaign.created'],
    [fixtures.a.workspaceId, otherId, 'content.variant.edited'],
    [fixtures.b.workspaceId, campaignLikeId, 'campaign.updated'],
  ] as const) {
    await platform.auditEvent.create({
      data: { workspaceId, actorType: 'USER', action, resourceType: 'Campaign', resourceId },
    });
  }
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('D-289 · activity narrowed to a campaign', () => {
  it('returns only this workspace’s events about the named rows', async () => {
    const page = await inWs(fixtures.a.workspaceId, (db) =>
      new ActivityLogService({ db, workspaceId: fixtures.a.workspaceId }).page({
        viewer: { userId: fixtures.a.userId, permissionKeys: ALL, brandScope: [] },
        filter: { resourceIds: [campaignLikeId] },
        take: 50,
      }),
    );
    expect(page.entries.map((entry) => entry.action)).toEqual(['campaign.created']);
    expect(page.entries.every((entry) => entry.resourceId === campaignLikeId)).toBe(true);
  });
});
