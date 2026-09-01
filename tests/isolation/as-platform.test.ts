import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { asPlatform, withWorkspace } from '@brandspace/database';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * asPlatform() — the audited escape hatch (docs/SECURITY.md §2.4).
 *
 * Three properties must hold: it requires a platform actor with verified MFA,
 * it requires a written reason, and it ALWAYS leaves an audit record — including
 * when the operation it wraps fails.
 */

let prisma: PrismaClient;
let platformPrisma: PrismaClient;
let fx: IsolationFixtures;

const REQUEST_ID = 'test-request-id';

const VALID_ACTOR = {
  platformUserId: '00000000-0000-4000-8000-0000000000aa',
  roleKey: 'platform_owner',
  mfaVerified: true,
} as const;

beforeAll(async () => {
  prisma = appRoleClient();
  platformPrisma = platformRoleClient();
  fx = await createIsolationFixtures(prisma);
});

afterAll(async () => {
  await platformPrisma.$disconnect();
  await prisma.$disconnect();
});

async function auditCountFor(action: string): Promise<number> {
  return asPlatform(
    VALID_ACTOR,
    {
      action: 'test.read.audit',
      reason: 'Counting audit rows for assertion',
      requestId: REQUEST_ID,
    },
    (db) => db.auditEvent.count({ where: { action } }),
    { prisma: platformPrisma, bootstrap: true },
  );
}

describe('preconditions', () => {
  it('rejects a caller with no platform actor', async () => {
    await expect(
      asPlatform(
        { platformUserId: '', roleKey: 'x', mfaVerified: true },
        { action: 'test.denied', reason: 'should never run', requestId: REQUEST_ID },
        async () => 'unreachable',
        { prisma: platformPrisma, bootstrap: true },
      ),
    ).rejects.toThrow(/requires a platform actor/);
  });

  it('rejects a platform actor without verified MFA (D-27)', async () => {
    await expect(
      asPlatform(
        { ...VALID_ACTOR, mfaVerified: false },
        {
          action: 'test.denied',
          reason: 'should never run because MFA is unverified',
          requestId: REQUEST_ID,
        },
        async () => 'unreachable',
        { prisma: platformPrisma, bootstrap: true },
      ),
    ).rejects.toThrow(/verified MFA/);
  });

  it('rejects an operation with no written reason', async () => {
    await expect(
      asPlatform(
        VALID_ACTOR,
        { action: 'test.denied', reason: '', requestId: REQUEST_ID },
        async () => 'unreachable',
        {
          prisma: platformPrisma,
          bootstrap: true,
        },
      ),
    ).rejects.toThrow(/requires a written reason/);
  });

  it('rejects an invalid platform role', async () => {
    await expect(
      asPlatform(
        { ...VALID_ACTOR, roleKey: 'workspace_owner' },
        {
          action: 'test.denied',
          reason: 'a customer role must never reach here',
          requestId: REQUEST_ID,
        },
        async () => 'unreachable',
        { prisma: platformPrisma, bootstrap: true },
      ),
    ).rejects.toThrow(/valid platform role/);
  });

  it('rejects a missing correlation id', async () => {
    await expect(
      asPlatform(
        VALID_ACTOR,
        { action: 'test.denied', reason: 'no request id supplied here', requestId: '' },
        async () => 'unreachable',
        { prisma: platformPrisma, bootstrap: true },
      ),
    ).rejects.toThrow(/correlation\/request id/);
  });

  it('rejects a token reason that explains nothing', async () => {
    await expect(
      asPlatform(
        VALID_ACTOR,
        { action: 'test.denied', reason: 'ok', requestId: REQUEST_ID },
        async () => 'unreachable',
        {
          prisma: platformPrisma,
          bootstrap: true,
        },
      ),
    ).rejects.toThrow(/at least 8 characters/);
  });
});

describe('cross-tenant visibility', () => {
  it('sees both workspaces, which no tenant context can', async () => {
    const ids = await asPlatform(
      VALID_ACTOR,
      {
        action: 'platform.workspace.read',
        reason: 'Verifying cross-tenant read for tests',
        requestId: REQUEST_ID,
      },
      (db) => db.workspace.findMany({ select: { id: true } }),
      { prisma: platformPrisma, bootstrap: true },
    );
    const found = ids.map((r) => r.id);
    expect(found).toContain(fx.a.workspaceId);
    expect(found).toContain(fx.b.workspaceId);
  });

  it('closes the window: a tenant call after it is scoped again', async () => {
    await asPlatform(
      VALID_ACTOR,
      {
        action: 'platform.workspace.read',
        reason: 'Open then close the platform window',
        requestId: REQUEST_ID,
      },
      (db) => db.workspace.count(),
      { prisma: platformPrisma, bootstrap: true },
    );
    const scoped = await withWorkspace(fx.a.workspaceId, (db) => db.workspace.count(), { prisma });
    expect(scoped).toBe(1);
  });

  it('closes the window even when the operation throws', async () => {
    await expect(
      asPlatform(
        VALID_ACTOR,
        {
          action: 'platform.failing.op',
          reason: 'Deliberate failure to test cleanup',
          requestId: REQUEST_ID,
        },
        async () => {
          throw new Error('deliberate failure');
        },
        { prisma: platformPrisma, bootstrap: true },
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
      { action, reason: 'Verifying that success is audited', requestId: REQUEST_ID },
      (db) => db.workspace.count(),
      { prisma: platformPrisma },
    );

    expect(await auditCountFor(action)).toBe(1);
  });

  it('writes an audit event even when the operation FAILS and rolls back', async () => {
    const action = `test.audited.failure.${crypto.randomUUID().slice(0, 8)}`;

    await expect(
      asPlatform(
        VALID_ACTOR,
        { action, reason: 'Verifying that failure is still audited', requestId: REQUEST_ID },
        async () => {
          throw new Error('rollback me');
        },
        { prisma: platformPrisma },
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
        { action, reason: 'Checking recorded audit detail', requestId: REQUEST_ID },
        async () => {
          throw new Error('boom');
        },
        { prisma: platformPrisma },
      ),
    ).rejects.toThrow();

    const event = await asPlatform(
      VALID_ACTOR,
      {
        action: 'test.read.audit',
        reason: 'Reading the audit row back for assertion',
        requestId: REQUEST_ID,
      },
      (db) => db.auditEvent.findFirst({ where: { action } }),
      { prisma: platformPrisma, bootstrap: true },
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
      { action, reason: 'Platform event must stay invisible to tenants', requestId: REQUEST_ID },
      (db) => db.workspace.count(),
      { prisma: platformPrisma },
    );

    // Read back through the TENANT pool: that is the client whose visibility
    // is under test.
    const seenByTenant = await withWorkspace(
      fx.a.workspaceId,
      (db) => db.auditEvent.findMany({ where: { action } }),
      { prisma },
    );
    expect(seenByTenant).toHaveLength(0);
  });
});

describe('errors never leak configuration', () => {
  it('a failed platform operation surfaces no connection string', async () => {
    const secretish = process.env['DATABASE_PLATFORM_URL'] ?? '';
    expect(secretish).not.toBe('');

    let message = '';
    try {
      await asPlatform(
        VALID_ACTOR,
        {
          action: 'test.error.redaction',
          reason: 'Deliberate failure for redaction check',
          requestId: REQUEST_ID,
        },
        async () => {
          throw new Error('deliberate failure');
        },
        { prisma: platformPrisma },
      );
    } catch (e: unknown) {
      message = e instanceof Error ? `${e.message}${e.stack ?? ''}` : String(e);
    }

    expect(message).toContain('deliberate failure');
    // The whole URL, and its password component, must be absent.
    expect(message).not.toContain(secretish);
    expect(message).not.toContain('devonly_platform');
    expect(message).not.toMatch(/postgresql:\/\//);
  });

  it('a precondition failure names the requirement but no configuration', async () => {
    let message = '';
    try {
      await asPlatform(
        { ...VALID_ACTOR, mfaVerified: false },
        { action: 'test.denied', reason: 'checking redaction on denial', requestId: REQUEST_ID },
        async () => 'unreachable',
        { prisma: platformPrisma, bootstrap: true },
      );
    } catch (e: unknown) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/verified MFA/);
    expect(message).not.toMatch(/postgresql:\/\//);
    expect(message).not.toContain('devonly');
  });
});
