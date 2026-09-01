import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { asPlatform, withWorkspace } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * asPlatform() — the audited escape hatch (docs/SECURITY.md §2.4).
 *
 * Three properties must hold: it requires a platform actor with verified MFA,
 * it requires a written reason, and it ALWAYS leaves an audit record — including
 * when the operation it wraps fails.
 */

let prisma: PrismaClient;
let fx: IsolationFixtures;

const VALID_ACTOR = {
  platformUserId: '00000000-0000-4000-8000-0000000000aa',
  roleKey: 'platform_owner',
  mfaVerified: true,
} as const;

beforeAll(async () => {
  prisma = appRoleClient();
  fx = await createIsolationFixtures(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function auditCountFor(action: string): Promise<number> {
  return asPlatform(
    VALID_ACTOR,
    { action: 'test.read.audit', reason: 'Counting audit rows for assertion' },
    (db) => db.auditEvent.count({ where: { action } }),
    { prisma, bootstrap: true },
  );
}

describe('preconditions', () => {
  it('rejects a caller with no platform actor', async () => {
    await expect(
      asPlatform(
        { platformUserId: '', roleKey: 'x', mfaVerified: true },
        { action: 'test.denied', reason: 'should never run' },
        async () => 'unreachable',
        { prisma, bootstrap: true },
      ),
    ).rejects.toThrow(/requires a platform actor/);
  });

  it('rejects a platform actor without verified MFA (D-27)', async () => {
    await expect(
      asPlatform(
        { ...VALID_ACTOR, mfaVerified: false },
        { action: 'test.denied', reason: 'should never run because MFA is unverified' },
        async () => 'unreachable',
        { prisma, bootstrap: true },
      ),
    ).rejects.toThrow(/verified MFA/);
  });

  it('rejects an operation with no written reason', async () => {
    await expect(
      asPlatform(VALID_ACTOR, { action: 'test.denied', reason: '' }, async () => 'unreachable', {
        prisma,
        bootstrap: true,
      }),
    ).rejects.toThrow(/requires a written reason/);
  });

  it('rejects a token reason that explains nothing', async () => {
    await expect(
      asPlatform(VALID_ACTOR, { action: 'test.denied', reason: 'ok' }, async () => 'unreachable', {
        prisma,
        bootstrap: true,
      }),
    ).rejects.toThrow(/at least 8 characters/);
  });
});

describe('cross-tenant visibility', () => {
  it('sees both workspaces, which no tenant context can', async () => {
    const ids = await asPlatform(
      VALID_ACTOR,
      { action: 'platform.workspace.read', reason: 'Verifying cross-tenant read for tests' },
      (db) => db.workspace.findMany({ select: { id: true } }),
      { prisma, bootstrap: true },
    );
    const found = ids.map((r) => r.id);
    expect(found).toContain(fx.a.workspaceId);
    expect(found).toContain(fx.b.workspaceId);
  });

  it('closes the window: a tenant call after it is scoped again', async () => {
    await asPlatform(
      VALID_ACTOR,
      { action: 'platform.workspace.read', reason: 'Open then close the platform window' },
      (db) => db.workspace.count(),
      { prisma, bootstrap: true },
    );
    const scoped = await withWorkspace(fx.a.workspaceId, (db) => db.workspace.count(), { prisma });
    expect(scoped).toBe(1);
  });

  it('closes the window even when the operation throws', async () => {
    await expect(
      asPlatform(
        VALID_ACTOR,
        { action: 'platform.failing.op', reason: 'Deliberate failure to test cleanup' },
        async () => {
          throw new Error('deliberate failure');
        },
        { prisma, bootstrap: true },
      ),
    ).rejects.toThrow('deliberate failure');

    const scoped = await withWorkspace(fx.a.workspaceId, (db) => db.workspace.count(), { prisma });
    expect(scoped).toBe(1);
  });
});

describe('auditing', () => {
  it('writes an audit event for a successful platform operation', async () => {
    const action = `test.audited.success.${crypto.randomUUID().slice(0, 8)}`;
    expect(await auditCountFor(action)).toBe(0);

    await asPlatform(
      VALID_ACTOR,
      { action, reason: 'Verifying that success is audited' },
      (db) => db.workspace.count(),
      { prisma },
    );

    expect(await auditCountFor(action)).toBe(1);
  });

  it('writes an audit event even when the operation FAILS and rolls back', async () => {
    const action = `test.audited.failure.${crypto.randomUUID().slice(0, 8)}`;

    await expect(
      asPlatform(
        VALID_ACTOR,
        { action, reason: 'Verifying that failure is still audited' },
        async () => {
          throw new Error('rollback me');
        },
        { prisma },
      ),
    ).rejects.toThrow('rollback me');

    // The audit is written in a separate transaction precisely so a rolled-back
    // operation still leaves evidence that cross-tenant access was attempted.
    expect(await auditCountFor(action)).toBe(1);
  });

  it('records the actor, the reason and the ERROR outcome on a failure', async () => {
    const action = `test.audited.detail.${crypto.randomUUID().slice(0, 8)}`;
    await expect(
      asPlatform(
        VALID_ACTOR,
        { action, reason: 'Checking recorded audit detail' },
        async () => {
          throw new Error('boom');
        },
        { prisma },
      ),
    ).rejects.toThrow();

    const event = await asPlatform(
      VALID_ACTOR,
      { action: 'test.read.audit', reason: 'Reading the audit row back for assertion' },
      (db) => db.auditEvent.findFirst({ where: { action } }),
      { prisma, bootstrap: true },
    );

    expect(event).not.toBeNull();
    expect(event?.actorType).toBe('PLATFORM_USER');
    expect(event?.actorId).toBe(VALID_ACTOR.platformUserId);
    expect(event?.outcome).toBe('ERROR');
    expect(event?.reason).toContain('Checking recorded audit detail');
  });

  it('a platform audit event is not visible to any tenant', async () => {
    const action = `test.audited.hidden.${crypto.randomUUID().slice(0, 8)}`;
    await asPlatform(
      VALID_ACTOR,
      { action, reason: 'Platform event must stay invisible to tenants' },
      (db) => db.workspace.count(),
      { prisma },
    );

    const seenByTenant = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.auditEvent.findMany({ where: { action } }),
      { prisma },
    );
    expect(seenByTenant).toHaveLength(0);
  });
});
