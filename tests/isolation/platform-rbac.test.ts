import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigurationService } from '@brandspace/config';
import { SecretService } from '@brandspace/secrets';
import { PLATFORM_ROLE_KEYS } from '@brandspace/shared';
import { ensurePlatformRbac, platformRoleClient } from './fixtures';
import { deleteTestSecrets, testSecretProvider } from '../support/secret-fixtures';
import type { PrismaClient } from '@prisma/client';

/**
 * One token for this suite RUN, embedded in every secret ref it creates, so
 * `afterAll` can delete exactly these rows and nothing else — including nothing
 * belonging to a suite running in parallel (F-53).
 */
const TEST_SECRET_PROVIDER = testSecretProvider();

/**
 * Regression suite for the independent security review — finding 2.
 *
 * Every secret and configuration action was gated on `platform.workspace.read`,
 * whose description is "View any workspace". That permission is held by
 * `support_agent`, `billing_manager` and `operations_viewer`, so a read-only
 * support user could create, rotate and revoke API keys and activate platform
 * configuration. The services themselves checked only that an actor existed and
 * had passed MFA, so calling the service directly bypassed RBAC entirely.
 *
 * This suite is table-driven over EVERY platform role and asserts both
 * directions: what each role may do, and what it must be refused. Permission
 * keys are read back out of the database, so it covers the definitions, the
 * seeded rows and the service enforcement in one pass.
 */

const ENV = 'DEVELOPMENT' as const;

let prisma: PrismaClient;
let config: ConfigurationService;
let secrets: SecretService;

interface RoleActor {
  readonly platformUserId: string;
  readonly roleKey: string;
  readonly mfaVerified: true;
  readonly permissionKeys: readonly string[];
}

const actors = new Map<string, RoleActor>();

/** What each role is allowed to do. Deny is the default; allow is deliberate. */
const MATRIX: Record<
  string,
  {
    configRead: boolean;
    configManage: boolean;
    configActivate: boolean;
    secretRead: boolean;
    secretManage: boolean;
  }
> = {
  platform_owner: {
    configRead: true,
    configManage: true,
    configActivate: true,
    secretRead: true,
    secretManage: true,
  },
  platform_admin: {
    configRead: true,
    configManage: true,
    configActivate: true,
    secretRead: true,
    secretManage: true,
  },
  operations_viewer: {
    configRead: true,
    configManage: false,
    configActivate: false,
    secretRead: false,
    secretManage: false,
  },
  support_agent: {
    configRead: false,
    configManage: false,
    configActivate: false,
    secretRead: false,
    secretManage: false,
  },
  billing_manager: {
    configRead: false,
    configManage: false,
    configActivate: false,
    secretRead: false,
    secretManage: false,
  },
};

function actorFor(roleKey: string): RoleActor {
  const actor = actors.get(roleKey);
  if (!actor) throw new Error(`No test actor for role ${roleKey}`);
  return actor;
}

function reason(): string {
  return `RBAC suite ${randomUUID().slice(0, 8)}`;
}

/** Assert a call is refused with FORBIDDEN, never with a generic crash. */
async function expectForbidden(operation: Promise<unknown>): Promise<void> {
  const error = await operation.then(() => null).catch((e: unknown) => e);
  expect(error, 'the operation should have been refused').not.toBeNull();
  expect((error as { code?: string }).code).toBe('FORBIDDEN');
}

beforeAll(async () => {
  prisma = platformRoleClient();
  await ensurePlatformRbac(prisma);

  config = new ConfigurationService({ prisma });
  secrets = new SecretService({ prisma, env: { SECRET_VAULT_KEK: 'r'.repeat(48) } });

  for (const roleKey of PLATFORM_ROLE_KEYS) {
    const role = await prisma.role.findFirstOrThrow({
      where: { key: roleKey, workspaceId: null },
      include: { permissions: { include: { permission: true } } },
    });
    const user = await prisma.platformUser.create({
      data: {
        email: `rbac-${roleKey}-${randomUUID()}@brandspace.local`,
        name: `RBAC ${roleKey}`,
        status: 'ACTIVE',
        roleId: role.id,
      },
    });
    actors.set(roleKey, {
      platformUserId: user.id,
      roleKey,
      mfaVerified: true,
      permissionKeys: role.permissions.map((rp) => rp.permission.key),
    });
  }
});

afterAll(async () => {
  // This run's secrets go before the connection does.
  if (prisma) await deleteTestSecrets(prisma, TEST_SECRET_PROVIDER);
  await prisma?.$disconnect();
});

// ---------------------------------------------------------------------------
// The permission model itself
// ---------------------------------------------------------------------------

describe('the platform permission model is least-privilege', () => {
  it('does not let "view any workspace" stand in for managing configuration or secrets', () => {
    for (const roleKey of PLATFORM_ROLE_KEYS) {
      const actor = actorFor(roleKey);
      if (!actor.permissionKeys.includes('platform.workspace.read')) continue;
      if (MATRIX[roleKey]!.configManage) continue;

      // Holding the generic read permission must never imply a write.
      expect(actor.permissionKeys).not.toContain('platform.configuration.manage');
      expect(actor.permissionKeys).not.toContain('platform.configuration.activate');
      expect(actor.permissionKeys).not.toContain('platform.secret.manage');
    }
  });

  it('gives read, edit and activation separate permissions', () => {
    const owner = actorFor('platform_owner');
    expect(owner.permissionKeys).toContain('platform.configuration.read');
    expect(owner.permissionKeys).toContain('platform.configuration.manage');
    expect(owner.permissionKeys).toContain('platform.configuration.activate');
    expect(owner.permissionKeys).toContain('platform.secret.read');
    expect(owner.permissionKeys).toContain('platform.secret.manage');
  });

  it('grants no secret permission at all to support, billing or operations roles', () => {
    for (const roleKey of ['support_agent', 'billing_manager', 'operations_viewer']) {
      const keys = actorFor(roleKey).permissionKeys;
      expect(keys.filter((k) => k.startsWith('platform.secret.'))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Configuration Service — enforced in the service, not only in the page
// ---------------------------------------------------------------------------

describe.each(PLATFORM_ROLE_KEYS)('configuration access for %s', (roleKey) => {
  const expected = MATRIX[roleKey]!;

  it(`${expected.configRead ? 'can' : 'cannot'} list configuration versions`, async () => {
    const call = config.listVersions(actorFor(roleKey), 'operations', ENV);
    if (expected.configRead) await expect(call).resolves.toBeInstanceOf(Array);
    else await expectForbidden(call);
  });

  it(`${expected.configManage ? 'can' : 'cannot'} create a draft`, async () => {
    const call = config.createDraft(actorFor(roleKey), 'website', ENV, reason());
    if (expected.configManage) await expect(call).resolves.toHaveProperty('status', 'DRAFT');
    else await expectForbidden(call);
  });

  it(`${expected.configActivate ? 'can' : 'cannot'} activate`, async () => {
    // Every role attempts to activate a draft an authorised role created, so a
    // refusal is about the permission and not about the draft being missing.
    const owner = actorFor('platform_owner');
    const draft = await config.createDraft(owner, 'templates', ENV, reason());
    await config.validateDraft(owner, draft.id);

    const call = config.activate(actorFor(roleKey), draft.id, { acknowledgeHighImpact: true });
    if (expected.configActivate) {
      await expect(call).resolves.toHaveProperty('status', 'ACTIVE');
    } else {
      await expectForbidden(call);
      const after = await config.getVersion(owner, draft.id);
      expect(after.status).not.toBe('ACTIVE');
    }
  });

  it(`${expected.configActivate ? 'can' : 'cannot'} roll back`, async () => {
    const owner = actorFor('platform_owner');
    const versions = await config.listVersions(owner, 'templates', ENV);
    const superseded = versions.find((v) => v.status === 'SUPERSEDED');
    if (!superseded) return; // nothing to roll back to yet in this run

    const call = config.rollback(actorFor(roleKey), superseded.id, reason());
    if (expected.configActivate) await expect(call).resolves.toBeDefined();
    else await expectForbidden(call);
  });
});

// ---------------------------------------------------------------------------
// Secret Service
// ---------------------------------------------------------------------------

describe.each(PLATFORM_ROLE_KEYS)('secret access for %s', (roleKey) => {
  const expected = MATRIX[roleKey]!;

  it(`${expected.secretRead ? 'can' : 'cannot'} list secret metadata`, async () => {
    const call = secrets.listSecrets(actorFor(roleKey), { environment: ENV });
    if (expected.secretRead) {
      // F-53 changed the return type from an unbounded array to one PAGE. The
      // permission boundary is unchanged, so this still asserts the same
      // thing — that a reader gets a result at all — against the new shape.
      const page = await call;
      expect(page.items).toBeInstanceOf(Array);
      expect(page.items.length).toBeLessThanOrEqual(page.pageSize);
      expect(page.total).toBeGreaterThanOrEqual(page.items.length);
    } else {
      await expectForbidden(call);
    }
  });

  it(`${expected.secretManage ? 'can' : 'cannot'} create a secret`, async () => {
    const call = secrets.createSecret(actorFor(roleKey), {
      ref: `ai_provider/${TEST_SECRET_PROVIDER}-${roleKey}/${randomUUID().slice(0, 8)}`,
      name: `RBAC ${roleKey}`,
      category: 'ai_provider',
      environment: ENV,
      value: 'rbac-fake-value-abcdefghijklmnop',
    });
    if (expected.secretManage) await expect(call).resolves.toHaveProperty('status', 'ACTIVE');
    else await expectForbidden(call);
  });

  it(`${expected.secretManage ? 'can' : 'cannot'} rotate, disable, enable or revoke`, async () => {
    const owner = actorFor('platform_owner');
    const created = await secrets.createSecret(owner, {
      ref: `ai_provider/${TEST_SECRET_PROVIDER}-target/${randomUUID().slice(0, 8)}`,
      name: 'RBAC rotation target',
      category: 'ai_provider',
      environment: ENV,
      value: 'rbac-fake-value-abcdefghijklmnop',
    });

    if (expected.secretManage) {
      await expect(
        secrets.rotateSecret(actorFor(roleKey), created.id, 'rbac-fake-rotated-abcdefgh', reason()),
      ).resolves.toBeDefined();
    } else {
      await expectForbidden(
        secrets.rotateSecret(actorFor(roleKey), created.id, 'rbac-fake-rotated-abcdefgh', reason()),
      );
      await expectForbidden(secrets.disableSecret(actorFor(roleKey), created.id, reason()));
      await expectForbidden(secrets.enableSecret(actorFor(roleKey), created.id, reason()));
      await expectForbidden(secrets.revokeSecret(actorFor(roleKey), created.id, reason()));

      // Nothing changed.
      const after = await secrets.getSecret(owner, created.id);
      expect(after.status).toBe('ACTIVE');
    }
  });
});

// ---------------------------------------------------------------------------
// The service is the boundary, not the page
// ---------------------------------------------------------------------------

describe('RBAC cannot be bypassed by calling the service directly', () => {
  it('refuses an actor that carries no permission keys at all', async () => {
    const bare = {
      platformUserId: actorFor('platform_owner').platformUserId,
      roleKey: 'platform_owner',
      mfaVerified: true as const,
      permissionKeys: [] as readonly string[],
    };

    await expectForbidden(secrets.listSecrets(bare, { environment: ENV }));
    await expectForbidden(config.createDraft(bare, 'website', ENV, reason()));
  });

  it('refuses an actor holding only platform.workspace.read', async () => {
    const readOnly = {
      platformUserId: actorFor('support_agent').platformUserId,
      roleKey: 'support_agent',
      mfaVerified: true as const,
      permissionKeys: ['platform.workspace.read'] as readonly string[],
    };

    await expectForbidden(
      secrets.createSecret(readOnly, {
        ref: `ai_provider/${TEST_SECRET_PROVIDER}-bypass/${randomUUID().slice(0, 8)}`,
        name: 'bypass attempt',
        category: 'ai_provider',
        environment: ENV,
        value: 'rbac-fake-value-abcdefghijklmnop',
      }),
    );
    await expectForbidden(config.createDraft(readOnly, 'website', ENV, reason()));
  });

  it('still refuses a permitted actor who has not verified MFA', async () => {
    const owner = actorFor('platform_owner');
    const noMfa = { ...owner, mfaVerified: false as const };

    await expectForbidden(config.createDraft(noMfa, 'website', ENV, reason()));
    await expectForbidden(
      secrets.createSecret(noMfa, {
        ref: `ai_provider/${TEST_SECRET_PROVIDER}-nomfa/${randomUUID().slice(0, 8)}`,
        name: 'no mfa',
        category: 'ai_provider',
        environment: ENV,
        value: 'rbac-fake-value-abcdefghijklmnop',
      }),
    );
  });

  it('writes a DENIED audit event that names the permission but leaks no value', async () => {
    const agent = actorFor('support_agent');
    const secretValue = 'rbac-fake-denied-abcdefghijklmnop';

    await secrets
      .createSecret(agent, {
        ref: `ai_provider/${TEST_SECRET_PROVIDER}-denied/${randomUUID().slice(0, 8)}`,
        name: 'denied attempt',
        category: 'ai_provider',
        environment: ENV,
        value: secretValue,
      })
      .catch(() => undefined);

    const events = await prisma.auditEvent.findMany({
      where: { actorId: agent.platformUserId, outcome: 'DENIED' },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(secretValue);
  });
});
