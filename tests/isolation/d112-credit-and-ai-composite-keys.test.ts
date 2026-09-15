import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * D-112 across Phase 3 and Phase 4 — the five keys F-80 did not reach.
 *
 * WHY THIS SUITE EXISTS. D-112 made the composite workspace-scoped foreign key
 * a PLATFORM-WIDE rule, but it was written while fixing Brand Brain and applied
 * only there. The cross-phase audit machine-checked every tenant-owned relation
 * in the schema and found five older ones still referencing a tenant-owned
 * parent by id alone: three onto `credit_wallet`, and two inside the AI usage
 * ledger.
 *
 * TWO OF THEM WERE DEMONSTRATED BEFORE THE FIX. From inside workspace A, a
 * `credit_transaction` naming workspace B's wallet and an `ai_usage_ledger` row
 * naming workspace B's `ai_request` were both ACCEPTED — PostgreSQL evaluates
 * referential integrity as the table owner with RLS bypassed, so the plain key
 * resolved the other tenant's row.
 *
 * The credit keys are the worse pair: they attach a MONEY LEDGER row to another
 * tenant's wallet. The application never does this — it resolves the wallet
 * from the workspace and never accepts a wallet id from input — which is
 * exactly why it survived. CLAUDE.md §2.1 requires two independent layers, and
 * the second was open.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

type Db = Parameters<Parameters<typeof withWorkspace>[1]>[0];
const inA = <T>(fn: (db: Db) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

/** Everything a refused write tells the caller. Mirrors `f80-…`'s helper. */
interface Refusal {
  readonly code: string;
  readonly sqlState: string;
  readonly constraint: string;
  readonly detail: string;
}

async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise;
  } catch (error: unknown) {
    const e = error as {
      code?: unknown;
      meta?: {
        driverAdapterError?: {
          cause?: {
            originalCode?: unknown;
            originalMessage?: unknown;
            constraint?: { index?: unknown };
          };
        };
      };
    };
    const cause = e.meta?.driverAdapterError?.cause;
    return {
      code: String(e.code),
      sqlState: String(cause?.originalCode),
      constraint: String(cause?.constraint?.index),
      detail: String(cause?.originalMessage),
    };
  }
  throw new Error('the write was ACCEPTED; the D-112 composite key has regressed');
}

const fabricatedId = (): string => randomUUID();

const transactionFor = (walletId: string) =>
  inA((db) =>
    db.creditTransaction.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        walletId,
        type: 'PLAN_GRANT',
        amountMilliCredits: 1n,
        balanceAfterMilliCredits: 1n,
        reason: 'd112 probe',
        idempotencyKey: `d112-tx-${randomUUID()}`,
        actorType: 'SYSTEM',
      },
    }),
  );

const ledgerFor = (aiRequestId: string) =>
  inA((db) =>
    db.aiUsageLedger.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        aiRequestId,
        taskKey: 'd112-probe',
        providerKey: 'mock',
        modelKey: 'mock',
        usageUnits: {},
        environment: 'DEVELOPMENT',
      },
    }),
  );

const correctionFor = (correctsLedgerId: string) =>
  inA((db) =>
    db.aiUsageLedger.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        aiRequestId: fixtures.a.aiRequestId,
        correctsLedgerId,
        taskKey: 'd112-probe',
        providerKey: 'mock',
        modelKey: 'mock',
        usageUnits: {},
        environment: 'DEVELOPMENT',
      },
    }),
  );

// ---------------------------------------------------------------------------
// The relationships still work. FIRST, on purpose: a boundary that also blocks
// the product is not a fix, and a suite that only proves refusals cannot tell
// the two apart.
// ---------------------------------------------------------------------------

describe('within one workspace the five relationships still work', () => {
  it('a credit transaction attaches to its own workspace wallet', async () => {
    const created = await transactionFor(fixtures.a.walletId);
    expect(created.walletId).toBe(fixtures.a.walletId);
  });

  it('a usage ledger row attaches to its own workspace request', async () => {
    const created = await ledgerFor(fixtures.a.aiRequestId);
    expect(created.aiRequestId).toBe(fixtures.a.aiRequestId);
  });

  it('a correction references an earlier ledger row in the same workspace', async () => {
    const original = await ledgerFor(fixtures.a.aiRequestId);
    const correction = await correctionFor(original.id);
    expect(correction.correctsLedgerId).toBe(original.id);
  });
});

// ---------------------------------------------------------------------------
// The refusals.
// ---------------------------------------------------------------------------

describe('a tenant-owned parent in ANOTHER workspace is refused', () => {
  it('credit_transaction.walletId cannot reach another workspace wallet', async () => {
    const r = await refusal(transactionFor(fixtures.b.walletId));
    expect(r.code).toBe('P2003');
    expect(r.sqlState).toBe('23503');
    expect(r.constraint).toBe('credit_transaction_wallet_fkey');
  });

  it('ai_usage_ledger.aiRequestId cannot reach another workspace request', async () => {
    const r = await refusal(ledgerFor(fixtures.b.aiRequestId));
    expect(r.code).toBe('P2003');
    expect(r.sqlState).toBe('23503');
    expect(r.constraint).toBe('ai_usage_ledger_request_fkey');
  });
});

// ---------------------------------------------------------------------------
// The oracle itself — what makes the refusals SUFFICIENT rather than merely
// necessary. A boundary that refuses a real foreign id differently from an
// invented one has moved the leak, not closed it.
// ---------------------------------------------------------------------------

describe('the refusal discloses nothing about whether the foreign id exists', () => {
  it('a real foreign wallet id and a fabricated one fail identically', async () => {
    const real = await refusal(transactionFor(fixtures.b.walletId));
    const invented = await refusal(transactionFor(fabricatedId()));
    expect(real).toEqual(invented);
  });

  it('a real foreign request id and a fabricated one fail identically', async () => {
    const real = await refusal(ledgerFor(fixtures.b.aiRequestId));
    const invented = await refusal(ledgerFor(fabricatedId()));
    expect(real).toEqual(invented);
  });

  it('the ledger self-reference answers nothing either', async () => {
    /*
     * THE SHARPEST OF THE FIVE, for the reason F-80 recorded about its own
     * self-reference: `correctsLedgerId` asks "is this ledger id real?" and,
     * under a plain key, answered.
     */
    const foreign = await inA(() =>
      withWorkspace(
        fixtures.b.workspaceId,
        ((db: Db) =>
          db.aiUsageLedger.findFirst({
            where: { workspaceId: fixtures.b.workspaceId },
            select: { id: true },
          })) as never,
        { prisma: app },
      ),
    );
    const foreignId = (foreign as { id: string } | null)?.id;
    expect(foreignId, 'the fixture should give workspace B a ledger row').toBeTruthy();

    const real = await refusal(correctionFor(foreignId as string));
    const invented = await refusal(correctionFor(fabricatedId()));
    expect(real).toEqual(invented);
  });
});

// ---------------------------------------------------------------------------
// The one relationship a composite key cannot express.
// ---------------------------------------------------------------------------

describe('a membership or invitation may only name its own workspace’s role', () => {
  /*
   * `role` is tenant-owned with a NULLABLE tenant key: a system role is shared
   * by every workspace, a custom role belongs to one. A child whose
   * `workspaceId` is NOT NULL can never match a parent row whose `workspaceId`
   * IS NULL, so the composite key the other four keys got is unavailable and a
   * trigger enforces the rule instead.
   *
   * THE APPLICATION ALREADY REFUSED THIS — `invitations.ts` checks it — so what
   * these assertions add is the SECOND layer §2.1 requires. Before the trigger,
   * workspace B could write an invitation naming workspace A's custom role, and
   * permissions resolve straight through `membership.roleId`.
   */
  const inB = <T>(fn: (db: Db) => Promise<T>) =>
    withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

  const invitationNaming = (roleId: string) =>
    inB((db) =>
      db.invitation.create({
        data: {
          workspaceId: fixtures.b.workspaceId,
          email: `d112-role-${randomUUID()}@example.test`,
          roleId,
          tokenHash: `d112-role-${randomUUID()}`,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 86_400_000),
          invitedByUserId: fixtures.b.userId,
        },
      }),
    );

  it('a SYSTEM role is accepted — the rule must not break provisioning', async () => {
    const system = await inB((db) =>
      db.role.findFirst({ where: { workspaceId: null, realm: 'WORKSPACE' }, select: { id: true } }),
    );
    expect(system, 'the seed should provide system workspace roles').toBeTruthy();
    const created = await invitationNaming((system as { id: string }).id);
    expect(created.roleId).toBe((system as { id: string }).id);
  });

  it('ANOTHER workspace’s custom role is refused', async () => {
    const foreign = await inA((db) =>
      db.role.findFirst({
        where: { workspaceId: fixtures.a.workspaceId },
        select: { id: true },
      }),
    );
    expect(foreign, 'the fixture should give workspace A a custom role').toBeTruthy();

    await expect(invitationNaming((foreign as { id: string }).id)).rejects.toThrow();
  });

  it('a fabricated role id is refused the same way', async () => {
    await expect(invitationNaming(fabricatedId())).rejects.toThrow();
  });
});
