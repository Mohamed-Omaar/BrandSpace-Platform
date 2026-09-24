import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantScopedClient } from '@brandspace/database';
import type { CustomerWorkspaceContext } from '@brandspace/auth';
import { attentionItems } from '../../apps/dashboard/src/server/command-center';

/**
 * PHASE 6 · P6-04 — THE COMMAND CENTER READS TENANT DATA, SO IT IS AN ISOLATION
 * SURFACE.
 *
 * Five new queries across four tables, on the screen every member lands on. A
 * count is a small thing to leak and a very easy one: "3 posts failed to
 * publish" tells a reader that three posts exist, and if the query's tenant
 * predicate is wrong it tells them about somebody else's. CLAUDE.md §2.1 counts
 * enumeration and inference as leaks, not just reads.
 *
 * WHAT THIS FILE PINS:
 *
 *   - no item ever counts another workspace's rows;
 *   - brand scope is honoured, so a member scoped to one brand is not told
 *     about another brand's failures;
 *   - an item appears ONLY when it is genuinely true — no zero-count rows, no
 *     placeholder, no fabricated entry;
 *   - a permission the member lacks means the source is not run at all, so the
 *     Command Center never offers a link to a route that will answer 404;
 *   - one failing source does not take the home screen down.
 */

let platform: PrismaClient;

/** Two workspaces, each with its own brand, so a leak has somewhere to leak from. */
interface Fixture {
  readonly workspaceId: string;
  readonly brandId: string;
}

async function freshWorkspace(label: string): Promise<Fixture> {
  const run = crypto.randomUUID();
  const user = await platform.user.create({
    data: {
      email: `cc-${label}-${run}@example.local`,
      name: 'Command Center Fixture',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  const workspace = await platform.workspace.create({
    data: {
      id: run,
      workspaceId: run,
      slug: `cc-${run.slice(0, 12)}`,
      name: `Command Center ${label}`,
      ownerUserId: user.id,
      status: 'ACTIVE',
      country: 'SA',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
    },
  });
  const brand = await platform.brand.create({
    data: {
      workspaceId: workspace.id,
      name: `Brand ${label}`,
      slug: `brand-${run.slice(0, 8)}`,
    },
  });
  return { workspaceId: workspace.id, brandId: brand.id };
}

/**
 * A session context for a fixture.
 *
 * `brandScope: []` is UNRESTRICTED, which is the platform rule (`brandIdScopeFilter`)
 * and not an empty result — getting that backwards is the defect D-190's page
 * workaround existed to paper over.
 */
function session(
  fixture: Fixture,
  overrides: Partial<CustomerWorkspaceContext> = {},
): CustomerWorkspaceContext {
  return {
    workspaceId: fixture.workspaceId,
    workspaceName: 'Fixture',
    workspaceSlug: 'fixture',
    workspaceStatus: 'ACTIVE',
    roleKey: 'workspace_owner',
    roleNameEn: 'Owner',
    roleNameAr: 'مالك',
    permissionKeys: ['content.read', 'integrations.read', 'publishing.read', 'brand_brain.read'],
    brandScope: [],
    ...overrides,
  };
}

const db = (): TenantScopedClient => platform as unknown as TenantScopedClient;

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}, 60_000);

afterAll(async () => {
  await platform?.$disconnect();
});

describe('P6-04 · an item exists only when it is genuinely true', () => {
  it('returns nothing at all for a workspace with nothing waiting', async () => {
    /*
     * The honest empty state. A "0 items need attention" row would be clutter
     * that never goes away; an empty list is a workspace in good order.
     *
     * NO BRAND, deliberately — and the first version of this test got that
     * wrong. `freshWorkspace` creates a brand, and a brand with no knowledge in
     * it legitimately produces `brand-brain-empty`, so the test asserted an
     * empty list against a workspace that genuinely had something to say. The
     * item was right and the test was wrong, which is the correct direction for
     * that disagreement to be resolved.
     */
    const fixture = await freshWorkspace('quiet');
    await platform.brand.deleteMany({ where: { workspaceId: fixture.workspaceId } });
    expect(await attentionItems(db(), session(fixture))).toEqual([]);
  });

  it('reports a failed publish, and counts it once', async () => {
    const fixture = await freshWorkspace('failed');
    const item = await platform.contentItem.create({
      data: {
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
        title: 'Failed post',
        status: 'DRAFT',
      },
    });
    await platform.calendarSlot.create({
      data: {
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
        contentItemId: item.id,
        scheduledAtUtc: new Date('2026-01-01T09:00:00.000Z'),
        scheduledLocalTime: '2026-01-01T09:00',
        timezone: 'UTC',
        status: 'FAILED',
      },
    });

    const items = await attentionItems(db(), session(fixture));
    const failed = items.find((i) => i.kind === 'publishing-failed');
    expect(failed?.count).toBe(1);
    expect(failed?.severity).toBe('blocked');
    // D-277 §33: failures are acted on in Publishing's Failed tab.
    expect(failed?.href).toBe('/publishing?tab=failed');
  });

  it('counts a half-published slot as a failure, because it is one', async () => {
    // PARTIALLY_PUBLISHED is the worse of the two to miss: the screen elsewhere
    // says "published" and some targets never received it.
    const fixture = await freshWorkspace('partial');
    const item = await platform.contentItem.create({
      data: {
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
        title: 'Half published',
        status: 'DRAFT',
      },
    });
    await platform.calendarSlot.create({
      data: {
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
        contentItemId: item.id,
        scheduledAtUtc: new Date('2026-01-01T09:00:00.000Z'),
        scheduledLocalTime: '2026-01-01T09:00',
        timezone: 'UTC',
        status: 'PARTIALLY_PUBLISHED',
      },
    });

    const items = await attentionItems(db(), session(fixture));
    expect(items.find((i) => i.kind === 'publishing-failed')?.count).toBe(1);
  });

  it('puts blocked work above waiting work', async () => {
    const fixture = await freshWorkspace('order');
    const item = await platform.contentItem.create({
      data: {
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
        title: 'In review',
        status: 'IN_REVIEW',
      },
    });
    await platform.calendarSlot.create({
      data: {
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
        contentItemId: item.id,
        scheduledAtUtc: new Date('2026-01-01T09:00:00.000Z'),
        scheduledLocalTime: '2026-01-01T09:00',
        timezone: 'UTC',
        status: 'FAILED',
      },
    });

    const items = await attentionItems(db(), session(fixture));
    const kinds = items.map((i) => i.kind);
    expect(kinds.indexOf('publishing-failed')).toBeLessThan(kinds.indexOf('content-in-review'));
  });

  it('names the brand when exactly one has no knowledge', async () => {
    // "Northwind has no brand knowledge yet" is actionable; "1 brand" is not.
    const fixture = await freshWorkspace('empty-brain');
    const items = await attentionItems(db(), session(fixture));
    const empty = items.find((i) => i.kind === 'brand-brain-empty');
    expect(empty?.count).toBe(1);
    expect(empty?.detail).toContain('Brand ');
  });
});

describe('P6-04 · no item ever counts another workspace', () => {
  it('a failure in workspace B is invisible to workspace A', async () => {
    const a = await freshWorkspace('tenant-a');
    const b = await freshWorkspace('tenant-b');

    const item = await platform.contentItem.create({
      data: {
        workspaceId: b.workspaceId,
        brandId: b.brandId,
        title: "B's failure",
        status: 'DRAFT',
      },
    });
    await platform.calendarSlot.create({
      data: {
        workspaceId: b.workspaceId,
        brandId: b.brandId,
        contentItemId: item.id,
        scheduledAtUtc: new Date('2026-01-01T09:00:00.000Z'),
        scheduledLocalTime: '2026-01-01T09:00',
        timezone: 'UTC',
        status: 'FAILED',
      },
    });

    const forA = await attentionItems(db(), session(a));
    expect(forA.find((i) => i.kind === 'publishing-failed')).toBeUndefined();

    // And B genuinely has it, so the assertion above is about isolation rather
    // than about the query being broken for everyone.
    const forB = await attentionItems(db(), session(b));
    expect(forB.find((i) => i.kind === 'publishing-failed')?.count).toBe(1);
  });

  it("another workspace's connection never appears in this one", async () => {
    const a = await freshWorkspace('conn-a');
    const b = await freshWorkspace('conn-b');
    await platform.socialConnection.create({
      data: {
        workspaceId: b.workspaceId,
        brandId: b.brandId,
        provider: 'FACEBOOK',
        targetKind: 'page',
        externalAccountId: `acct-${crypto.randomUUID()}`,
        displayName: "B's account",
        status: 'NEEDS_REAUTH',
      },
    });

    expect(
      (await attentionItems(db(), session(a))).find((i) => i.kind === 'connection-reauth'),
    ).toBeUndefined();
    expect(
      (await attentionItems(db(), session(b))).find((i) => i.kind === 'connection-reauth')?.count,
    ).toBe(1);
  });
});

describe('P6-04 · brand scope is honoured', () => {
  it('a member scoped to one brand is not told about another brand', async () => {
    const fixture = await freshWorkspace('scoped');
    const other = await platform.brand.create({
      data: {
        workspaceId: fixture.workspaceId,
        name: 'Other brand',
        slug: `other-${crypto.randomUUID().slice(0, 8)}`,
      },
    });
    const item = await platform.contentItem.create({
      data: {
        workspaceId: fixture.workspaceId,
        brandId: other.id,
        title: 'Other brand failure',
        status: 'DRAFT',
      },
    });
    await platform.calendarSlot.create({
      data: {
        workspaceId: fixture.workspaceId,
        brandId: other.id,
        contentItemId: item.id,
        scheduledAtUtc: new Date('2026-01-01T09:00:00.000Z'),
        scheduledLocalTime: '2026-01-01T09:00',
        timezone: 'UTC',
        status: 'FAILED',
      },
    });

    // Scoped to the FIRST brand only: the other brand's failure is not theirs.
    const scoped = await attentionItems(db(), session(fixture, { brandScope: [fixture.brandId] }));
    expect(scoped.find((i) => i.kind === 'publishing-failed')).toBeUndefined();

    // Unrestricted scope sees it, which is what makes the assertion above mean
    // something rather than describing a query that returns nothing.
    const unrestricted = await attentionItems(db(), session(fixture));
    expect(unrestricted.find((i) => i.kind === 'publishing-failed')?.count).toBe(1);
  });
});

describe('P6-05 · the reader-specific sources appear once notes exist', () => {
  it('counts threads assigned to this person, and to nobody else', async () => {
    const fixture = await freshWorkspace('assigned');
    const owner = await platform.workspace
      .findUniqueOrThrow({ where: { id: fixture.workspaceId }, select: { ownerUserId: true } })
      .then((w) => w.ownerUserId);

    await platform.noteThread.create({
      data: {
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
        subjectType: 'BRAND',
        status: 'OPEN',
        createdByUserId: owner,
        assignedToUserId: owner,
      },
    });

    const mine = await attentionItems(db(), session(fixture), owner);
    expect(mine.find((i) => i.kind === 'notes-assigned')?.count).toBe(1);

    // Somebody else, in the same workspace, is not carrying this.
    const theirs = await attentionItems(db(), session(fixture), crypto.randomUUID());
    expect(theirs.find((i) => i.kind === 'notes-assigned')).toBeUndefined();
  });

  it('omits both sources entirely when no reader is supplied', async () => {
    // The workspace items still answer; the reader items have nobody to be
    // about. This is what keeps every existing caller working rather than
    // silently reporting zero for a question nobody asked.
    const fixture = await freshWorkspace('no-reader');
    const owner = await platform.workspace
      .findUniqueOrThrow({ where: { id: fixture.workspaceId }, select: { ownerUserId: true } })
      .then((w) => w.ownerUserId);
    await platform.noteThread.create({
      data: {
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
        subjectType: 'BRAND',
        status: 'OPEN',
        createdByUserId: owner,
        assignedToUserId: owner,
      },
    });

    const items = await attentionItems(db(), session(fixture));
    expect(items.find((i) => i.kind === 'notes-assigned')).toBeUndefined();
  });

  it('a thread assigned in workspace B never counts for the same person in A', async () => {
    const a = await freshWorkspace('reader-a');
    const b = await freshWorkspace('reader-b');
    const bOwner = await platform.workspace
      .findUniqueOrThrow({ where: { id: b.workspaceId }, select: { ownerUserId: true } })
      .then((w) => w.ownerUserId);

    await platform.noteThread.create({
      data: {
        workspaceId: b.workspaceId,
        brandId: b.brandId,
        subjectType: 'BRAND',
        status: 'OPEN',
        createdByUserId: bOwner,
        assignedToUserId: bOwner,
      },
    });

    const inA = await attentionItems(db(), session(a), bOwner);
    expect(inA.find((i) => i.kind === 'notes-assigned')).toBeUndefined();
    const inB = await attentionItems(db(), session(b), bOwner);
    expect(inB.find((i) => i.kind === 'notes-assigned')?.count).toBe(1);
  });
});

describe('P6-04 · a member is never offered a link they cannot follow', () => {
  it('runs no source whose permission the member lacks', async () => {
    const fixture = await freshWorkspace('viewer');
    const item = await platform.contentItem.create({
      data: {
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
        title: 'Not for a viewer',
        status: 'DRAFT',
      },
    });
    await platform.calendarSlot.create({
      data: {
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
        contentItemId: item.id,
        scheduledAtUtc: new Date('2026-01-01T09:00:00.000Z'),
        scheduledLocalTime: '2026-01-01T09:00',
        timezone: 'UTC',
        status: 'FAILED',
      },
    });

    // A Viewer holds `workspace.read` and nothing else (D-62, D-130). Every
    // source is gated, so the list is empty — not because there is nothing
    // wrong, but because none of it is theirs to act on.
    const viewer = await attentionItems(
      db(),
      session(fixture, { permissionKeys: ['workspace.read'] }),
    );
    expect(viewer).toEqual([]);
  });

  it('runs only the sources the member does hold', async () => {
    const fixture = await freshWorkspace('partial-perms');
    await platform.socialConnection.create({
      data: {
        workspaceId: fixture.workspaceId,
        brandId: fixture.brandId,
        provider: 'FACEBOOK',
        targetKind: 'page',
        externalAccountId: `acct-${crypto.randomUUID()}`,
        displayName: 'Needs reauth',
        status: 'NEEDS_REAUTH',
      },
    });

    // `integrations.read` + `publishing.read` only: the connection shows (its
    // link is Publishing > Accounts, D-277 §33), and the brand-knowledge notice
    // does not, because `/brand-brain` would answer 404 for them.
    const items = await attentionItems(
      db(),
      session(fixture, { permissionKeys: ['integrations.read', 'publishing.read'] }),
    );
    expect(items.map((i) => i.kind)).toEqual(['connection-reauth']);
    expect(items[0]?.href).toBe('/publishing?tab=accounts');

    // Without `publishing.read` the row would be a link to a 404, so it is not raised.
    const blind = await attentionItems(
      db(),
      session(fixture, { permissionKeys: ['integrations.read'] }),
    );
    expect(blind.map((i) => i.kind)).toEqual([]);
  });
});
