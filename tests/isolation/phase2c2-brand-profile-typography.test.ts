import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { brandProfileFrom, profilePatchFrom } from '../../apps/dashboard/src/server/brand-profile';
import { saveBrandProfile } from '../../apps/dashboard/src/server/brand-profile-save';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2C-2, OWNER DECISION E — SETTINGS → BRAND NEVER DOWNGRADES THE FONTS.
 *
 * Before this PR the Settings → Brand save wrote `typography: { heading, body }`
 * (v1), which after Look & voice would overwrite a brand's four v2 slots. The
 * save now carries no typography by construction; the only typography writer is
 * the v2 one. Saved through the real decoder and the real save, against
 * PostgreSQL.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const V2 = {
  en: {
    heading: { kind: 'catalogue', key: 'playfair-display' },
    body: { kind: 'catalogue', key: 'lora' },
  },
  ar: { heading: { kind: 'catalogue', key: 'amiri' }, body: { kind: 'catalogue', key: 'tajawal' } },
};

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
});

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('owner decision E — a Settings → Brand save leaves the four slots untouched', () => {
  it('saves the profile and keeps the v2 slots exactly — even when the old font fields are posted', async () => {
    await platform.brand.update({ where: { id: fixtures.a.brandId }, data: { typography: V2 } });

    const form = new FormData();
    for (const [key, value] of Object.entries({
      name: 'Renamed Brand',
      industry: 'Retail',
      description: '',
      websiteUrl: '',
      defaultLocale: 'EN',
      colorPalette: '#7935FE',
      primaryLogoAssetId: '',
      secondaryLogoAssetId: '',
      // A stale tab or a crafted request still sending the v1 fields.
      headingFont: 'Comic Sans',
      bodyFont: 'Papyrus',
    })) {
      form.append(key, value);
    }

    const outcome = await inA((db) =>
      saveBrandProfile(db, {
        workspaceId: fixtures.a.workspaceId,
        actorUserId: fixtures.a.userId,
        brandId: fixtures.a.brandId,
        patch: profilePatchFrom(brandProfileFrom(form)),
      }),
    );
    expect(outcome).toBe('saved');

    const after = await platform.brand.findUniqueOrThrow({
      where: { id: fixtures.a.brandId },
      select: { name: true, colorPalette: true, typography: true },
    });
    expect(after.name).toBe('Renamed Brand');
    expect(after.colorPalette).toEqual(['#7935FE']);
    expect(after.typography).toEqual(V2);
  });

  it('the audit event records the profile change and no typography', async () => {
    const event = await platform.auditEvent.findFirst({
      where: { workspaceId: fixtures.a.workspaceId, action: 'brand.profile.updated' },
      orderBy: { occurredAt: 'desc' },
      select: { after: true },
    });
    expect(event?.after).toMatchObject({ name: 'Renamed Brand' });
    expect(event?.after as Record<string, unknown>).not.toHaveProperty('typography');
  });
});
