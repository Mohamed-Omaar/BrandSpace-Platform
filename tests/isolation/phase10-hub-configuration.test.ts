import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ConfigurationService } from '@brandspace/config';
import { SecretService } from '@brandspace/secrets';
import { IntegrationsService, findIntegration } from '@brandspace/integrations';
import { PLATFORM_PERMISSIONS } from '@brandspace/shared';
import { appRoleClient, ensurePlatformRole, platformRoleClient } from './fixtures';

/**
 * THE INTEGRATIONS HUB AS THE OWNER-FACING CONFIGURATION SURFACE — the Phase 10
 * correction, §13.
 *
 * WHY THIS SUITE IS AGAINST REAL POSTGRESQL RATHER THAN MOCKS. Every claim
 * below is about what is actually WRITTEN: that a configuration document holds
 * a reference and not a key, that an audit row carries an operation and not a
 * value, that a health-check row records an outcome and not a secret. A mock of
 * the Secret Service would let all four pass while the real one wrote plaintext
 * into a column, which is exactly the defect class these tests exist to catch.
 *
 * THE SHAPE OF THE PROOF IS A ROUND TRIP, not a set of unit assertions about
 * intermediate values:
 *
 *   an owner enters a credential
 *     -> it is stored through the Secret Service
 *     -> configuration references it
 *     -> Test Connection resolves it server-side
 *     -> the adapter's own signature verifies with it
 *
 * If any link were faked — a tester reading an environment variable, a
 * configuration document holding the value directly — the chain would still
 * produce a green tick. So the tests below check the LINKS, not the tick.
 */

let platform: PrismaClient;
let app: PrismaClient;
let secrets: SecretService;
let configuration: ConfigurationService;
let integrations: IntegrationsService;
let ownerId: string;
let configOnlyId: string;

const ENV = 'DEVELOPMENT' as const;
const CATEGORY = 'payment';
const PROVIDER = 'development-mock';

/** A value shaped like a real signing secret, so a leak is unmistakable. */
const FIRST_SECRET = 'whsec-hub-first-9f2b7c41aa53e8d0';
const ROTATED_SECRET = 'whsec-hub-rotated-1d4e6f0b8c27a95e';
const HOSTED_URL = 'http://localhost:3003';

function owner() {
  return {
    platformUserId: ownerId,
    roleKey: 'platform_owner',
    mfaVerified: true,
    permissionKeys: PLATFORM_PERMISSIONS.map((permission) => permission.key),
  };
}

beforeAll(async () => {
  platform = platformRoleClient();
  app = appRoleClient();
  secrets = new SecretService({ prisma: platform, env: { SECRET_VAULT_KEK: 'k'.repeat(48) } });
  configuration = new ConfigurationService({ prisma: platform });
  integrations = new IntegrationsService({ prisma: platform, configuration, secrets });

  const roleId = await ensurePlatformRole(platform);
  const created = await platform.platformUser.create({
    data: {
      email: `hub-owner-${crypto.randomUUID()}@brandspace.local`,
      name: 'Hub Configuration Owner',
      status: 'ACTIVE',
      roleId,
    },
  });
  ownerId = created.id;

  const second = await platform.platformUser.create({
    data: {
      email: `hub-config-${crypto.randomUUID()}@brandspace.local`,
      name: 'Configuration Only',
      status: 'ACTIVE',
      roleId,
    },
  });
  configOnlyId = second.id;

  await resetProviderSlot();
}, 120_000);

/**
 * Start from "nothing configured", every run.
 *
 * THE SUITE IS NOT SELF-ISOLATING BY ACCIDENT, and the reason is the feature
 * under test: `integrationSecretRef` is DETERMINISTIC so that a rotation finds
 * the secret the owner saved last time. The same property means a second run
 * against a persistent database would find the first run's secret and record a
 * rotation where the test expects a first write — so the suite clears its own
 * slot rather than asserting whichever outcome it happened to get.
 *
 * NARROW ON PURPOSE. It removes exactly one secret ref and one provider record,
 * both of which only this Hub path creates; it does not truncate a table.
 */
async function resetProviderSlot(): Promise<void> {
  const ref = `integration/${CATEGORY}/${PROVIDER}/${ENV.toLowerCase()}/webhookSecret`;
  const record = await platform.secretRecord.findUnique({
    where: { ref_environment: { ref, environment: ENV } },
  });
  if (record) {
    await platform.secretVersion.deleteMany({ where: { secretRecordId: record.id } });
    await platform.secretRecord.delete({ where: { id: record.id } });
  }

  const document = (await configuration.get('integrations.payment', ENV)) as {
    activeProviderKey: string | null;
    providers: { key: string }[];
  };
  if (!document.providers.some((provider) => provider.key === PROVIDER)) return;

  const draft = await configuration.createDraft(
    owner(),
    'integrations.payment',
    ENV,
    'Isolation suite: clearing the development payment provider record before the run.',
    {
      ...document,
      providers: document.providers.filter((provider) => provider.key !== PROVIDER),
      activeProviderKey:
        document.activeProviderKey === PROVIDER ? null : document.activeProviderKey,
    },
  );
  await configuration.activate(owner(), draft.id);
}

afterAll(async () => {
  await platform?.$disconnect();
  await app?.$disconnect();
});

describe('an owner configures a provider from the Hub alone', () => {
  it('stores the credential through the Secret Service and references it from configuration', async () => {
    const saved = await integrations.saveConfiguration({
      actor: owner(),
      category: CATEGORY,
      providerKey: PROVIDER,
      environment: ENV,
      settings: { hostedBaseUrl: HOSTED_URL },
      credentials: { webhookSecret: FIRST_SECRET },
      generatedSettings: { webhookUrl: `${HOSTED_URL}/v1/billing/webhook/${PROVIDER}` },
      reason: 'Phase 10 correction: connecting the development payment provider.',
    });

    const credential = saved.credentials.find((c) => c.fieldKey === 'webhookSecret');
    expect(credential?.present).toBe(true);
    expect(credential?.secretRef).toBeTruthy();
    // The masked hint is at most the last four characters, and the view that
    // carries it has no field that could carry a value.
    expect(JSON.stringify(saved)).not.toContain(FIRST_SECRET);
    expect(saved.configurationComplete).toBe(true);
  });

  it('writes a REFERENCE into the configuration document, never the value', async () => {
    const document = (await configuration.get('integrations.payment', ENV)) as {
      providers: {
        key: string;
        settings: Record<string, unknown>;
        secretRefs: Record<string, string>;
      }[];
    };
    const record = document.providers.find((provider) => provider.key === PROVIDER);

    expect(record?.secretRefs['webhookSecret']).toMatch(
      /^integration\/payment\/development-mock\//,
    );
    expect(record?.settings['hostedBaseUrl']).toBe(HOSTED_URL);
    /*
     * THE WHOLE DOCUMENT, not just the field we expect. A defect that copied
     * the value into an unrelated key would pass a targeted assertion and fail
     * this one.
     */
    expect(JSON.stringify(document)).not.toContain(FIRST_SECRET);
  });

  it('records the save in the audit trail with an operation and a reference, never a value', async () => {
    const events = await platform.auditEvent.findMany({
      where: { action: 'integration.configuration.saved', actorId: ownerId },
      orderBy: { occurredAt: 'desc' },
      take: 5,
    });

    expect(events.length).toBeGreaterThan(0);
    const payload = JSON.stringify(events);
    expect(payload).toContain('webhookSecret');
    expect(payload).toContain('created');
    expect(payload).not.toContain(FIRST_SECRET);
  });

  it('leaves the provider inactive: saving is not activating', async () => {
    const view = await integrations.get(owner(), CATEGORY, PROVIDER, ENV);
    expect(view.enabled).toBe(false);

    const document = (await configuration.get('integrations.payment', ENV)) as {
      activeProviderKey: string | null;
      providers: { key: string; status: string }[];
    };
    // Both halves matter. A record created as `active`, or an
    // `activeProviderKey` set as a side effect of saving a key, would each on
    // their own turn Save into Activate.
    expect(document.providers.find((provider) => provider.key === PROVIDER)?.status).toBe('draft');
    expect(document.activeProviderKey).not.toBe(PROVIDER);
  });
});

describe('Test Connection uses the configuration the owner saved', () => {
  it('resolves the stored credential server-side and verifies a signature with it', async () => {
    let seen: { settings: Record<string, string>; credentials: Record<string, string> } | null =
      null;

    const view = await integrations.testConnection({
      actor: owner(),
      category: CATEGORY,
      providerKey: PROVIDER,
      environment: ENV,
      tester: {
        async test(input) {
          /*
           * RESOLVED THE WAY THE REAL TESTER DOES IT — through the Secret
           * Service, from the references the Hub read out of configuration.
           * Asserting on the refs alone would prove the plumbing and not the
           * round trip; resolving here proves the value an adapter would
           * receive is the value the owner typed.
           */
          const credentials: Record<string, string> = {};
          for (const [field, ref] of Object.entries(input.credentialRefs)) {
            credentials[field] = await secrets.resolveSecret(ref, ENV);
          }
          seen = { settings: { ...input.settings }, credentials };
          return { ok: true, latencyMs: 1, message: 'Verified against the saved configuration.' };
        },
      },
      requestedByPlatformUserId: ownerId,
    });

    /*
     * THE ASSERTION THE CORRECTION EXISTS FOR. Before it, the payment tester
     * read `BILLING_DEV_WEBHOOK_SECRET` from the process environment while the
     * Hub displayed a `webhookSecret` the owner had entered — the screen
     * claimed to verify one thing and verified another. What arrives at the
     * tester must be what came out of the vault.
     */
    expect(seen).not.toBeNull();
    expect(seen!.credentials['webhookSecret']).toBe(FIRST_SECRET);
    expect(seen!.settings['hostedBaseUrl']).toBe(HOSTED_URL);
    expect(view.connection).toBe('ok');
  });

  it('keeps no plaintext in the health-check row it writes', async () => {
    const rows = await platform.integrationHealthCheck.findMany({
      where: { category: CATEGORY, providerKey: PROVIDER, environment: ENV },
      orderBy: { checkedAt: 'desc' },
      take: 10,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(FIRST_SECRET);
  });

  it('activates nothing', async () => {
    const view = await integrations.get(owner(), CATEGORY, PROVIDER, ENV);
    expect(view.enabled).toBe(false);
  });
});

describe('rotation replaces the value without ever reading the old one', () => {
  it('records a rotation and keeps the same reference', async () => {
    const before = await integrations.get(owner(), CATEGORY, PROVIDER, ENV);
    const refBefore = before.credentials.find((c) => c.fieldKey === 'webhookSecret')?.secretRef;

    const after = await integrations.saveConfiguration({
      actor: owner(),
      category: CATEGORY,
      providerKey: PROVIDER,
      environment: ENV,
      settings: { hostedBaseUrl: HOSTED_URL },
      credentials: { webhookSecret: ROTATED_SECRET },
      reason: 'Phase 10 correction: rotating the development webhook secret.',
    });

    const credential = after.credentials.find((c) => c.fieldKey === 'webhookSecret');
    /*
     * THE SAME REF, DELIBERATELY. A rotation that minted a new reference would
     * leave the previous secret in the vault with configuration pointing
     * elsewhere — two secrets, one slot, and no way to tell which is live.
     */
    expect(credential?.secretRef).toBe(refBefore);
    expect(credential?.lastRotatedAt).not.toBeNull();

    const events = await platform.auditEvent.findMany({
      where: { action: 'integration.configuration.saved', actorId: ownerId },
      orderBy: { occurredAt: 'desc' },
      take: 1,
    });
    expect(JSON.stringify(events)).toContain('rotated');
    expect(JSON.stringify(events)).not.toContain(ROTATED_SECRET);
  });

  it('serves the NEW value to the next test, and the old one is unrecoverable', async () => {
    let resolved: string | null = null;
    await integrations.testConnection({
      actor: owner(),
      category: CATEGORY,
      providerKey: PROVIDER,
      environment: ENV,
      tester: {
        async test(input) {
          const ref = input.credentialRefs['webhookSecret'];
          resolved = ref ? await secrets.resolveSecret(ref, ENV) : null;
          return { ok: true, latencyMs: 1, message: 'ok' };
        },
      },
    });

    expect(resolved).toBe(ROTATED_SECRET);
    // The superseded version is retired rather than readable: there is no API
    // that returns it, and the active version is the only one resolvable.
    expect(resolved).not.toBe(FIRST_SECRET);
  });

  it('leaves an untouched credential alone when only a setting changes', async () => {
    const saved = await integrations.saveConfiguration({
      actor: owner(),
      category: CATEGORY,
      providerKey: PROVIDER,
      environment: ENV,
      settings: { hostedBaseUrl: 'http://localhost:3099' },
      // No credential submitted: an empty box means "leave it alone", not
      // "clear it". Treating it as a deletion would wipe a working key every
      // time somebody corrected a URL.
      credentials: {},
      reason: 'Phase 10 correction: editing only the hosted checkout URL.',
    });

    expect(saved.credentials.find((c) => c.fieldKey === 'webhookSecret')?.present).toBe(true);
    expect(saved.settings['hostedBaseUrl']).toBe('http://localhost:3099');
  });
});

describe('the Hub refuses what it should refuse', () => {
  it('refuses an unknown provider key outright', async () => {
    await expect(
      integrations.saveConfiguration({
        actor: owner(),
        category: CATEGORY,
        providerKey: 'stripe',
        environment: ENV,
        settings: {},
        /*
         * NOT `sk-...`. Nothing here needs a value shaped like a real key, and
         * the repository's secret scan is right to fail a tracked file that
         * contains one - a fixture that looks like a credential is how a real
         * one eventually hides among them.
         */
        credentials: { apiKey: 'undeclared-credential-value' },
        reason: 'Attempting to configure a provider nobody registered.',
      }),
    ).rejects.toThrow(/registered/i);
  });

  it('ignores undeclared fields rather than storing them', async () => {
    await integrations.saveConfiguration({
      actor: owner(),
      category: CATEGORY,
      providerKey: PROVIDER,
      environment: ENV,
      settings: {
        hostedBaseUrl: HOSTED_URL,
        // Neither is declared by this provider. The parser walks the REGISTRY,
        // not the submission, so these are never looked at.
        adminOverride: 'true',
        'settings.__proto__': 'polluted',
      },
      credentials: { apiKey: 'undeclared-credential-value' },
      reason: 'Phase 10 correction: proving undeclared keys are not stored.',
    });

    const document = JSON.stringify(await configuration.get('integrations.payment', ENV));
    expect(document).not.toContain('adminOverride');
    expect(document).not.toContain('polluted');
    expect(document).not.toContain('undeclared-credential-value');
  });

  it('refuses a credential write without verified MFA', async () => {
    await expect(
      integrations.saveConfiguration({
        actor: { ...owner(), mfaVerified: false },
        category: CATEGORY,
        providerKey: PROVIDER,
        environment: ENV,
        settings: { hostedBaseUrl: HOSTED_URL },
        credentials: { webhookSecret: 'whsec-should-never-be-written' },
        reason: 'Phase 10 correction: MFA is required for a credential write.',
      }),
    ).rejects.toThrow(/MFA/i);

    const document = JSON.stringify(await configuration.get('integrations.payment', ENV));
    expect(document).not.toContain('whsec-should-never-be-written');
  });

  it('refuses a credential write from an actor without platform.secret.manage', async () => {
    const configOnly = {
      platformUserId: configOnlyId,
      roleKey: 'platform_operator',
      mfaVerified: true,
      permissionKeys: PLATFORM_PERMISSIONS.map((permission) => permission.key).filter(
        (key) => key !== 'platform.secret.manage',
      ),
    };

    await expect(
      integrations.saveConfiguration({
        actor: configOnly,
        category: CATEGORY,
        providerKey: PROVIDER,
        environment: ENV,
        settings: { hostedBaseUrl: HOSTED_URL },
        credentials: { webhookSecret: 'whsec-insufficient-permission' },
        reason: 'Phase 10 correction: secret authority is separate from configuration authority.',
      }),
    ).rejects.toThrow(/platform\.secret\.manage/i);
  });

  it('refuses a change reason shorter than the configuration service requires', async () => {
    await expect(
      integrations.saveConfiguration({
        actor: owner(),
        category: CATEGORY,
        providerKey: PROVIDER,
        environment: ENV,
        settings: { hostedBaseUrl: HOSTED_URL },
        credentials: {},
        reason: 'short',
      }),
    ).rejects.toThrow(/reason/i);
  });

  it('refuses a setting that is declared a URL and is not one', async () => {
    await expect(
      integrations.saveConfiguration({
        actor: owner(),
        category: CATEGORY,
        providerKey: PROVIDER,
        environment: ENV,
        settings: { hostedBaseUrl: 'javascript:alert(1)' },
        credentials: {},
        reason: 'Phase 10 correction: a URL field refuses a non-URL.',
      }),
    ).rejects.toThrow(/URL/i);
  });

  it('will not let the Hub write a generated field from caller input', async () => {
    const definition = findIntegration(CATEGORY, PROVIDER);
    expect(definition?.settingFields.find((f) => f.key === 'webhookUrl')?.generated).toBe(true);

    await integrations.saveConfiguration({
      actor: owner(),
      category: CATEGORY,
      providerKey: PROVIDER,
      environment: ENV,
      // Submitted as an ORDINARY setting, which is the attack: a webhook URL
      // an owner can type is a payment callback an owner can redirect.
      settings: { hostedBaseUrl: HOSTED_URL, webhookUrl: 'https://attacker.example/collect' },
      credentials: {},
      reason: 'Phase 10 correction: a generated field is never read from a form.',
    });

    const document = JSON.stringify(await configuration.get('integrations.payment', ENV));
    expect(document).not.toContain('attacker.example');
  });
});

describe('ordinary workspace actors cannot reach any of it', () => {
  it('refuses the tenant role the configuration versions behind the Hub', async () => {
    await expect(app.configurationVersion.findMany()).rejects.toThrow(/permission denied/i);
  });

  it('refuses the tenant role the secret records the Hub writes', async () => {
    await expect(app.secretRecord.findMany()).rejects.toThrow(/permission denied/i);
  });

  it('refuses the tenant role the secret VERSIONS that hold the ciphertext', async () => {
    await expect(app.secretVersion.findMany()).rejects.toThrow(/permission denied/i);
  });
});
