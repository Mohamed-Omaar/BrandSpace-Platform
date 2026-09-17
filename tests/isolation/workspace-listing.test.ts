import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_PAGE_SIZE,
  MAX_WORKSPACE_PAGE_SIZE,
  WorkspaceAdminService,
} from '@brandspace/auth';
import { ensurePlatformRbac, ensurePlatformRole } from './fixtures';

/**
 * A-11. THE WORKSPACE DIRECTORY WAS A SILENT DISPLAY CAP.
 *
 * `WorkspaceService.list` took 200 rows and returned them as the answer: no
 * total, no navigation, and nothing on screen to say more existed. An operator
 * with 201 customers stopped seeing one and had no way to tell. F-53 rejected
 * exactly this for secrets and recorded that the same shape survived here.
 *
 * The contract asserted below is the one `docs/ADMIN-CONTROL-CENTER.md` §7.1
 * states: bounded reads, a total order, an honest range, and a page-size cap
 * that bounds a REQUEST rather than what an operator may see.
 */

let platform: PrismaClient;
let service: WorkspaceAdminService;
let platformUserId: string;

/** A run-scoped marker so assertions are about this run's rows only. */
const RUN = `wslist-${randomUUID().slice(0, 8)}`;

function actor() {
  return {
    platformUserId,
    roleKey: 'platform_owner',
    mfaVerified: true,
    permissionKeys: ['platform.workspace.read'],
  };
}

/** Scope every query to this run, so a shared database cannot perturb it. */
function scoped(extra: Record<string, unknown> = {}) {
  return { query: RUN, ...extra };
}

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  await ensurePlatformRbac(platform);
  const roleId = await ensurePlatformRole(platform);
  const owner = await platform.platformUser.create({
    data: {
      email: `wslist-${randomUUID()}@brandspace.local`,
      name: 'Workspace listing owner',
      status: 'ACTIVE',
      roleId,
    },
  });
  platformUserId = owner.id;
  service = new WorkspaceAdminService({ prisma: platform });
}, 90_000);

afterAll(async () => {
  // A-11: this suite creates workspaces to page through, and removes them.
  await platform?.workspace.deleteMany({ where: { slug: { startsWith: RUN } } });
  await platform?.user.deleteMany({ where: { email: { contains: RUN } } });
  await platform?.$disconnect();
});

/** `count` workspaces whose name and slug both carry this run's marker. */
async function seedWorkspaces(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const suffix = `${RUN}-${String(i).padStart(3, '0')}`;
    const user = await platform.user.create({
      data: {
        email: `${suffix}@example.local`,
        name: 'Listing fixture',
        status: 'ACTIVE',
        timezone: 'UTC',
      },
    });
    // `workspace_tenant_key_matches_id` requires the two to agree: the tenant
    // key IS the id, which is what makes every RLS predicate one comparison.
    const workspaceId = randomUUID();
    await platform.workspace.create({
      data: {
        defaultLocale: 'EN',
        timezone: 'UTC',
        currency: 'USD',
        id: workspaceId,
        workspaceId,
        slug: suffix,
        name: `Listing ${suffix}`,
        ownerUserId: user.id,
        status: 'ACTIVE',
        country: 'SA',
      },
    });
  }
}

describe('the workspace directory pages instead of silently capping', () => {
  const SEEDED = 60;

  beforeAll(async () => {
    await seedWorkspaces(SEEDED);
  }, 120_000);

  it('reports the true total, not the size of the page', async () => {
    const page = await service.list(actor(), scoped({ pageSize: 25, page: 1 }));

    expect(page.items).toHaveLength(25);
    expect(page.total, 'the total is what makes a cap visible').toBe(SEEDED);
    expect(page.totalPages).toBe(3);
    expect(page.from).toBe(1);
    expect(page.to).toBe(25);
    expect(page.hasNext).toBe(true);
    expect(page.hasPrevious).toBe(false);
  });

  it('reaches every workspace by paging, each exactly once', async () => {
    const seen: string[] = [];
    for (const pageNumber of [1, 2, 3]) {
      const page = await service.list(actor(), scoped({ pageSize: 25, page: pageNumber }));
      seen.push(...page.items.map((w) => w.id));
    }
    expect(seen).toHaveLength(SEEDED);
    expect(new Set(seen).size, 'a total order means no row twice and none missed').toBe(SEEDED);
  });

  it('orders totally, so page boundaries are stable', async () => {
    // Every fixture row is created within the same second, so `createdAt`
    // alone is not a total order — which is exactly when offset paging starts
    // dropping and repeating rows.
    const first = await service.list(actor(), scoped({ pageSize: 10, page: 2 }));
    const again = await service.list(actor(), scoped({ pageSize: 10, page: 2 }));
    expect(again.items.map((w) => w.id)).toEqual(first.items.map((w) => w.id));
  });

  it('recovers from a page beyond the end', async () => {
    const page = await service.list(actor(), scoped({ pageSize: 25, page: 999 }));
    expect(page.page, 'a stale bookmark lands on the last page').toBe(3);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.hasNext).toBe(false);
  });

  it('clamps a nonsensical page and page size rather than throwing', async () => {
    for (const bad of [0, -5, Number.NaN]) {
      const page = await service.list(actor(), scoped({ page: bad }));
      expect(page.page).toBe(1);
    }
    const huge = await service.list(actor(), scoped({ pageSize: 1_000_000 }));
    expect(huge.pageSize).toBe(MAX_WORKSPACE_PAGE_SIZE);
    // The cap bounds the REQUEST; the total still tells the truth.
    expect(huge.total).toBe(SEEDED);
  });

  it('uses a sane default page size', async () => {
    const page = await service.list(actor(), scoped());
    expect(page.pageSize).toBe(DEFAULT_WORKSPACE_PAGE_SIZE);
  });

  it('narrows the TOTAL when filtered, not just the visible rows', async () => {
    // Server-side filtering. If the filter were applied after the page was
    // read, the total would stay at 60 and the range would be a lie.
    const page = await service.list(actor(), { query: `${RUN}-007` });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.totalPages).toBe(1);
  });

  it('reports zeroes for an empty result, never "1–0 of 0"', async () => {
    const page = await service.list(actor(), { query: `${RUN}-no-such-workspace` });
    expect(page.total).toBe(0);
    expect(page.from).toBe(0);
    expect(page.to).toBe(0);
    expect(page.items).toEqual([]);
    expect(page.hasNext).toBe(false);
  });

  it('still refuses a caller without platform.workspace.read', async () => {
    await expect(service.list({ ...actor(), permissionKeys: [] }, scoped())).rejects.toThrow();
  });
});
