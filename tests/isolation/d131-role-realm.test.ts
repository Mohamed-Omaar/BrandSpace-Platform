import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * D-131, THE HALF THE FIRST VERSION GOT WRONG: THE REALM.
 *
 * `membership."roleId"` and `invitation."roleId"` reach `role(id)` by id alone,
 * because `role` has a NULLABLE tenant key and the composite workspace-scoped
 * key D-112 mandates is therefore unavailable. A trigger stands in for it.
 *
 * THE FIRST TRIGGER READ `role."workspaceId" IS NULL` AS "SYSTEM ROLE". IT IS
 * NOT. Both halves of the role table carry a NULL workspace:
 *
 *   * WORKSPACE-realm system roles — `owner`, `admin`, `editor`, `client_viewer`
 *     — which genuinely are shared by every workspace, and
 *   * every PLATFORM-realm role — `platform_owner`, `platform_admin`,
 *     `support_agent`, `billing_manager`, `operations_viewer` — which belong to
 *     the Control Center and to no workspace at all.
 *
 * And `role`'s RLS policy is `"workspaceId" IS NULL OR "workspaceId" =
 * app.current_workspace_id()`, so a tenant session can SEE every platform role.
 * A membership naming one would resolve the entire platform permission set into
 * a CUSTOMER session, because `customer-session.ts` builds `permissionKeys`
 * directly from `membership.role.permissions` and never checks the realm.
 *
 * This suite is written against real PostgreSQL through the unprivileged
 * application role, which is the only place the claim can be settled: the check
 * being tested is a database trigger, so a mocked client would prove nothing.
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
const inB = <T>(fn: (db: Db) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const fabricatedId = () => randomUUID();

/** A role id for each case, resolved from the database rather than assumed. */
async function workspaceSystemRoleId(): Promise<string> {
  const row = await inB((db) =>
    db.role.findFirst({
      where: { workspaceId: null, realm: 'WORKSPACE' },
      select: { id: true },
    }),
  );
  expect(row, 'the seed must provide WORKSPACE-realm system roles').toBeTruthy();
  return (row as { id: string }).id;
}

async function platformRoleId(): Promise<string> {
  /*
   * DELIBERATELY RESOLVED FROM INSIDE A TENANT CONTEXT. If this lookup came
   * back empty the test would be vacuous, so it doubles as the proof that a
   * platform role really is visible to a customer session — which is the whole
   * reason the trigger has to refuse it rather than rely on invisibility the
   * way it does for another workspace's custom role.
   */
  const row = await inB((db) =>
    db.role.findFirst({ where: { realm: 'PLATFORM' }, select: { id: true, key: true } }),
  );
  expect(
    row,
    'a PLATFORM role must be visible inside a tenant context for this to matter',
  ).toBeTruthy();
  return (row as { id: string }).id;
}

async function foreignCustomRoleId(): Promise<string> {
  const row = await inA((db) =>
    db.role.findFirst({ where: { workspaceId: fixtures.a.workspaceId }, select: { id: true } }),
  );
  expect(row, 'the fixture must give workspace A a custom role').toBeTruthy();
  return (row as { id: string }).id;
}

/** A user who is not yet a member of workspace B, so a membership can be written. */
async function freshUserId(): Promise<string> {
  const user = await app.user.create({
    data: {
      email: `d131-${randomUUID()}@example.test`,
      name: 'D-131 probe',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  return user.id;
}

const invitationNaming = (roleId: string) =>
  inB((db) =>
    db.invitation.create({
      data: {
        workspaceId: fixtures.b.workspaceId,
        email: `d131-${randomUUID()}@example.test`,
        roleId,
        tokenHash: `d131-${randomUUID()}`,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedByUserId: fixtures.b.userId,
      },
    }),
  );

const membershipNaming = async (roleId: string) => {
  const userId = await freshUserId();
  return inB((db) =>
    db.membership.create({
      data: {
        workspaceId: fixtures.b.workspaceId,
        userId,
        roleId,
        status: 'ACTIVE',
        acceptedAt: new Date(),
        brandScope: [],
      },
    }),
  );
};

/** What a refusal actually tells the caller. Two of these must be identical. */
async function refusalText(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    const e = error as {
      meta?: { driverAdapterError?: { cause?: { originalMessage?: unknown } } };
      message?: unknown;
    };
    const raw = String(e.meta?.driverAdapterError?.cause?.originalMessage ?? e.message);
    // Strip the ids so two refusals can be compared for SHAPE, which is what
    // §2.1 requires: an attacker must not be able to tell a real foreign row
    // from one that never existed.
    return raw.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
  }
  throw new Error('the write was ACCEPTED; the D-131 role trigger has regressed');
}

describe('a membership or invitation may name only a WORKSPACE-realm role it is entitled to', () => {
  it('1. a WORKSPACE-realm SYSTEM role is ACCEPTED — provisioning must keep working', async () => {
    const roleId = await workspaceSystemRoleId();
    await expect(invitationNaming(roleId)).resolves.toMatchObject({ roleId });
    await expect(membershipNaming(roleId)).resolves.toMatchObject({ roleId });
  });

  it('2. this workspace’s OWN custom role is ACCEPTED', async () => {
    const roleId = fixtures.b.customRoleId;
    await expect(invitationNaming(roleId)).resolves.toMatchObject({ roleId });
    await expect(membershipNaming(roleId)).resolves.toMatchObject({ roleId });
  });

  it('3. ANOTHER workspace’s custom role is REFUSED', async () => {
    const roleId = await foreignCustomRoleId();
    await expect(invitationNaming(roleId)).rejects.toThrow();
    await expect(membershipNaming(roleId)).rejects.toThrow();
  });

  it('4. a PLATFORM-realm role is REFUSED, although its workspaceId IS NULL', async () => {
    /*
     * THE REGRESSION THIS FILE EXISTS FOR. Against the first trigger this case
     * was ACCEPTED: `role_workspace IS NULL` was read as "system role, shared by
     * everyone", and a platform role satisfies it. Nothing about the row is
     * malformed — it is a perfectly ordinary NULL workspace on a role that
     * grants the Control Center.
     */
    const roleId = await platformRoleId();
    /*
     * Asserted on the DRIVER's message, not Prisma's. Prisma maps SQLSTATE
     * 23503 to a generic "Foreign key constraint violated" and drops the
     * trigger's own text, so matching on the Prisma error would pass for any
     * refusal at all — including the wrong one.
     */
    expect(await refusalText(invitationNaming(roleId))).toMatch(/is not a workspace role/);
    expect(await refusalText(membershipNaming(roleId))).toMatch(/is not a workspace role/);
  });

  it('5. a FABRICATED role id is REFUSED', async () => {
    await expect(invitationNaming(fabricatedId())).rejects.toThrow();
    await expect(membershipNaming(fabricatedId())).rejects.toThrow();
  });

  it('a real foreign role and an invented one are refused IDENTICALLY', async () => {
    const real = await refusalText(invitationNaming(await foreignCustomRoleId()));
    const invented = await refusalText(invitationNaming(fabricatedId()));
    expect(real).toEqual(invented);
  });

  it('the application role cannot bypass the trigger with a direct SQL write', async () => {
    /*
     * The service layer is the FIRST layer and it already refuses this
     * (`InvitationService.create`). This asserts the SECOND one: raw SQL issued
     * by the unprivileged application role — the exact shape a compromised
     * query path or a hand-written statement would take — is refused too.
     */
    const platform = await platformRoleId();
    const foreign = await foreignCustomRoleId();

    for (const roleId of [platform, foreign, fabricatedId()]) {
      await expect(
        inB((db) =>
          db.$executeRawUnsafe(
            `INSERT INTO "invitation"
               ("id","workspaceId","email","roleId","tokenHash","status","expiresAt","invitedByUserId","createdAt","updatedAt")
             VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, 'PENDING', now() + interval '1 day', $6::uuid, now(), now())`,
            randomUUID(),
            fixtures.b.workspaceId,
            `d131-raw-${randomUUID()}@example.test`,
            roleId,
            `d131-raw-${randomUUID()}`,
            fixtures.b.userId,
          ),
        ),
      ).rejects.toThrow();
    }
  });
});
