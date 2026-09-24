import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { parsePublishingPolicy } from '@brandspace/social-connectors';
import { publishReadiness } from '../../apps/dashboard/src/server/publish-readiness';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 6 · P6-10 — PUBLISHING READINESS IS A READ OF TENANT DATA, SO IT IS AN
 * ISOLATION SURFACE.
 *
 * WHAT WOULD LEAK IF IT WERE WRONG, and it is subtler than a list. Readiness
 * answers one word per scheduled post, and the word is derived from rows the
 * reader may not be allowed to see. "Ready" about a brand outside the reader's
 * scope discloses that an account is connected to it; "needs reconnecting"
 * discloses that one exists and is broken. CLAUDE.md §2.1 counts inference as a
 * leak, and a single derived adjective is inference in its purest form.
 *
 * AGAINST THE APPLICATION ROLE, NOT THE PLATFORM ONE. These run through
 * `withWorkspace` on `appRoleClient()`, so PostgreSQL RLS is live and FORCED —
 * which means a passing assertion here is evidence about the database rather
 * than about the object this code builds.
 *
 * WHAT THIS FILE PINS:
 *
 *   - a connection in another workspace never makes a slot READY;
 *   - a brand-scoped member is told NOT_CONNECTED about a brand outside their
 *     scope, which is the same answer a genuinely unconnected brand gives —
 *     indistinguishable, which is the point (§2.1: masked, not forbidden);
 *   - within scope, the same member gets the true answer, so the masking is not
 *     just a blanket refusal;
 *   - the read carries a workspace predicate of its own, so RLS is the second
 *     layer rather than the only one.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;

/** Instagram and LinkedIn switched on, because the shipped default is off. */
const BASE = parsePublishingPolicy({});
const POLICY = {
  ...BASE,
  providers: {
    ...BASE.providers,
    instagram: { ...BASE.providers.instagram, enabled: true },
    linkedin: { ...BASE.providers.linkedin, enabled: true },
  },
};

const NOW = new Date('2026-09-23T12:00:00.000Z');

/** A second brand in workspace A, so "another brand" is a real place. */
let brandA2: string;

async function connect(workspaceId: string, brandId: string, displayName: string): Promise<string> {
  return withWorkspace(
    workspaceId,
    async (db) => {
      const row = await db.socialConnection.create({
        data: {
          workspaceId,
          brandId,
          provider: 'INSTAGRAM',
          externalAccountId: `ext-${crypto.randomUUID()}`,
          displayName,
          targetKind: 'PROFILE',
          status: 'ACTIVE',
          connectedAt: NOW,
        },
      });
      return row.id;
    },
    { prisma: app },
  );
}

/** A scheduled slot on a brand, and the readiness answer a member gets for it. */
async function readinessFor(input: {
  workspaceId: string;
  brandId: string;
  brandScope: readonly string[];
}): Promise<string | undefined> {
  return withWorkspace(
    input.workspaceId,
    async (db) => {
      const map = await publishReadiness({
        db,
        workspaceId: input.workspaceId,
        policy: POLICY,
        brandScope: input.brandScope,
        now: NOW,
        slots: [
          {
            slotId: 'slot-under-test',
            brandId: input.brandId,
            status: 'SCHEDULED',
            variantPlatformKeys: ['instagram'],
          },
        ],
      });
      return map.get('slot-under-test')?.state;
    },
    { prisma: app },
  );
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);

  brandA2 = await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      const brand = await db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          slug: `readiness-second-${Date.now()}`,
          name: 'Second Brand',
          defaultLocale: 'EN',
          status: 'ACTIVE',
        },
      });
      return brand.id;
    },
    { prisma: app },
  );

  // A healthy account on EVERY brand involved, so every negative answer below
  // is the scope refusing rather than an absence of data.
  await connect(fixtures.a.workspaceId, fixtures.a.brandId, '@a-primary');
  await connect(fixtures.a.workspaceId, brandA2, '@a-second');
  await connect(fixtures.b.workspaceId, fixtures.b.brandId, '@b-primary');
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('P6-10 · readiness never crosses a workspace', () => {
  it('reads its own workspace correctly, so the negatives below mean something', async () => {
    const state = await readinessFor({
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      brandScope: [],
    });
    expect(state).toBe('READY');
  });

  it("never sees another workspace's connection, even asked for its brand", async () => {
    /*
     * WORKSPACE A ASKING ABOUT WORKSPACE B'S BRAND. The brand id is real and
     * the connection behind it is healthy, so a read that reached it would
     * answer READY — and that one word would confirm both that the brand
     * exists and that an account is connected to it. Under RLS the row is not
     * there to be found, and the answer is the same NOT_CONNECTED a brand with
     * no account gives.
     */
    const state = await readinessFor({
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.b.brandId,
      brandScope: [],
    });
    expect(state).toBe('NOT_CONNECTED');
  });

  it('and the same in the other direction', async () => {
    const state = await readinessFor({
      workspaceId: fixtures.b.workspaceId,
      brandId: fixtures.a.brandId,
      brandScope: [],
    });
    expect(state).toBe('NOT_CONNECTED');
  });
});

describe('P6-10 · BrandScope is honoured against real rows', () => {
  it('tells a scoped member the truth about a brand inside their scope', async () => {
    const state = await readinessFor({
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      brandScope: [fixtures.a.brandId],
    });
    expect(state).toBe('READY');
  });

  it('masks a brand outside their scope as NOT_CONNECTED', async () => {
    /*
     * THE SAME ANSWER AN UNCONNECTED BRAND GIVES, deliberately. A distinct
     * "forbidden" state would tell a brand-restricted member that the other
     * brand has an account — which is the disclosure the scope exists to
     * prevent. Indistinguishable from a genuine miss is the rule (§2.1).
     */
    const state = await readinessFor({
      workspaceId: fixtures.a.workspaceId,
      brandId: brandA2,
      brandScope: [fixtures.a.brandId],
    });
    expect(state).toBe('NOT_CONNECTED');
  });

  it('an empty scope is UNRESTRICTED, not "no brands"', async () => {
    /*
     * The platform rule since Phase 2B. Reading an empty scope as "nothing"
     * fails closed but wrongly: every unrestricted member — which is most of
     * them — would be told their whole month is blocked.
     */
    const state = await readinessFor({
      workspaceId: fixtures.a.workspaceId,
      brandId: brandA2,
      brandScope: [],
    });
    expect(state).toBe('READY');
  });

  it('does not let a wide scope widen the read past the slots it was given', async () => {
    // The scope INTERSECTS the brand set. A member scoped to both brands asking
    // about one gets an answer about that one.
    const state = await readinessFor({
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      brandScope: [fixtures.a.brandId, brandA2],
    });
    expect(state).toBe('READY');
  });
});
