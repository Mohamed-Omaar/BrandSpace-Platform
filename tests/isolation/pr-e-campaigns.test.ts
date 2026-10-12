import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { withWorkspace } from '@brandspace/database';
import { CampaignService } from '@brandspace/content';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PR E (D-496, Campaigns 1) — THE PLANNED NUMBER OF POSTS, THROUGH THE
 * SERVICE AND RLS.
 *
 *   - create and update store `plannedPostCount`; `undefined` leaves it, `null`
 *     clears it;
 *   - from another workspace the campaign is the same "not found" as a missing
 *     one, and the number is untouched.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 90_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

const inWorkspace = <T>(workspaceId: string, run: (service: CampaignService) => Promise<T>) =>
  withWorkspace(workspaceId, (db) => run(new CampaignService({ db, workspaceId })), {
    prisma: app,
  });

describe('PR E — campaign.plannedPostCount', () => {
  it('is stored on create and changed or cleared on update', async () => {
    const a = fixtures.a;
    const actor = { userId: a.userId, brandScope: [] };
    const created = await inWorkspace(a.workspaceId, (service) =>
      service.create({
        brandId: a.brandId,
        name: `pr-e planned ${randomUUID().slice(0, 6)}`,
        objective: 'LAUNCH',
        plannedPostCount: 8,
        actor,
      }),
    );
    expect(created.plannedPostCount).toBe(8);

    const kept = await inWorkspace(a.workspaceId, (service) =>
      service.update({ campaignId: created.id, name: 'renamed', actor }),
    );
    expect(kept.plannedPostCount).toBe(8);

    const changed = await inWorkspace(a.workspaceId, (service) =>
      service.update({ campaignId: created.id, plannedPostCount: 12, actor }),
    );
    expect(changed.plannedPostCount).toBe(12);

    const cleared = await inWorkspace(a.workspaceId, (service) =>
      service.update({ campaignId: created.id, plannedPostCount: null, actor }),
    );
    expect(cleared.plannedPostCount).toBeNull();
  });

  it('cannot be changed from another workspace: the same not-found as a missing campaign', async () => {
    const a = fixtures.a;
    const created = await inWorkspace(a.workspaceId, (service) =>
      service.create({
        brandId: a.brandId,
        name: `pr-e planned ${randomUUID().slice(0, 6)}`,
        objective: 'LAUNCH',
        plannedPostCount: 5,
        actor: { userId: a.userId, brandScope: [] },
      }),
    );
    const attempt = (campaignId: string) =>
      inWorkspace(fixtures.b.workspaceId, (service) =>
        service.update({
          campaignId,
          plannedPostCount: 99,
          actor: { userId: fixtures.b.userId, brandScope: [] },
        }),
      ).then(
        () => 'changed',
        (error: unknown) => String((error as { code?: string }).code ?? (error as Error).message),
      );
    const crossed = await attempt(created.id);
    expect(crossed).not.toBe('changed');
    expect(crossed).toBe(await attempt(randomUUID()));
    const row = await platform.campaign.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.plannedPostCount).toBe(5);
  });
});
