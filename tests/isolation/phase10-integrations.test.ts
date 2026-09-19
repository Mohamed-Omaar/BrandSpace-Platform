import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appRoleClient, platformRoleClient } from './fixtures';
import {
  findIntegration,
  INTEGRATION_CATEGORY_DEFINITIONS,
  INTEGRATION_DEFINITIONS,
  selectionRefusal,
} from '@brandspace/integrations';

/**
 * The Integrations Hub against REAL PostgreSQL — Phase 10 §2, §3, §28.
 *
 * TWO THINGS ARE BEING PROVEN HERE, and they are different in kind.
 *
 * The first is ORDINARY TENANCY: `integration_health_check` is platform-owned,
 * so the tenant role must be refused outright rather than filtered. A row in
 * this table names a platform credential reference and says whether it works —
 * a workspace being able to COUNT BrandSpace's provider failures is a
 * disclosure in itself, and "not found" is not good enough when "permission
 * denied" is what the boundary actually is.
 *
 * The second is a PRODUCTION-SAFETY invariant that has nothing to do with
 * tenancy and everything to do with §11 and §28: no development double may be
 * selectable in production. It is asserted here, in the suite that runs against
 * a real database, because the same fail-closed rule is what the readiness
 * probe reads — and a rule proven only in a unit test is a rule proven against
 * a mock of itself.
 */

let app: PrismaClient;
let platform: PrismaClient;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
}, 60_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

describe('integration_health_check is closed to tenants', () => {
  it('refuses the tenant role any read at all', async () => {
    await expect(app.integrationHealthCheck.findMany()).rejects.toThrow(/permission denied/i);
  });

  it('refuses the tenant role a count, not merely a row', async () => {
    // Counting provider failures is itself operational intelligence about
    // BrandSpace. The policy admits the platform role and nobody else, so even
    // an aggregate is refused.
    await expect(app.integrationHealthCheck.count()).rejects.toThrow(/permission denied/i);
  });

  it('refuses a tenant INSERT', async () => {
    await expect(
      app.integrationHealthCheck.create({
        data: {
          category: 'payment',
          providerKey: 'development',
          environment: 'DEVELOPMENT',
          outcome: 'OK',
          message: 'forged by a tenant',
        },
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('lets the platform role read and write it', async () => {
    const created = await platform.integrationHealthCheck.create({
      data: {
        category: 'payment',
        providerKey: 'development',
        environment: 'DEVELOPMENT',
        outcome: 'OK',
        latencyMs: 4,
        message: 'platform probe',
      },
    });
    expect(created.outcome).toBe('OK');
    const read = await platform.integrationHealthCheck.findUnique({ where: { id: created.id } });
    expect(read?.message).toBe('platform probe');
    await platform.integrationHealthCheck.delete({ where: { id: created.id } });
  });

  it('keeps the record when the operator who asked for it is deleted', async () => {
    /*
     * SET NULL rather than CASCADE, and the difference matters: an operator
     * leaving the company must not erase the evidence that a production
     * credential was verified before it was used.
     */
    const definition = await platform.$queryRawUnsafe<Array<{ delete_rule: string }>>(`
      SELECT rc.delete_rule
      FROM information_schema.referential_constraints rc
      WHERE rc.constraint_name = 'integration_health_check_requestedByPlatformUserId_fkey'
    `);
    expect(definition[0]?.delete_rule).toBe('SET NULL');
  });
});

describe('no development double is selectable in production', () => {
  it('refuses every development-only integration in PRODUCTION', () => {
    const developmentOnly = INTEGRATION_DEFINITIONS.filter((d) => d.developmentOnly);
    // If this is ever empty the assertion below passes vacuously, which would
    // make the test a decoration rather than a guarantee.
    expect(developmentOnly.length).toBeGreaterThan(0);
    for (const definition of developmentOnly) {
      expect(
        selectionRefusal(definition, 'PRODUCTION'),
        `${definition.category}/${definition.providerKey}`,
      ).toMatch(/never be activated in production/i);
    }
  });

  it('allows them outside production, which is what they are for', () => {
    for (const definition of INTEGRATION_DEFINITIONS.filter((d) => d.developmentOnly)) {
      expect(selectionRefusal(definition, 'DEVELOPMENT')).toBeNull();
    }
  });

  it('registers no provider without an adapter', () => {
    /*
     * §4's honest rule, asserted rather than promised: the Hub lists a provider
     * only when BrandSpace can actually talk to it. Listing a vendor with an
     * empty adapter would be choosing the owner's provider by implication,
     * which is exactly what D-204 declined to do.
     */
    for (const definition of INTEGRATION_DEFINITIONS) {
      expect(definition.adapterAvailable, definition.providerKey).toBe(true);
    }
  });

  it('gives every registered integration a category that exists', () => {
    for (const definition of INTEGRATION_DEFINITIONS) {
      expect(
        INTEGRATION_CATEGORY_DEFINITIONS.some((c) => c.key === definition.category),
        definition.providerKey,
      ).toBe(true);
      expect(findIntegration(definition.category, definition.providerKey)).toBeDefined();
    }
  });

  it('declares no credential field that is not marked secret when it is one', () => {
    // A credential field written to the configuration document instead of the
    // vault would be a secret in a readable place. Every credential field is a
    // secret by definition, and the type cannot say so — this can.
    for (const definition of INTEGRATION_DEFINITIONS) {
      for (const field of definition.credentialFields) {
        expect(field.secret, `${definition.providerKey}.${field.key}`).toBe(true);
      }
      for (const field of definition.settingFields) {
        expect(field.secret, `${definition.providerKey}.${field.key}`).toBe(false);
      }
    }
  });
});
