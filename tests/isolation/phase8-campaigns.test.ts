import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { CampaignService } from '@brandspace/content';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 8 — CAMPAIGNS, ON REAL POSTGRESQL (AC-26.5).
 *
 * WHAT THIS PROVES THAT THE UNIT SUITE CANNOT. The decoder's job ends at the
 * shape of a form. These assert the two things that actually keep tenants and
 * brands apart, and both live in the database:
 *
 *   - A CAMPAIGN OUTSIDE THE MEMBER'S SCOPE IS NEVER READ, because the scope is
 *     in the WHERE (D-132) — not fetched and then filtered, which is a read
 *     that happened.
 *   - A FOREIGN CAMPAIGN ID IS INDISTINGUISHABLE FROM A FABRICATED ONE. Both
 *     answer NOT_FOUND, so the error message cannot be used to ask whether a
 *     campaign exists in another workspace (CLAUDE.md §2.1).
 *
 * And the one the linkage introduces: CONTENT AND CAMPAIGN MUST BE THE SAME
 * BRAND'S. Filing brand A's post under brand B's campaign would make brand B's
 * performance figures include work it never did — a correctness bug wearing a
 * permissions costume.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

let brandOne: string;
let brandTwo: string;
let foreignBrand: string;

let campaignOfBrandOne: string;
let campaignOfBrandTwo: string;
let foreignCampaign: string;

let itemOfBrandOne: string;
let itemOfBrandTwo: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

/** The service as the dashboard builds it: tenant-scoped client, one workspace. */
const serviceA = (db: TenantScopedClient) =>
  new CampaignService({ db, workspaceId: fixtures.a.workspaceId });

const makeBrand = async (
  workspaceId: string,
  run: <T>(fn: (db: TenantScopedClient) => Promise<T>) => Promise<T>,
  name: string,
): Promise<string> => {
  const row = await run((db) =>
    db.brand.create({
      data: { workspaceId, slug: `p8c-${randomUUID().slice(0, 8)}`, name, status: 'ACTIVE' },
      select: { id: true },
    }),
  );
  return row.id;
};

const makeCampaign = async (
  workspaceId: string,
  run: <T>(fn: (db: TenantScopedClient) => Promise<T>) => Promise<T>,
  brandId: string,
  name: string,
): Promise<string> => {
  const row = await run((db) =>
    db.campaign.create({
      data: { workspaceId, brandId, name, objective: 'AWARENESS' },
      select: { id: true },
    }),
  );
  return row.id;
};

const makeItem = async (
  workspaceId: string,
  run: <T>(fn: (db: TenantScopedClient) => Promise<T>) => Promise<T>,
  brandId: string,
  title: string,
): Promise<string> => {
  const row = await run((db) =>
    db.contentItem.create({
      data: { workspaceId, brandId, title, contentType: 'POST', primaryLocale: 'EN' },
      select: { id: true },
    }),
  );
  return row.id;
};

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);

  brandOne = await makeBrand(fixtures.a.workspaceId, inA, 'Campaigns Alpha');
  brandTwo = await makeBrand(fixtures.a.workspaceId, inA, 'Campaigns Beta');
  foreignBrand = await makeBrand(fixtures.b.workspaceId, inB, 'Campaigns Foreign');

  campaignOfBrandOne = await makeCampaign(fixtures.a.workspaceId, inA, brandOne, 'Alpha spring');
  campaignOfBrandTwo = await makeCampaign(fixtures.a.workspaceId, inA, brandTwo, 'Beta spring');
  foreignCampaign = await makeCampaign(fixtures.b.workspaceId, inB, foreignBrand, 'Foreign spring');

  itemOfBrandOne = await makeItem(fixtures.a.workspaceId, inA, brandOne, 'Alpha post');
  itemOfBrandTwo = await makeItem(fixtures.a.workspaceId, inA, brandTwo, 'Beta post');
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('AC-26.5: a campaign is only ever read inside its own workspace', () => {
  it('another workspace campaign answers exactly what a fabricated id answers', async () => {
    const fabricated = randomUUID();
    const foreign = await inA((db) =>
      serviceA(db)
        .get(foreignCampaign, [])
        .then(() => 'found')
        .catch((error: unknown) => (error as { code?: string }).code),
    );
    const missing = await inA((db) =>
      serviceA(db)
        .get(fabricated, [])
        .then(() => 'found')
        .catch((error: unknown) => (error as { code?: string }).code),
    );
    expect(foreign).toBe('NOT_FOUND');
    expect(missing).toBe('NOT_FOUND');
  });

  it('never lists another workspace campaign, even with an unrestricted scope', async () => {
    const ids = await inA(async (db) =>
      (await serviceA(db).list({ brandScope: [], take: 200 })).map((row) => row.id),
    );
    expect(ids).toContain(campaignOfBrandOne);
    expect(ids).toContain(campaignOfBrandTwo);
    expect(ids).not.toContain(foreignCampaign);
  });
});

describe('AC-26.5: BrandScope narrows the query, not the result', () => {
  it('lists only the scoped brand campaigns', async () => {
    const ids = await inA(async (db) =>
      (await serviceA(db).list({ brandScope: [brandOne], take: 200 })).map((row) => row.id),
    );
    expect(ids).toContain(campaignOfBrandOne);
    expect(ids).not.toContain(campaignOfBrandTwo);
  });

  it('refuses to read a campaign outside the scope, as a miss', async () => {
    const code = await inA((db) =>
      serviceA(db)
        .get(campaignOfBrandTwo, [brandOne])
        .then(() => 'found')
        .catch((error: unknown) => (error as { code?: string }).code),
    );
    expect(code).toBe('NOT_FOUND');
  });

  /*
   * A SCOPED MEMBER CANNOT CREATE INTO A BRAND THEY MAY NOT SEE, and the answer
   * is NOT_FOUND rather than FORBIDDEN on purpose: "you may not use that brand"
   * would confirm the brand exists, which is the tell CLAUDE.md §2.1 forbids.
   * The refusal comes from `assertBrandInScope` BEFORE any row is written, so
   * there is nothing to roll back either.
   */
  it('refuses to create a campaign for a brand outside the scope, as a miss', async () => {
    await expect(
      inA((db) =>
        serviceA(db).create({
          brandId: brandTwo,
          name: 'should not exist',
          objective: 'AWARENESS',
          actor: { userId: fixtures.a.userId, brandScope: [brandOne] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const leaked = await inA((db) => db.campaign.count({ where: { name: 'should not exist' } }));
    expect(leaked).toBe(0);
  });
});

describe('AC-26.3: content and campaign must be the same brand', () => {
  it('files a post under its own brand campaign', async () => {
    await inA((db) =>
      serviceA(db).setContentCampaign({
        contentItemId: itemOfBrandOne,
        campaignId: campaignOfBrandOne,
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );
    const row = await inA((db) =>
      db.contentItem.findFirst({
        where: { id: itemOfBrandOne },
        select: { campaignId: true },
      }),
    );
    expect(row?.campaignId).toBe(campaignOfBrandOne);
  });

  /*
   * THE DEFECT THIS EXISTS FOR. Brand A's post filed under brand B's campaign
   * would make brand B's performance include work it never did — and the
   * campaign screen reads its content through this column.
   *
   * THE ANSWER IS A MISS, NOT A VALIDATION ERROR, and that is the stronger of
   * the two: "that campaign belongs to another brand" describes a campaign the
   * caller may not be entitled to know about. A member whose scope covers both
   * brands still gets the miss, so the two refusals cannot be told apart.
   */
  it('refuses to file one brand post under another brand campaign, as a miss', async () => {
    await expect(
      inA((db) =>
        serviceA(db).setContentCampaign({
          contentItemId: itemOfBrandOne,
          campaignId: campaignOfBrandTwo,
          actor: { userId: fixtures.a.userId, brandScope: [] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // And it is the same answer a campaign that does not exist at all gets.
    await expect(
      inA((db) =>
        serviceA(db).setContentCampaign({
          contentItemId: itemOfBrandOne,
          campaignId: randomUUID(),
          actor: { userId: fixtures.a.userId, brandScope: [] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a campaign from another workspace as a miss', async () => {
    await expect(
      inA((db) =>
        serviceA(db).setContentCampaign({
          contentItemId: itemOfBrandOne,
          campaignId: foreignCampaign,
          actor: { userId: fixtures.a.userId, brandScope: [] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to touch a content item outside the member scope', async () => {
    await expect(
      inA((db) =>
        serviceA(db).setContentCampaign({
          contentItemId: itemOfBrandTwo,
          campaignId: null,
          actor: { userId: fixtures.a.userId, brandScope: [brandOne] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('unlinks a post without deleting it', async () => {
    await inA((db) =>
      serviceA(db).setContentCampaign({
        contentItemId: itemOfBrandOne,
        campaignId: null,
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );
    const row = await inA((db) =>
      db.contentItem.findFirst({
        where: { id: itemOfBrandOne },
        select: { campaignId: true, deletedAt: true },
      }),
    );
    expect(row?.campaignId).toBeNull();
    expect(row?.deletedAt).toBeNull();
  });
});

describe('AC-26.2: archiving is a soft delete that keeps the content', () => {
  it('leaves the campaign content in place and the campaign findable as archived', async () => {
    const campaignId = await makeCampaign(
      fixtures.a.workspaceId,
      inA,
      brandOne,
      'Alpha to archive',
    );
    const itemId = await makeItem(fixtures.a.workspaceId, inA, brandOne, 'Post in archived');
    await inA((db) =>
      serviceA(db).setContentCampaign({
        contentItemId: itemId,
        campaignId,
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );

    await inA((db) =>
      serviceA(db).archive({
        campaignId,
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );

    const item = await inA((db) =>
      db.contentItem.findFirst({ where: { id: itemId }, select: { campaignId: true } }),
    );
    // The post survives, and keeps pointing at the campaign it was filed under.
    expect(item?.campaignId).toBe(campaignId);

    const active = await inA(async (db) =>
      (await serviceA(db).list({ brandScope: [], take: 200 })).map((row) => row.id),
    );
    expect(active).not.toContain(campaignId);

    const withArchived = await inA(async (db) =>
      (await serviceA(db).list({ brandScope: [], includeArchived: true, take: 200 })).map(
        (row) => row.id,
      ),
    );
    expect(withArchived).toContain(campaignId);
  });
});

describe('AC-26.2: every campaign transition writes an audit event', () => {
  it('records creation, update and archival', async () => {
    const before = await inA((db) =>
      db.auditEvent.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    );

    const created = await inA((db) =>
      serviceA(db).create({
        brandId: brandOne,
        name: 'Audited campaign',
        objective: 'ENGAGEMENT',
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );
    await inA((db) =>
      serviceA(db).update({
        campaignId: created.id,
        status: 'ACTIVE',
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );
    await inA((db) =>
      serviceA(db).archive({
        campaignId: created.id,
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );

    const after = await inA((db) =>
      db.auditEvent.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    );
    expect(after).toBeGreaterThanOrEqual(before + 3);
  });
});

describe('AC-26.2: an edit made against a stale version is refused', () => {
  it('refuses the second of two edits that both read version 1', async () => {
    const created = await inA((db) =>
      serviceA(db).create({
        brandId: brandOne,
        name: 'Concurrent campaign',
        objective: 'TRAFFIC',
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );

    await inA((db) =>
      serviceA(db).update({
        campaignId: created.id,
        expectedVersion: created.version,
        name: 'First writer wins',
        actor: { userId: fixtures.a.userId, brandScope: [] },
      }),
    );

    await expect(
      inA((db) =>
        serviceA(db).update({
          campaignId: created.id,
          expectedVersion: created.version,
          name: 'Second writer loses',
          actor: { userId: fixtures.a.userId, brandScope: [] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const row = await inA((db) =>
      db.campaign.findFirst({ where: { id: created.id }, select: { name: true } }),
    );
    expect(row?.name).toBe('First writer wins');
  });
});

describe('AN ARCHIVED CAMPAIGN DOES NOT SILENTLY LOSE ITS CONTENT (PHASE 2)', () => {
  /*
   * THE DEFECT THIS SUITE EXISTS FOR.
   *
   * `archive` is a soft delete that deliberately keeps the content in the
   * campaign, and `#require` excludes archived campaigns so a new draft cannot
   * be filed into one. Both correct. What neither covers is the draft that was
   * ALREADY in the campaign when it was archived.
   *
   * The composer renders its campaign control as `defaultValue={campaignId}`
   * over the list of LIVE campaigns. Once the campaign is archived there is no
   * matching option, the browser falls back to the first, and the screen reads
   * "No campaign" — which is false. Saving the draft then posts the empty value
   * and detaches it from a campaign nobody asked to leave. The relationship is
   * destroyed by a form the reader thought they were leaving alone.
   */

  // A FUNCTION, NOT A CONST. `fixtures` is assigned in `beforeAll`, so reading
  // it while the describe body is evaluated is reading it before it exists.
  const actor = () => ({ userId: fixtures.a.userId, brandScope: [] as string[] });

  /*
   * A CAMPAIGN AND A DRAFT OF ITS OWN, PER TEST.
   *
   * Deliberately not the shared fixture campaign: archiving is not reversible
   * within a run, so a helper that archived the fixture would work once and
   * break every test after it — which is exactly what the first version of this
   * suite did, passing alone and failing in the file.
   */
  async function archivedCampaignWithContent(): Promise<{
    campaignId: string;
    itemId: string;
  }> {
    return inA(async (db) => {
      const service = serviceA(db);
      const campaign = await service.create({
        brandId: fixtures.a.brandId,
        name: `Archived ${randomUUID().slice(0, 8)}`,
        objective: 'AWARENESS',
        actor: actor(),
      });
      const item = await db.contentItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          title: `Draft ${randomUUID().slice(0, 8)}`,
          status: 'DRAFT',
          primaryLocale: 'EN',
          createdByUserId: fixtures.a.userId,
        },
      });
      await service.setContentCampaign({
        contentItemId: item.id,
        campaignId: campaign.id,
        actor: actor(),
      });
      await service.archive({ campaignId: campaign.id, actor: actor() });
      return { campaignId: campaign.id, itemId: item.id };
    });
  }

  it('ARCHIVING KEEPS THE LINK — the content is not detached and not deleted', async () => {
    const { campaignId, itemId } = await archivedCampaignWithContent();

    const row = await inA((db) =>
      db.contentItem.findFirst({
        where: { id: itemId },
        select: { campaignId: true, deletedAt: true },
      }),
    );
    expect(row?.campaignId).toBe(campaignId);
    expect(row?.deletedAt).toBeNull();
  });

  it('RE-SAVING THE UNCHANGED CAMPAIGN IS A NO-OP, not a refusal', async () => {
    const { campaignId, itemId } = await archivedCampaignWithContent();

    /*
     * THE ASSERTION THAT FAILS AGAINST THE DEFECT. `#require` refuses an
     * archived campaign, so re-sending the draft's own unchanged value threw —
     * and the reader could not save an unrelated edit until they detached the
     * draft from a campaign they had not asked to leave.
     */
    await expect(
      inA((db) =>
        serviceA(db).setContentCampaign({
          contentItemId: itemId,
          campaignId,
          actor: actor(),
        }),
      ),
    ).resolves.toBeUndefined();

    const row = await inA((db) =>
      db.contentItem.findFirst({ where: { id: itemId }, select: { campaignId: true } }),
    );
    expect(row?.campaignId).toBe(campaignId);
  });

  it('the archived campaign is still findable, so the screen can name it', async () => {
    const { campaignId } = await archivedCampaignWithContent();

    const live = await inA((db) => serviceA(db).list({ brandScope: [], take: 200 }));
    expect(live.some((c) => c.id === campaignId)).toBe(false);

    const withArchived = await inA((db) =>
      serviceA(db).list({ brandScope: [], includeArchived: true, take: 200 }),
    );
    expect(withArchived.some((c) => c.id === campaignId)).toBe(true);
  });

  it('MOVING TO A DIFFERENT CAMPAIGN IS STILL CHECKED — archived is not a way in', async () => {
    const { campaignId } = await archivedCampaignWithContent();

    // A SECOND draft, not currently in that campaign, cannot be filed into it:
    // the no-op only covers a value that is already the item's own.
    const otherItem = await inA(async (db) => {
      const created = await db.contentItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          title: 'Another draft',
          status: 'DRAFT',
          primaryLocale: 'EN',
          createdByUserId: fixtures.a.userId,
        },
      });
      return created.id;
    });

    await expect(
      inA((db) =>
        serviceA(db).setContentCampaign({
          contentItemId: otherItem,
          campaignId,
          actor: actor(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
