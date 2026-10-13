import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type SocialProvider, type TenantScopedClient } from '@brandspace/database';
import type { CustomerWorkspaceContext } from '@brandspace/auth';
import {
  createConnectorRegistry,
  expiringWindow,
  parsePublishingPolicy,
  SocialConnectionService,
} from '@brandspace/social-connectors';
import { attentionItems } from '../../apps/dashboard/src/server/command-center';
import { captureConfig, type ActivatedConfig } from './config-activation';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * CONNECTORS B (owner, #81) — INSTAGRAM IS WARNED ABOUT 7 DAYS AHEAD, AS
 * CONFIGURATION PER PLATFORM, WITH THE EXISTING NOTICE.
 *
 * `publishing.providers.instagram.expiringSoonHours` (168) is read by the same
 * two places that already warn: Home's "needs you" item (`connection-expiring`)
 * and the connection view the integrations screen and publish readiness use.
 * A platform without its own value keeps `dispatch.expiringSoonHours` (24).
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let publishing: ActivatedConfig;

const NOW = new Date();
const DAY = 86_400_000;
const PAYLOAD = {
  providers: { instagram: { enabled: false, expiringSoonHours: 168 } },
  dispatch: { expiringSoonHours: 24 },
};

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

function session(): CustomerWorkspaceContext {
  return {
    workspaceId: fixtures.a.workspaceId,
    workspaceName: 'A',
    workspaceSlug: 'a',
    workspaceStatus: 'ACTIVE',
    roleKey: 'workspace_owner',
    roleNameEn: 'Owner',
    roleNameAr: 'مالك',
    permissionKeys: ['integrations.read', 'publishing.read'],
    brandScope: [],
  };
}

const expiringCount = async () =>
  (await inA((db) => attentionItems(db, session()))).find(
    (item) => item.kind === 'connection-expiring',
  )?.count ?? 0;

const connection = (provider: SocialProvider, expiresInMs: number) =>
  inA(async (db) =>
    db.socialConnection.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        provider,
        externalAccountId: `expiry-${randomUUID()}`,
        displayName: 'Expiry fixture',
        targetKind: 'profile',
        status: 'ACTIVE',
        connectedAt: NOW,
        tokenExpiresAt: new Date(NOW.getTime() + expiresInMs),
      },
    }),
  );

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  publishing = await captureConfig(platform, 'publishing', { projected: true });
  await publishing.activate(PAYLOAD);
}, 90_000);

afterAll(async () => {
  try {
    await publishing?.restore();
  } finally {
    await app?.$disconnect();
    await platform?.$disconnect();
  }
});

describe('the expiring-soon window, per platform', () => {
  it('Home counts an Instagram token 3 days from expiry; not LinkedIn’s, and not Instagram’s at 8 days', async () => {
    const before = await expiringCount();
    await connection('LINKEDIN', 3 * DAY);
    await connection('INSTAGRAM', 8 * DAY);
    expect(await expiringCount()).toBe(before);

    await connection('INSTAGRAM', 3 * DAY);
    expect(await expiringCount()).toBe(before + 1);

    // LinkedIn keeps the dispatch window: inside 24 hours it is counted.
    await connection('LINKEDIN', 3_600_000);
    expect(await expiringCount()).toBe(before + 2);
  });

  it('the connection view (integrations screen, publish readiness) says the same', async () => {
    const instagram = await connection('INSTAGRAM', 3 * DAY);
    const linkedin = await connection('LINKEDIN', 3 * DAY);
    const policy = parsePublishingPolicy(PAYLOAD);
    const views = await inA(async (db) => {
      const service = new SocialConnectionService({
        db,
        workspaceId: fixtures.a.workspaceId,
        registry: createConnectorRegistry({ policy, environment: 'DEVELOPMENT' }),
        expiringWindowMs: expiringWindow(policy),
      });
      return Promise.all([service.get(instagram.id, []), service.get(linkedin.id, [])]);
    });
    expect(views.map((view) => view.expiringSoon)).toEqual([true, false]);
  });
});
