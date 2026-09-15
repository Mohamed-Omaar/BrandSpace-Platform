import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { ActivityLogService } from '@brandspace/activity';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * The Activity Log's SCOPE, against a real PostgreSQL — the adversarial half.
 *
 * WHAT THESE PROVE, and what went wrong without them. The first version of
 * `page()` spread the caller's filter into the SAME object literal as the
 * authorization predicate, after it. In JavaScript the later key wins, so:
 *
 *   `?brandId=<another brand>`  overwrote a brand-graded reader's brand clause
 *   `?actorId=<a colleague>`    overwrote an own-graded reader's `actorId = me`
 *
 * — which turned the query string into a privilege escalation reachable from
 * the address bar. Both are asserted below against real rows, because a unit
 * test over the predicate would only be re-asserting the shape of the object
 * this code builds rather than what the database does with it.
 *
 * The third assertion is the BrandScope rule itself: an empty membership scope
 * means UNRESTRICTED, as `brandInScope()` and `brandScopeFilter()` have meant
 * since Phase 2B. Reading it as "no brands" failed closed but wrongly, and put
 * this reader out of step with every other list in the product.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;

/** A second brand and two events in it, so "another brand" is a real place. */
let brandB2: string;
let eventInB2: string;
let eventByStranger: string;
const STRANGER = '31111111-2222-4333-8444-555555555555';

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);

  const seeded = await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      const second = await db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          slug: `activity-scope-${Date.now()}`,
          name: 'Second Brand',
          defaultLocale: 'EN',
          status: 'ACTIVE',
        },
      });
      const other = await db.auditEvent.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          actorType: 'USER',
          actorId: fixtures.a.userId,
          action: 'activity.scope.second_brand',
          brandId: second.id,
        },
      });
      const stranger = await db.auditEvent.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          actorType: 'USER',
          actorId: STRANGER,
          action: 'activity.scope.stranger',
          brandId: fixtures.a.brandId,
        },
      });
      return { brandId: second.id, otherId: other.id, strangerId: stranger.id };
    },
    { prisma: app },
  );
  brandB2 = seeded.brandId;
  eventInB2 = seeded.otherId;
  eventByStranger = seeded.strangerId;
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

function read<T>(fn: (service: ActivityLogService) => Promise<T>): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    (db) => fn(new ActivityLogService({ db, workspaceId: fixtures.a.workspaceId })),
    { prisma: app },
  );
}

describe('a BRAND-graded reader cannot filter its way into another brand', () => {
  /** Scoped to the FIRST brand only. The second brand is out of reach. */
  const viewer = {
    userId: fixtures?.a.userId ?? '',
    permissionKeys: ['audit.read'],
    get brandScope() {
      return [fixtures.a.brandId];
    },
  };

  it('sees its own brand and not the other one', async () => {
    const page = await read((s) =>
      s.page({
        viewer: { ...viewer, userId: fixtures.a.userId, brandScope: [fixtures.a.brandId] },
        take: 100,
      }),
    );
    expect(page.scope).toBe('brand');
    expect(page.entries.map((e) => e.id)).not.toContain(eventInB2);
  });

  it('CANNOT use ?brandId to read the brand it is not scoped to', async () => {
    const page = await read((s) =>
      s.page({
        viewer: { ...viewer, userId: fixtures.a.userId, brandScope: [fixtures.a.brandId] },
        filter: { brandId: brandB2 },
        take: 100,
      }),
    );
    // The filter INTERSECTS the scope, so naming a brand outside it returns
    // nothing — rather than replacing the scope and returning that brand.
    expect(page.entries).toHaveLength(0);
  });

  it('a filter INSIDE the scope still narrows, as a filter should', async () => {
    const page = await read((s) =>
      s.page({
        viewer: { ...viewer, userId: fixtures.a.userId, brandScope: [fixtures.a.brandId] },
        filter: { brandId: fixtures.a.brandId },
        take: 100,
      }),
    );
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries.every((e) => e.brandId === fixtures.a.brandId)).toBe(true);
  });

  it('the filter OPTIONS are drawn from the reader’s own scope, not the workspace', async () => {
    const actions = await read((s) =>
      s.actions({
        viewer: { ...viewer, userId: fixtures.a.userId, brandScope: [fixtures.a.brandId] },
      }),
    );
    // The second brand's action must not be offered: a dropdown listing it
    // would enumerate what happened somewhere the reader cannot look.
    expect(actions).not.toContain('activity.scope.second_brand');
  });
});

describe('an OWN-graded reader cannot filter its way into another member', () => {
  const viewer = {
    userId: '',
    permissionKeys: ['audit.read_own'],
    brandScope: [] as string[],
  };

  it('sees only its own actions', async () => {
    const page = await read((s) =>
      s.page({ viewer: { ...viewer, userId: fixtures.a.userId }, take: 100 }),
    );
    expect(page.scope).toBe('own');
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries.every((e) => e.actorId === fixtures.a.userId)).toBe(true);
    expect(page.entries.map((e) => e.id)).not.toContain(eventByStranger);
  });

  it('CANNOT use ?actorId to read a colleague’s actions', async () => {
    const page = await read((s) =>
      s.page({
        viewer: { ...viewer, userId: fixtures.a.userId },
        filter: { actorId: STRANGER },
        take: 100,
      }),
    );
    // `actorId = me AND actorId = them` is satisfiable by nobody, which is the
    // correct answer. Before the fix the caller's value REPLACED `me`.
    expect(page.entries).toHaveLength(0);
  });

  it('CANNOT use ?brandId to reach past its own actions either', async () => {
    const page = await read((s) =>
      s.page({
        viewer: { ...viewer, userId: fixtures.a.userId },
        filter: { brandId: brandB2 },
        take: 100,
      }),
    );
    expect(page.entries.every((e) => e.actorId === fixtures.a.userId)).toBe(true);
  });
});

describe('the platform BrandScope rule: empty means UNRESTRICTED', () => {
  it('`audit.read` with an EMPTY brandScope sees every brand in the workspace', async () => {
    /*
     * The rule `brandInScope()` and `brandScopeFilter()` have carried since
     * Phase 2B: a membership listing no brands is scoped to all of them. The
     * first version of `resolveActivityScope` read an empty list as "no
     * brands", which would have shown an unrestricted Marketing Manager or
     * Analyst an empty log.
     */
    const page = await read((s) =>
      s.page({
        viewer: { userId: fixtures.a.userId, permissionKeys: ['audit.read'], brandScope: [] },
        take: 200,
      }),
    );
    expect(page.scope).toBe('brand');
    const ids = page.entries.map((e) => e.id);
    expect(ids).toContain(eventInB2);
    expect(ids).toContain(eventByStranger);
  });

  it('a RESTRICTED scope still restricts — the rule is not "always unrestricted"', async () => {
    const page = await read((s) =>
      s.page({
        viewer: {
          userId: fixtures.a.userId,
          permissionKeys: ['audit.read'],
          brandScope: [fixtures.a.brandId],
        },
        take: 200,
      }),
    );
    expect(page.entries.map((e) => e.id)).not.toContain(eventInB2);
  });

  it('a reader with NO activity grade sees nothing, whatever it filters by', async () => {
    const page = await read((s) =>
      s.page({
        viewer: { userId: fixtures.a.userId, permissionKeys: ['workspace.read'], brandScope: [] },
        filter: { brandId: fixtures.a.brandId, actorId: fixtures.a.userId },
        take: 100,
      }),
    );
    expect(page.scope).toBe('none');
    expect(page.entries).toHaveLength(0);
  });
});
