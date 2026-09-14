import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { ConfigurationService } from '@brandspace/config';
import { SecretService, buildSecretRef } from '@brandspace/secrets';
import { MODEL_TABLE_NAMES, PLATFORM_OWNED_MODELS } from '@brandspace/database';
import { PLATFORM_PERMISSIONS } from '@brandspace/shared';
import { ensurePlatformRole, platformRoleClient } from './fixtures';
import { deleteTestSecrets, testSecretProvider } from '../support/secret-fixtures';
import type { PrismaClient } from '@prisma/client';

/**
 * Phase 2A services against a REAL PostgreSQL.
 *
 * Everything here runs on the PLATFORM pool, because configuration and secrets
 * are platform-owned: the tenant role has no privileges on these tables at all,
 * which the "tenant role rejection" block proves directly.
 */

let prisma: PrismaClient;
let config: ConfigurationService;
let secrets: SecretService;

/**
 * One token for this suite RUN, embedded in every secret ref it creates.
 *
 * F-53: the suites used to leave every secret behind, and a long-lived local
 * database reached 853 of them. The token is what lets `afterAll` delete
 * exactly these rows and nothing else — including nothing belonging to another
 * suite running in parallel.
 */
const TEST_SECRET_PROVIDER = testSecretProvider();
let tenantSql: Client;
let ownerId: string;

// The Platform Owner's real permission set, not a bespoke bypass: these suites
// must exercise the same authorization path production does.
const OWNER_PERMISSIONS = PLATFORM_PERMISSIONS.map((p) => p.key);
const ACTOR = {
  roleKey: 'platform_owner',
  mfaVerified: true,
  permissionKeys: OWNER_PERMISSIONS,
} as const;
const ENV = 'DEVELOPMENT' as const;

function actor() {
  return { platformUserId: ownerId, ...ACTOR };
}

beforeAll(async () => {
  prisma = platformRoleClient();
  config = new ConfigurationService({ prisma });
  secrets = new SecretService({ prisma, env: { SECRET_VAULT_KEK: 'k'.repeat(48) } });

  // Bootstrapped, not assumed: CI applies migrations and runs no seed.
  const roleId = await ensurePlatformRole(prisma);
  const created = await prisma.platformUser.create({
    data: {
      email: `svc-${crypto.randomUUID()}@brandspace.local`,
      name: 'Service Test Owner',
      status: 'ACTIVE',
      roleId,
    },
  });
  ownerId = created.id;

  tenantSql = new Client({ connectionString: process.env['DATABASE_URL'] });
  await tenantSql.connect();
});

afterAll(async () => {
  // Remove this run's secrets before disconnecting. Guarded so a failure in
  // beforeAll — where `prisma` may not exist — reports its own error rather
  // than a confusing one from cleanup on top of it.
  if (prisma) await deleteTestSecrets(prisma, TEST_SECRET_PROVIDER);
  // Optional-chained so a failure in beforeAll reports ITS error rather than a
  // confusing "cannot read 'end' of undefined" on top of it.
  await tenantSql?.end();
  await prisma?.$disconnect();
});

/** A unique domain-free suffix so parallel runs never collide. */
function uniqueReason(): string {
  return `Automated test ${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Derived from the tenancy registry rather than written out here, so a new
 * platform-owned model cannot be added without this suite noticing. The
 * isolation gate enforces the same list at build time; this proves the database
 * agrees with it.
 */
const PLATFORM_TABLES = PLATFORM_OWNED_MODELS.map((m) => MODEL_TABLE_NAMES[m]!);

describe('the tenant role is rejected from platform data', () => {
  it.each(PLATFORM_TABLES)('cannot read %s at all', async (table) => {
    // Not "returns zero rows" — the privilege itself is revoked.
    await expect(tenantSql.query(`SELECT count(*) FROM "${table}"`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('cannot write to a platform table', async () => {
    await expect(
      tenantSql.query(
        `INSERT INTO "secret_record" (id, ref, environment, category, name, "createdByPlatformUserId")
         VALUES (gen_random_uuid(), 'forged', 'DEVELOPMENT', 'other', 'forged', gen_random_uuid())`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('platform tables carry a platform-only policy and no tenant policy', async () => {
    const r = await prisma.$queryRaw<{ tablename: string; policyname: string; roles: string }[]>`
      SELECT tablename, policyname, roles::text AS roles FROM pg_policies
       WHERE schemaname = 'public' AND policyname = 'platform_only'`;
    expect(r.map((row) => row.tablename).sort()).toEqual([...PLATFORM_TABLES].sort());
    for (const row of r) {
      expect(row.roles).toContain('brandspace_platform');
      expect(row.roles).not.toContain('brandspace_app');
    }
  });
});

describe('configuration lifecycle', () => {
  it('draft → validate → preview → activate, and reads back', async () => {
    const draft = await config.createDraft(actor(), 'operations', ENV, uniqueReason());
    expect(draft.status).toBe('DRAFT');

    // Values that differ from whatever is currently active, so the impact
    // preview always has something to report. A fixed payload would produce an
    // empty diff on the second run against the same database and the assertion
    // below would then be measuring test order rather than behaviour.
    const active = await config.get('operations', ENV);
    const ttl = active.supportModeTtlMinutes === 45 ? 90 : 45;
    const trialDays = active.trialDefaultDays === 21 ? 28 : 21;

    await config.updateDraft(
      actor(),
      draft.id,
      {
        supportModeTtlMinutes: ttl,
        trialDefaultDays: trialDays,
        supportedCurrencies: ['SAR'],
        maintenanceMode: { enabled: false, message: null, allowPlatformAdmin: true },
      },
      draft.lockVersion,
    );

    const report = await config.validateDraft(actor(), draft.id);
    expect(report.valid).toBe(true);

    const preview = await config.previewImpact(actor(), draft.id);
    expect(preview.changes.length).toBeGreaterThan(0);

    const activated = await config.activate(actor(), draft.id, { acknowledgeHighImpact: true });
    expect(activated.status).toBe('ACTIVE');

    const effective = await config.get('operations', ENV);
    expect(effective.supportModeTtlMinutes).toBe(ttl);
    expect(effective.trialDefaultDays).toBe(trialDays);
  });

  it('activation is ATOMIC: exactly one ACTIVE version survives', async () => {
    const first = await config.createDraft(actor(), 'usage-limits', ENV, uniqueReason());
    await config.validateDraft(actor(), first.id);
    await config.activate(actor(), first.id, { acknowledgeHighImpact: true });

    const second = await config.createDraft(actor(), 'usage-limits', ENV, uniqueReason());
    await config.validateDraft(actor(), second.id);
    await config.activate(actor(), second.id, { acknowledgeHighImpact: true });

    const versions = await config.listVersions(actor(), 'usage-limits', ENV);
    const active = versions.filter((v) => v.status === 'ACTIVE');
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(second.id);
    expect(versions.find((v) => v.id === first.id)?.status).toBe('SUPERSEDED');
  });

  it('the database itself refuses a second ACTIVE version', async () => {
    // A partial unique index, so this holds even against direct SQL.
    const active = await prisma.configurationVersion.findFirst({
      where: { domain: 'usage-limits', environment: ENV, status: 'ACTIVE' },
    });
    const other = await config.createDraft(actor(), 'usage-limits', ENV, uniqueReason());
    await expect(
      prisma.configurationVersion.update({ where: { id: other.id }, data: { status: 'ACTIVE' } }),
    ).rejects.toThrow();
    expect(active).not.toBeNull();
  });

  it('rollback creates a NEW version and never rewrites history', async () => {
    const v1 = await config.createDraft(actor(), 'website', ENV, uniqueReason());
    await config.updateDraft(
      actor(),
      v1.id,
      { ...(await config.get('website', ENV)), defaultLocale: 'en' },
      v1.lockVersion,
    );
    await config.validateDraft(actor(), v1.id);
    await config.activate(actor(), v1.id, { acknowledgeHighImpact: true });

    const v2 = await config.createDraft(actor(), 'website', ENV, uniqueReason());
    await config.updateDraft(
      actor(),
      v2.id,
      { ...(await config.get('website', ENV)), defaultLocale: 'ar' },
      v2.lockVersion,
    );
    await config.validateDraft(actor(), v2.id);
    await config.activate(actor(), v2.id, { acknowledgeHighImpact: true });
    expect((await config.get('website', ENV)).defaultLocale).toBe('ar');

    const rolled = await config.rollback(actor(), v1.id, 'Reverting a regression for tests');
    expect((await config.get('website', ENV)).defaultLocale).toBe('en');

    // The original v1 row is untouched; a NEW version carries its payload.
    expect(rolled.id).not.toBe(v1.id);
    expect(rolled.versionNumber).toBeGreaterThan(v2.versionNumber);
    const original = await config.getVersion(actor(), v1.id);
    expect(original.status).toBe('SUPERSEDED');
  });

  it('environments are wholly separate', async () => {
    const dev = await config.createDraft(actor(), 'templates', 'DEVELOPMENT', uniqueReason());
    await config.updateDraft(
      actor(),
      dev.id,
      {
        templates: [
          {
            key: 'dev-only',
            channel: 'email',
            subject: { ar: 'أ', en: 'A' },
            body: { ar: 'ب', en: 'B' },
            status: 'active',
          },
        ],
      },
      dev.lockVersion,
    );
    await config.validateDraft(actor(), dev.id);
    await config.activate(actor(), dev.id, { acknowledgeHighImpact: true });

    expect((await config.get('templates', 'DEVELOPMENT')).templates).toHaveLength(1);
    // Staging was never activated, so it stays at its default.
    expect((await config.get('templates', 'STAGING')).templates).toHaveLength(0);
    expect((await config.get('templates', 'PRODUCTION')).templates).toHaveLength(0);
  });

  it('an invalid draft cannot be activated', async () => {
    const draft = await config.createDraft(actor(), 'ai.routing', ENV, uniqueReason());
    await config.updateDraft(
      actor(),
      draft.id,
      {
        rules: [
          {
            taskKey: 'caption.generate',
            scope: 'global',
            planKey: null,
            workspaceId: null,
            primaryModelKey: 'nonexistent-model',
            fallbackModelKeys: [],
            timeoutMs: 1000,
            maxCostPerRequestMinor: null,
            priority: 0,
          },
        ],
      },
      draft.lockVersion,
    );
    /*
     * Seed a PROVIDERS document first, then a models document, so the reference
     * checks have something to check against.
     *
     * The providers half used to be missing, and the test passed anyway —
     * because `ai.providers` had never been activated in the test database, the
     * cross-domain check skipped itself entirely. That made this test depend on
     * global database state it does not control: the moment anything else
     * activated a providers document, the fixture model below referenced an
     * undefined provider and the SETUP failed rather than the assertion. Fixing
     * it here makes the test say what it means independently of its neighbours.
     */
    const providers = await config.createDraft(actor(), 'ai.providers', ENV, uniqueReason());
    await config.updateDraft(
      actor(),
      providers.id,
      {
        providers: [
          {
            key: 'p',
            name: 'Fixture provider',
            baseUrl: 'https://fixture.invalid',
            // `draft`, not `active`: an active provider must reference a stored
            // API key secret, and this fixture has no business creating one.
            apiKeySecretRef: null,
            status: 'draft',
            timeoutMs: 30_000,
            maxConcurrency: 4,
            noTrainingGuarantee: true,
            dataRetentionPolicy: 'zero_retention',
            privacyReviewRef: 'test fixture',
          },
        ],
      },
      providers.lockVersion,
    );
    await config.validateDraft(actor(), providers.id);
    await config.activate(actor(), providers.id, { acknowledgeHighImpact: true });

    const models = await config.createDraft(actor(), 'ai.models', ENV, uniqueReason());
    await config.updateDraft(
      actor(),
      models.id,
      {
        models: [
          {
            key: 'real-model',
            providerKey: 'p',
            displayName: 'Real',
            modality: 'text',
            qualityTier: 'fast',
            status: 'available',
            disableSwitch: false,
            // A servable model needs a cost basis before it can be activated
            // (docs/AI-GATEWAY.md §4) — without one it would record a provider
            // cost of zero and report infinite margin.
            inputCostPerUnitMicroMinor: 15_000,
            outputCostPerUnitMicroMinor: 60_000,
            // D-17: general availability also requires a recorded Arabic
            // quality benchmark. A fixture model is not exempt from the gate.
            qualityBenchmarkRef: 'BENCH-FIXTURE-ar-001',
          },
        ],
      },
      models.lockVersion,
    );
    await config.validateDraft(actor(), models.id);
    await config.activate(actor(), models.id, { acknowledgeHighImpact: true });

    await expect(
      config.activate(actor(), draft.id, { acknowledgeHighImpact: true }),
    ).rejects.toThrow(/not valid/i);
  });

  it('high-impact activation requires explicit acknowledgement', async () => {
    const draft = await config.createDraft(actor(), 'ai.credit-rules', ENV, uniqueReason());
    await config.updateDraft(
      actor(),
      draft.id,
      {
        unit: 'milli-credits',
        minimumGrossMarginPercent: 60,
        costs: [
          {
            taskKey: 'caption.generate',
            modelKey: 'real-model',
            baseMilliCredits: 1000,
            perUnitMilliCredits: 0,
            unit: 'request',
          },
        ],
      },
      draft.lockVersion,
    );
    await config.validateDraft(actor(), draft.id);
    await expect(config.activate(actor(), draft.id)).rejects.toThrow(/high-impact/i);
  });
});

describe('optimistic concurrency', () => {
  it('the second of two concurrent editors is refused, not silently overwritten', async () => {
    const draft = await config.createDraft(actor(), 'usage-limits', ENV, uniqueReason());

    // Both administrators load the same version.
    const adminA = draft.lockVersion;
    const adminB = draft.lockVersion;

    await config.updateDraft(
      actor(),
      draft.id,
      { limits: [{ key: 'a', scope: 'user', windowSeconds: 60, maxRequests: 10 }] },
      adminA,
    );

    await expect(
      config.updateDraft(
        actor(),
        draft.id,
        { limits: [{ key: 'b', scope: 'user', windowSeconds: 60, maxRequests: 20 }] },
        adminB,
      ),
    ).rejects.toThrow(/changed by someone else/i);

    // A's edit survives intact — B's write was refused, not merged.
    const after = await config.getVersion(actor(), draft.id);
    expect((after.payload as { limits: { key: string }[] }).limits[0]?.key).toBe('a');
  });

  it('the lock version increments on every successful save', async () => {
    const draft = await config.createDraft(actor(), 'usage-limits', ENV, uniqueReason());
    const first = await config.updateDraft(actor(), draft.id, { limits: [] }, draft.lockVersion);
    expect(first.lockVersion).toBe(draft.lockVersion + 1);
    const second = await config.updateDraft(actor(), draft.id, { limits: [] }, first.lockVersion);
    expect(second.lockVersion).toBe(first.lockVersion + 1);
  });
});

describe('configuration authorisation', () => {
  it('refuses an actor without verified MFA', async () => {
    await expect(
      config.createDraft(
        {
          platformUserId: ownerId,
          roleKey: 'platform_owner',
          mfaVerified: false,
          permissionKeys: OWNER_PERMISSIONS,
        },
        'website',
        ENV,
        uniqueReason(),
      ),
    ).rejects.toThrow(/verified MFA/);
  });

  it('refuses a change with no written reason', async () => {
    await expect(config.createDraft(actor(), 'website', ENV, 'x')).rejects.toThrow(/at least 8/);
  });
});

describe('secret service against the real database', () => {
  it('stores a secret and returns only masked metadata', async () => {
    const ref = buildSecretRef({
      category: 'ai_provider',
      provider: `${TEST_SECRET_PROVIDER}-p`,
      environment: 'development',
      name: 'api-key',
    });
    const meta = await secrets.createSecret(actor(), {
      ref,
      name: 'Test AI key',
      category: 'ai_provider',
      environment: ENV,
      value: 'sk-test-abcdefghijklmnopqrstuvwxyz-9f2a',
    });

    expect(meta.maskedHint).toBe('…9f2a');
    expect(meta.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    // The metadata object must contain nothing resembling the value.
    expect(JSON.stringify(meta)).not.toContain('sk-test-abcdef');
  });

  it('stores NO plaintext anywhere in the database', async () => {
    const value = `sk-plain-${crypto.randomUUID()}`;
    const ref = buildSecretRef({
      category: 'email_provider',
      provider: `${TEST_SECRET_PROVIDER}-e`,
      environment: 'development',
      name: 'api-key',
    });
    await secrets.createSecret(actor(), {
      ref,
      name: 'Plaintext probe',
      category: 'email_provider',
      environment: ENV,
      value,
    });

    // Search the raw row: ciphertext, wrapped key, hint and fingerprint.
    const rows = await prisma.$queryRaw<{ blob: string }[]>`
      SELECT (v.*)::text AS blob FROM "secret_version" v
       JOIN "secret_record" r ON r.id = v."secretRecordId"
      WHERE r.ref = ${ref}`;
    expect(rows.length).toBe(1);
    expect(rows[0]?.blob).not.toContain(value);
  });

  it('resolves the value only through resolveSecret', async () => {
    const value = 'sk-resolve-abcdefghijklmnop-1234';
    const ref = buildSecretRef({
      category: 'object_storage',
      provider: `${TEST_SECRET_PROVIDER}-s`,
      environment: 'development',
      name: 'access-key',
    });
    await secrets.createSecret(actor(), {
      ref,
      name: 'Resolve probe',
      category: 'object_storage',
      environment: ENV,
      value,
    });
    expect(await secrets.resolveSecret(ref, ENV)).toBe(value);
  });

  it('rotates with zero downtime: exactly one ACTIVE version at all times', async () => {
    const ref = buildSecretRef({
      category: 'ai_provider',
      provider: `${TEST_SECRET_PROVIDER}-r`,
      environment: 'development',
      name: 'api-key',
    });
    const created = await secrets.createSecret(actor(), {
      ref,
      name: 'Rotate probe',
      category: 'ai_provider',
      environment: ENV,
      value: 'sk-old-abcdefghijklmnop-1111',
    });

    const rotated = await secrets.rotateSecret(
      actor(),
      created.id,
      'sk-new-abcdefghijklmnop-2222',
      'Scheduled rotation for tests',
    );
    expect(rotated.activeVersion).toBe(2);
    expect(rotated.maskedHint).toBe('…2222');
    expect(await secrets.resolveSecret(ref, ENV)).toBe('sk-new-abcdefghijklmnop-2222');

    const versions = await prisma.secretVersion.findMany({ where: { secretRecordId: created.id } });
    expect(versions.filter((v) => v.status === 'ACTIVE')).toHaveLength(1);
    expect(versions.filter((v) => v.status === 'RETIRED')).toHaveLength(1);
  });

  it('a disabled secret cannot be resolved', async () => {
    const ref = buildSecretRef({
      category: 'payment_provider',
      provider: `${TEST_SECRET_PROVIDER}-d`,
      environment: 'development',
      name: 'secret-key',
    });
    const created = await secrets.createSecret(actor(), {
      ref,
      name: 'Disable probe',
      category: 'payment_provider',
      environment: ENV,
      value: 'sk-disable-abcdefghij-3333',
    });
    await secrets.disableSecret(actor(), created.id, 'Disabling for the test');
    await expect(secrets.resolveSecret(ref, ENV)).rejects.toThrow(/disabled/i);
  });

  it('a revoked secret can never be re-enabled', async () => {
    const ref = buildSecretRef({
      category: 'other',
      provider: `${TEST_SECRET_PROVIDER}-x`,
      environment: 'development',
      name: 'k',
    });
    const created = await secrets.createSecret(actor(), {
      ref,
      name: 'Revoke probe',
      category: 'other',
      environment: ENV,
      value: 'sk-revoke-abcdefghij-4444',
    });
    await secrets.revokeSecret(actor(), created.id, 'Revoking for the test');
    await expect(secrets.enableSecret(actor(), created.id, 'Trying to re-enable')).rejects.toThrow(
      /revoked/i,
    );
  });

  it('refuses a secret operation without verified MFA', async () => {
    await expect(
      secrets.createSecret(
        {
          platformUserId: ownerId,
          roleKey: 'platform_owner',
          mfaVerified: false,
          permissionKeys: OWNER_PERMISSIONS,
        },
        {
          ref: 'x/y/z/w',
          name: 'n',
          category: 'other',
          environment: ENV,
          value: 'v-abcdefghijklmnop',
        },
      ),
    ).rejects.toThrow(/verified MFA/);
  });

  it('the secret material is immutable — rotation is the only way to change it', async () => {
    const ref = buildSecretRef({
      category: 'other',
      provider: `${TEST_SECRET_PROVIDER}-i`,
      environment: 'development',
      name: 'k',
    });
    const created = await secrets.createSecret(actor(), {
      ref,
      name: 'Immutable probe',
      category: 'other',
      environment: ENV,
      value: 'sk-immutable-abcdefgh-5555',
    });
    const version = await prisma.secretVersion.findFirstOrThrow({
      where: { secretRecordId: created.id },
    });

    // A database trigger, so this holds even against direct SQL.
    await expect(
      prisma.secretVersion.update({
        where: { id: version.id },
        data: { ciphertext: 'dGFtcGVyZWQ=' },
      }),
    ).rejects.toThrow();
  });

  it('matches a candidate against the fingerprint without decrypting', async () => {
    const value = 'sk-fingerprint-abcdefgh-6666';
    const ref = buildSecretRef({
      category: 'other',
      provider: `${TEST_SECRET_PROVIDER}-f`,
      environment: 'development',
      name: 'k',
    });
    const created = await secrets.createSecret(actor(), {
      ref,
      name: 'Fingerprint probe',
      category: 'other',
      environment: ENV,
      value,
    });
    expect(await secrets.matchesStoredValue(actor(), created.id, value)).toBe(true);
    expect(await secrets.matchesStoredValue(actor(), created.id, 'something-else-entirely')).toBe(
      false,
    );
  });
});

describe('audit events for platform operations', () => {
  it('creating a secret writes an audit event with no value in it', async () => {
    const value = 'sk-audit-abcdefghijklmn-7777';
    const ref = buildSecretRef({
      category: 'other',
      provider: `${TEST_SECRET_PROVIDER}-a`,
      environment: 'development',
      name: 'k',
    });
    const created = await secrets.createSecret(actor(), {
      ref,
      name: 'Audit probe',
      category: 'other',
      environment: ENV,
      value,
    });

    const event = await prisma.auditEvent.findFirst({
      where: { action: 'secret.created', resourceId: created.id },
    });
    expect(event).not.toBeNull();
    expect(JSON.stringify(event)).not.toContain(value);
    expect(JSON.stringify(event?.after)).toContain('…7777');
  });

  it('activating configuration writes an audit event', async () => {
    const draft = await config.createDraft(actor(), 'website', ENV, uniqueReason());
    await config.validateDraft(actor(), draft.id);
    await config.activate(actor(), draft.id, { acknowledgeHighImpact: true });

    const event = await prisma.auditEvent.findFirst({
      where: { action: 'config.activated', resourceId: draft.id },
    });
    expect(event).not.toBeNull();
    expect(event?.actorId).toBe(ownerId);
  });

  it('audit events remain immutable for the platform role too', async () => {
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'config.activated' },
    });
    await expect(
      prisma.auditEvent.update({ where: { id: event.id }, data: { action: 'tampered' } }),
    ).rejects.toThrow(/permission denied/i);
  });
});
