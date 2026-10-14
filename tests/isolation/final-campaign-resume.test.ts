import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { CampaignService } from '@brandspace/content';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * FINAL REVIEW (owner, item 5) — RESUME A PAUSED CAMPAIGN, AGAINST REAL
 * POSTGRESQL THROUGH THE TENANT ROLE.
 *
 * `CampaignService.resume` is the mirror of `pause`: only a PAUSED campaign in
 * the caller's workspace and brand scope becomes ACTIVE, with one
 * `campaign.updated` audit event, reason `manual_resume`. Anything not paused
 * is refused unchanged, and another workspace's campaign — or one outside the
 * member's brands — is the ordinary "unavailable".
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const inWorkspace = <T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(workspaceId, fn as never, { prisma: app }) as Promise<T>;

async function campaign(
  side: 'a' | 'b',
  status: 'PAUSED' | 'ACTIVE' | 'PLANNED' | 'COMPLETED',
): Promise<string> {
  const world = fixtures[side];
  return (
    await platform.campaign.create({
      data: {
        workspaceId: world.workspaceId,
        brandId: world.brandId,
        name: `Resume ${randomUUID().slice(0, 6)}`,
        objective: 'AWARENESS',
        status,
        createdByUserId: world.userId,
      },
      select: { id: true },
    })
  ).id;
}

const resume = (campaignId: string, brandId: string, brandScope: readonly string[] = []) =>
  inWorkspace(fixtures.a.workspaceId, (db) =>
    new CampaignService({ db: db as never, workspaceId: fixtures.a.workspaceId }).resume({
      campaignId,
      brandId,
      actor: { userId: fixtures.a.userId, brandScope },
    }),
  );

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('Resume on a paused campaign — one press, audited', () => {
  it('resumes a paused campaign to running, and the audit event says manual_resume', async () => {
    const id = await campaign('a', 'PAUSED');
    expect(await resume(id, fixtures.a.brandId)).toMatchObject({
      kind: 'resumed',
      campaign: { status: 'ACTIVE' },
    });
    const audit = await platform.auditEvent.findFirstOrThrow({
      where: { action: 'campaign.updated', resourceId: id },
    });
    expect(audit).toMatchObject({ actorId: fixtures.a.userId, reason: 'manual_resume' });
  });

  it('a campaign that is not paused is refused and does not change', async () => {
    for (const status of ['ACTIVE', 'PLANNED', 'COMPLETED'] as const) {
      const id = await campaign('a', status);
      expect(await resume(id, fixtures.a.brandId)).toEqual({
        kind: 'refused',
        reason: 'campaign_not_resumable',
      });
      expect((await platform.campaign.findUniqueOrThrow({ where: { id } })).status).toBe(status);
    }
  });

  it("another workspace's paused campaign is unavailable and stays paused", async () => {
    const id = await campaign('b', 'PAUSED');
    expect(await resume(id, fixtures.b.brandId)).toEqual({
      kind: 'refused',
      reason: 'campaign_unavailable',
    });
    expect((await platform.campaign.findUniqueOrThrow({ where: { id } })).status).toBe('PAUSED');
  });

  it("a member whose brands do not include the campaign's is not told about it", async () => {
    const id = await campaign('a', 'PAUSED');
    expect(await resume(id, fixtures.a.brandId, [randomUUID()])).toEqual({
      kind: 'refused',
      reason: 'campaign_unavailable',
    });
    expect((await platform.campaign.findUniqueOrThrow({ where: { id } })).status).toBe('PAUSED');
  });
});
