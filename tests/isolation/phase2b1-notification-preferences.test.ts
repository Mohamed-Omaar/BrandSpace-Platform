import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  NOTIFICATION_CATEGORIES,
  NotificationPreferenceService,
  NotificationService,
} from '@brandspace/notifications';
import { saveBrandAiLanguage } from '../../apps/dashboard/src/server/brand-ai-language';
import { appRoleClient, platformRoleClient } from './fixtures';

/**
 * PROTOTYPE v94 PHASE 2B-1, ITEM 4 — NOTIFICATION PREFERENCES AND THE AI
 * WRITING LANGUAGE (A10 / G2 / G3, D-331), AGAINST REAL POSTGRESQL.
 *
 * A switch is ONE person's, in ONE workspace: it filters that person's bell
 * for that category and nothing else — not a colleague's, not the same
 * person's in another workspace, and never a notice about the workspace
 * itself. `notification_preference` is tenant-owned, so RLS keeps every row
 * inside its workspace like any other.
 */

let app: PrismaClient;
let platform: PrismaClient;

beforeAll(() => {
  app = appRoleClient();
  platform = platformRoleClient();
});

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

async function person(label: string): Promise<string> {
  const user = await platform.user.create({
    data: {
      email: `p2b1-np-${label}-${crypto.randomUUID().slice(0, 8)}@example.local`,
      name: `Person ${label}`,
      status: 'ACTIVE',
      timezone: 'UTC',
    },
    select: { id: true },
  });
  return user.id;
}

async function workspaceOf(ownerId: string, label: string): Promise<string> {
  const id = crypto.randomUUID();
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      slug: `p2b1-np-${label}-${id.slice(0, 8)}`,
      name: `Preferences ${label}`,
      ownerUserId: ownerId,
      status: 'ACTIVE',
      country: 'US',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
    },
  });
  return id;
}

function inTenant<T>(workspaceId: string, fn: (db: TenantScopedClient) => Promise<T>): Promise<T> {
  return withWorkspace(workspaceId, fn, { prisma: app });
}

const allOn = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, true])) as Record<
  (typeof NOTIFICATION_CATEGORIES)[number],
  boolean
>;

async function inbox(workspaceId: string, userId: string): Promise<string[]> {
  const rows = await platform.notification.findMany({
    where: { workspaceId, userId },
    select: { templateKey: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => row.templateKey);
}

describe('A10 / G2 · a switch filters one person’s bell, for one category', () => {
  it('a muted category is not delivered to that person; a colleague and other categories still are', async () => {
    const quiet = await person('quiet');
    const colleague = await person('colleague');
    const workspaceId = await workspaceOf(quiet, 'filter');

    await inTenant(workspaceId, (db) =>
      new NotificationPreferenceService({ db, workspaceId }).set(quiet, {
        ...allOn,
        approvals: false,
      }),
    );
    const send = (templateKey: 'approval.requested' | 'publishing.published', key: string) =>
      inTenant(workspaceId, (db) =>
        new NotificationService({ db, workspaceId }).create({
          userIds: [quiet, colleague],
          templateKey,
          idempotencyKey: key,
        }),
      );
    expect(await send('approval.requested', 'np-1')).toBe(1);
    expect(await send('publishing.published', 'np-2')).toBe(2);

    expect(await inbox(workspaceId, quiet)).toEqual(['publishing.published']);
    expect(await inbox(workspaceId, colleague)).toEqual([
      'approval.requested',
      'publishing.published',
    ]);
  });

  it('a notice about the workspace itself arrives whatever is switched off', async () => {
    const owner = await person('all-off');
    const workspaceId = await workspaceOf(owner, 'safety');
    const allOff = Object.fromEntries(
      NOTIFICATION_CATEGORIES.map((c) => [c, false]),
    ) as typeof allOn;
    await inTenant(workspaceId, (db) =>
      new NotificationPreferenceService({ db, workspaceId }).set(owner, allOff),
    );
    await inTenant(workspaceId, (db) =>
      new NotificationService({ db, workspaceId }).create({
        userIds: [owner],
        templateKey: 'workspace.deletion_requested',
        idempotencyKey: 'np-safety',
      }),
    );
    expect(await inbox(workspaceId, owner)).toEqual(['workspace.deletion_requested']);
  });

  it('the same person’s switch in one workspace does not reach their other workspace', async () => {
    const member = await person('two-workspaces');
    const first = await workspaceOf(member, 'first');
    const second = await workspaceOf(member, 'second');
    await inTenant(first, (db) =>
      new NotificationPreferenceService({ db, workspaceId: first }).set(member, {
        ...allOn,
        automations: false,
      }),
    );
    expect(
      await inTenant(second, (db) =>
        new NotificationPreferenceService({ db, workspaceId: second }).forUser(member),
      ),
    ).toEqual(allOn);
    await inTenant(second, (db) =>
      new NotificationService({ db, workspaceId: second }).create({
        userIds: [member],
        templateKey: 'automation.notice',
        idempotencyKey: 'np-second',
      }),
    );
    expect(await inbox(second, member)).toEqual(['automation.notice']);
  });

  it('no row means on, and saving writes one audited change — nothing when nothing changed', async () => {
    const member = await person('audit');
    const workspaceId = await workspaceOf(member, 'audit');
    const service = (db: TenantScopedClient) =>
      new NotificationPreferenceService({ db, workspaceId });
    expect(await inTenant(workspaceId, (db) => service(db).forUser(member))).toEqual(allOn);

    await inTenant(workspaceId, (db) => service(db).set(member, allOn));
    expect(await platform.notificationPreference.count({ where: { workspaceId } })).toBe(0);

    await inTenant(workspaceId, (db) =>
      service(db).set(member, { ...allOn, brand_brain_reviews: false }),
    );
    const audits = await platform.auditEvent.findMany({
      where: { workspaceId, action: 'notification.preferences.updated' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after).toEqual({ brand_brain_reviews: false });
    expect(audits[0]?.actorId).toBe(member);
  });
});

describe('A10 · notification_preference is tenant-owned (RLS)', () => {
  it('another workspace cannot read, count or write this workspace’s switches', async () => {
    const member = await person('rls');
    const mine = await workspaceOf(member, 'rls-mine');
    const theirs = await workspaceOf(member, 'rls-theirs');
    await inTenant(mine, (db) =>
      new NotificationPreferenceService({ db, workspaceId: mine }).set(member, {
        ...allOn,
        publishing: false,
      }),
    );

    await inTenant(theirs, async (db) => {
      expect(await db.notificationPreference.findMany({ where: { workspaceId: mine } })).toEqual(
        [],
      );
      expect(await db.notificationPreference.count()).toBe(0);
      const updated = await db.notificationPreference.updateMany({
        where: { workspaceId: mine },
        data: { enabled: true },
      });
      expect(updated.count).toBe(0);
    });
    await expect(
      inTenant(theirs, (db) =>
        db.notificationPreference.create({
          data: { workspaceId: mine, userId: member, category: 'approvals', enabled: false },
        }),
      ),
    ).rejects.toThrow();
    expect(
      await platform.notificationPreference.findMany({
        where: { workspaceId: mine },
        select: { category: true, enabled: true },
      }),
    ).toEqual([{ category: 'publishing', enabled: false }]);
  });

  it('the database refuses a category the screen does not offer', async () => {
    const member = await person('check');
    const workspaceId = await workspaceOf(member, 'check');
    await expect(
      inTenant(workspaceId, (db) =>
        db.notificationPreference.create({
          data: { workspaceId, userId: member, category: 'billing', enabled: false },
        }),
      ),
    ).rejects.toThrow(/notification_preference_category_known/);
  });
});

describe('G3 · the brand’s AI writing language, from Settings → AI', () => {
  async function brandIn(workspaceId: string): Promise<string> {
    const brand = await platform.brand.create({
      data: {
        workspaceId,
        slug: `p2b1-ai-${crypto.randomUUID().slice(0, 8)}`,
        name: 'AI language brand',
        status: 'ACTIVE',
        defaultLocale: 'EN',
        supportedLocales: ['EN'],
      },
      select: { id: true },
    });
    return brand.id;
  }

  it('changes the language, keeps it among the supported ones, and audits it', async () => {
    const owner = await person('ai');
    const workspaceId = await workspaceOf(owner, 'ai');
    const brandId = await brandIn(workspaceId);
    await inTenant(workspaceId, (db) =>
      saveBrandAiLanguage(
        db,
        { workspaceId, actorUserId: owner, brandScope: [] },
        { brandId, defaultLocale: 'AR' },
      ),
    );
    expect(
      await platform.brand.findUniqueOrThrow({
        where: { id: brandId },
        select: { defaultLocale: true, supportedLocales: true },
      }),
    ).toEqual({ defaultLocale: 'AR', supportedLocales: ['EN', 'AR'] });
    expect(
      await platform.auditEvent.count({
        where: { workspaceId, action: 'brand.profile.updated', resourceId: brandId },
      }),
    ).toBe(1);
  });

  it('refuses outside BrandScope, another workspace’s brand and an unknown language', async () => {
    const owner = await person('ai-refused');
    const mine = await workspaceOf(owner, 'ai-mine');
    const theirs = await workspaceOf(owner, 'ai-theirs');
    const myBrand = await brandIn(mine);
    const theirBrand = await brandIn(theirs);
    const save = (brandScope: string[], brandId: string, defaultLocale: string) =>
      inTenant(mine, (db) =>
        saveBrandAiLanguage(
          db,
          { workspaceId: mine, actorUserId: owner, brandScope },
          { brandId, defaultLocale },
        ),
      );
    await expect(save([crypto.randomUUID()], myBrand, 'AR')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(save([], theirBrand, 'AR')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(save([], myBrand, 'FR')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const brands = await platform.brand.findMany({
      where: { id: { in: [myBrand, theirBrand] } },
      select: { defaultLocale: true },
    });
    expect(brands.map((brand) => brand.defaultLocale)).toEqual(['EN', 'EN']);
  });
});
