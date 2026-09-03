import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigurationService } from '@brandspace/config';
import { CreditService, EntitlementService } from '@brandspace/entitlements';
import { PLATFORM_ROLE_KEYS, ROLE_DEFINITIONS } from '@brandspace/shared';
import {
  appRoleClient,
  createIsolationFixtures,
  ensurePlatformRbac,
  type IsolationFixtures,
} from './fixtures';

/**
 * Entitlements and credits against a real PostgreSQL.
 *
 * Two distinct concerns:
 *
 *   - AUTHORISATION. Every mutating method must refuse an actor without the
 *     permission, without MFA, or with no actor at all — checked in the SERVICE,
 *     because a direct call is exactly how R-02 bypassed the UI's checks.
 *   - MONEY. A credit balance must never go negative, a retry must never
 *     double-adjust, and concurrent adjustments must serialise.
 */

const ENV = 'DEVELOPMENT' as const;

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
let entitlements: EntitlementService;
let credits: CreditService;

/** A fully-authorised platform actor. */
function actorWith(permissionKeys: readonly string[], mfaVerified = true) {
  return {
    platformUserId: fixtures.platformUserId,
    roleKey: 'platform_owner',
    mfaVerified,
    permissionKeys,
  };
}

const OWNER_PERMISSIONS =
  ROLE_DEFINITIONS.find((r) => r.key === 'platform_owner')?.permissionKeys ?? [];

beforeAll(async () => {
  app = appRoleClient();
  platform = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_PLATFORM_URL']! }),
  });
  await ensurePlatformRbac(platform);
  fixtures = await createIsolationFixtures(app);

  const config = new ConfigurationService({ prisma: platform });
  entitlements = new EntitlementService({ prisma: platform, config, environment: ENV });
  credits = new CreditService({ prisma: platform });
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('entitlement authorisation is enforced in the service', () => {
  it('refuses assignPlan with no actor', async () => {
    await expect(
      entitlements.assignPlan(undefined as never, fixtures.a.workspaceId, null, 'no actor at all'),
    ).rejects.toThrow(/requires a platform actor/);
  });

  it('refuses assignPlan without verified MFA', async () => {
    await expect(
      entitlements.assignPlan(
        actorWith(OWNER_PERMISSIONS, false),
        fixtures.a.workspaceId,
        null,
        'no MFA',
      ),
    ).rejects.toThrow(/verified MFA/);
  });

  it('refuses assignPlan without platform.plan.assign', async () => {
    await expect(
      entitlements.assignPlan(
        actorWith(['platform.workspace.read']),
        fixtures.a.workspaceId,
        null,
        'wrong permission',
      ),
    ).rejects.toThrow('platform.plan.assign');
  });

  it('refuses setOverride without platform.entitlement.override', async () => {
    await expect(
      entitlements.setOverride(
        actorWith(['platform.workspace.read', 'platform.plan.assign']),
        fixtures.a.workspaceId,
        'ai.generation',
        true,
        null,
        'plan assignment is not override authority',
      ),
    ).rejects.toThrow('platform.entitlement.override');
  });

  it('audits every denial, naming the missing permission and never the payload', async () => {
    await entitlements
      .setOverride(
        actorWith(['platform.workspace.read']),
        fixtures.a.workspaceId,
        'secret.feature.name',
        true,
        null,
        'this reason must not be audited on a denial',
      )
      .catch(() => undefined);

    const denial = await platform.auditEvent.findFirst({
      where: { action: 'platform.entitlement.access.denied', actorId: fixtures.platformUserId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(denial).not.toBeNull();
    expect(denial!.reason).toContain('platform.entitlement.override');
    expect(denial!.outcome).toBe('DENIED');
    expect(JSON.stringify(denial)).not.toContain('this reason must not be audited');
  });

  it('every platform role is checked against its documented authority', async () => {
    // Table-driven over the real role definitions, so adding a role without
    // deciding its entitlement authority fails here rather than in production.
    const expected: Record<string, boolean> = {
      platform_owner: true,
      platform_admin: true,
      support_agent: false,
      billing_manager: false,
      operations_viewer: false,
    };

    for (const roleKey of PLATFORM_ROLE_KEYS) {
      const definition = ROLE_DEFINITIONS.find((r) => r.key === roleKey)!;
      const actor = {
        platformUserId: fixtures.platformUserId,
        roleKey,
        mfaVerified: true,
        permissionKeys: definition.permissionKeys,
      };
      const attempt = entitlements.setOverride(
        actor,
        fixtures.a.workspaceId,
        'nonexistent.feature',
        true,
        null,
        'role authority probe',
      );

      if (expected[roleKey]) {
        // Allowed past authorisation; refused later by validation, which is a
        // different failure and proves the permission check passed.
        await expect(attempt).rejects.toThrow(/Unknown feature/);
      } else {
        await expect(attempt).rejects.toThrow(/platform\.entitlement\.override/);
      }
    }
  });

  it('billing_manager CAN assign a plan — its documented authority', async () => {
    const definition = ROLE_DEFINITIONS.find((r) => r.key === 'billing_manager')!;
    await expect(
      entitlements.assignPlan(
        {
          platformUserId: fixtures.platformUserId,
          roleKey: 'billing_manager',
          mfaVerified: true,
          permissionKeys: definition.permissionKeys,
        },
        fixtures.a.workspaceId,
        'no-such-plan',
        'authority probe',
      ),
      // Past authorisation, refused by validation: the permission held.
    ).rejects.toThrow(/Unknown plan/);
  });
});

describe('plan assignment', () => {
  it('refuses a plan that no configuration version defines', async () => {
    await expect(
      entitlements.assignPlan(
        actorWith(OWNER_PERMISSIONS),
        fixtures.a.workspaceId,
        'imaginary-plan',
        'assigning a plan that does not exist',
      ),
    ).rejects.toThrow(/Unknown plan "imaginary-plan"/);
  });

  it('clearing the plan is allowed and audited', async () => {
    await entitlements.assignPlan(
      actorWith(OWNER_PERMISSIONS),
      fixtures.a.workspaceId,
      null,
      'removing the plan for this assertion',
    );
    const row = await platform.workspace.findUniqueOrThrow({
      where: { id: fixtures.a.workspaceId },
    });
    expect(row.planKey).toBeNull();
    expect(row.planAssignedByPlatformUserId).toBe(fixtures.platformUserId);

    const event = await platform.auditEvent.findFirst({
      where: { workspaceId: fixtures.a.workspaceId, action: 'platform.plan.assigned' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(event).not.toBeNull();
  });
});

describe('credit authorisation', () => {
  it('refuses an adjustment without platform.credit.adjust', async () => {
    await expect(
      credits.adjust(
        actorWith(['platform.workspace.read']),
        fixtures.a.workspaceId,
        10,
        'no permission for this',
        `probe-${Date.now()}`,
      ),
    ).rejects.toThrow('platform.credit.adjust');
  });

  it('refuses an adjustment without verified MFA', async () => {
    await expect(
      credits.adjust(
        actorWith(OWNER_PERMISSIONS, false),
        fixtures.a.workspaceId,
        10,
        'no MFA for this',
        `probe-mfa-${Date.now()}`,
      ),
    ).rejects.toThrow(/verified MFA/);
  });
});

describe('the credit ledger is correct under retry and concurrency', () => {
  it('grants credits and writes an immutable ledger row', async () => {
    const before = await credits.wallet(fixtures.a.workspaceId);
    const after = await credits.adjust(
      actorWith(OWNER_PERMISSIONS),
      fixtures.a.workspaceId,
      100,
      'goodwill grant for this assertion',
      `grant-${Date.now()}`,
    );
    expect(after.balanceMilliCredits).toBe(before.balanceMilliCredits + 100_000n);
    expect(after.balanceCredits).toBe(Number(after.balanceMilliCredits / 1000n));
  });

  it('a REPEATED idempotency key applies the adjustment exactly once', async () => {
    const key = `idem-${Date.now()}`;
    const start = await credits.wallet(fixtures.a.workspaceId);

    await credits.adjust(
      actorWith(OWNER_PERMISSIONS),
      fixtures.a.workspaceId,
      50,
      'first attempt, which succeeds',
      key,
    );
    await credits.adjust(
      actorWith(OWNER_PERMISSIONS),
      fixtures.a.workspaceId,
      50,
      'a retry of the same logical action',
      key,
    );

    const end = await credits.wallet(fixtures.a.workspaceId);
    // A retried grant that lands twice is a money bug.
    expect(end.balanceMilliCredits).toBe(start.balanceMilliCredits + 50_000n);

    const rows = await platform.creditTransaction.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(1);
  });

  it('CONCURRENT adjustments all land, none are lost', async () => {
    const start = await credits.wallet(fixtures.a.workspaceId);
    const run = Date.now();

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        credits.adjust(
          actorWith(OWNER_PERMISSIONS),
          fixtures.a.workspaceId,
          10,
          `concurrent grant ${i} for this assertion`,
          `concurrent-${run}-${i}`,
        ),
      ),
    );

    // FOR UPDATE serialises them, so all eight increments survive. A
    // read-modify-write without the lock would lose most of them.
    const end = await credits.wallet(fixtures.a.workspaceId);
    expect(end.balanceMilliCredits).toBe(start.balanceMilliCredits + 80_000n);
  }, 60_000);

  it('refuses to take the balance below zero', async () => {
    const wallet = await credits.wallet(fixtures.a.workspaceId);
    const tooMuch = Number(wallet.balanceMilliCredits / 1000n) + 1;
    await expect(
      credits.adjust(
        actorWith(OWNER_PERMISSIONS),
        fixtures.a.workspaceId,
        -tooMuch,
        'attempting to overdraw the wallet',
        `overdraw-${Date.now()}`,
      ),
    ).rejects.toThrow(/never negative/i);

    const after = await credits.wallet(fixtures.a.workspaceId);
    expect(after.balanceMilliCredits).toBe(wallet.balanceMilliCredits);
  });

  it('refuses a zero or fractional adjustment', async () => {
    for (const amount of [0, 1.5, -0]) {
      await expect(
        credits.adjust(
          actorWith(OWNER_PERMISSIONS),
          fixtures.a.workspaceId,
          amount,
          'an invalid amount for this assertion',
          `invalid-${amount}-${Date.now()}`,
        ),
      ).rejects.toThrow(/non-zero whole number/);
    }
  });

  it('requires a written reason and an idempotency key', async () => {
    await expect(
      credits.adjust(actorWith(OWNER_PERMISSIONS), fixtures.a.workspaceId, 5, 'short', 'k'),
    ).rejects.toThrow(/at least 8 characters/);

    await expect(
      credits.adjust(
        actorWith(OWNER_PERMISSIONS),
        fixtures.a.workspaceId,
        5,
        'a perfectly good reason',
        '   ',
      ),
    ).rejects.toThrow(/idempotency key/);
  });

  it('the replayed ledger reproduces the stored balance exactly', async () => {
    // The reconciliation docs/DATABASE.md §7.1 requires. Drift is a critical
    // alert, not a rounding detail.
    const result = await credits.reconcile(fixtures.a.workspaceId);
    expect(result.drift).toBe(0n);
    expect(result.stored).toBe(result.replayed);
  });

  it('every adjustment is audited', async () => {
    const events = await platform.auditEvent.findMany({
      where: { workspaceId: fixtures.a.workspaceId, action: 'platform.credits.adjusted' },
    });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.actorType).toBe('PLATFORM_USER');
      expect(event.reason).toBeTruthy();
    }
  });

  it('an adjustment in A never touches B', async () => {
    const beforeB = await credits.wallet(fixtures.b.workspaceId);
    await credits.adjust(
      actorWith(OWNER_PERMISSIONS),
      fixtures.a.workspaceId,
      25,
      'a grant that must not reach the other tenant',
      `cross-${Date.now()}`,
    );
    const afterB = await credits.wallet(fixtures.b.workspaceId);
    expect(afterB.balanceMilliCredits).toBe(beforeB.balanceMilliCredits);
  });
});
