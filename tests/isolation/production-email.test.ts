import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ConfigurationService } from '@brandspace/config';
import { SecretService } from '@brandspace/secrets';
import {
  IntegrationsService,
  activeProviderSelection,
  findIntegration,
} from '@brandspace/integrations';
import { renderEmail } from '@brandspace/auth';
import { PLATFORM_PERMISSIONS } from '@brandspace/shared';
import { appRoleClient, ensurePlatformRole, platformRoleClient } from './fixtures';

/**
 * THE RESEND CREDENTIAL, AND EVERY PLACE IT MUST NOT APPEAR.
 *
 * Connecting a real transactional email provider put an actual, usable
 * credential into the platform for the first time. Every earlier integration
 * was a development double whose "secret" could leak without consequence; this
 * one can send mail from the platform's verified domain to anybody, which makes
 * it a phishing primitive with the product's sending reputation attached.
 *
 * SO THE PROOFS ARE ABOUT WHERE THE VALUE IS NOT. Against real PostgreSQL,
 * because every claim is about what was actually WRITTEN — a configuration
 * document, an audit row, a health-check row, a column the tenant role can
 * read. A mocked Secret Service would let all of them pass while the real one
 * wrote plaintext into a column, which is the defect class this suite exists to
 * catch.
 *
 * NO REAL CREDENTIAL IS USED. `FAKE_RESEND_KEY` below is a deliberately
 * non-credential-shaped string that no provider would accept, and nothing in
 * this file opens a socket to Resend.
 */

let platform: PrismaClient;
let app: PrismaClient;
let secrets: SecretService;
let configuration: ConfigurationService;
let integrations: IntegrationsService;
let ownerId: string;
let readOnlyId: string;

const ENV = 'DEVELOPMENT' as const;
const CATEGORY = 'email';
const PROVIDER = 'resend';
const DOMAIN = 'integrations.email';

/**
 * A value distinctive enough that finding it anywhere is unambiguous, and
 * shaped so that no secret scanner mistakes it for a real key. A real Resend
 * key begins `re_`; this deliberately does not.
 */
const FAKE_RESEND_KEY = 'fixture-not-a-credential-7f2b9c41aa53e8d0';
const ROTATED_KEY = 'fixture-not-a-credential-rotated-1d4e6f0b8c27';
const FROM_EMAIL = 'no-reply@brandspace.test';

function owner() {
  return {
    platformUserId: ownerId,
    roleKey: 'platform_owner',
    mfaVerified: true,
    permissionKeys: PLATFORM_PERMISSIONS.map((permission) => permission.key),
  };
}

/** The same person, before they completed the step-up challenge. */
function ownerWithoutMfa() {
  return { ...owner(), mfaVerified: false };
}

/** Somebody who may LOOK at the Control Center and change nothing. */
function readOnlyStaff() {
  return {
    platformUserId: readOnlyId,
    roleKey: 'platform_support',
    mfaVerified: true,
    permissionKeys: ['platform.configuration.read'],
  };
}

beforeAll(async () => {
  platform = platformRoleClient();
  app = appRoleClient();
  secrets = new SecretService({ prisma: platform, env: { SECRET_VAULT_KEK: 'k'.repeat(48) } });
  configuration = new ConfigurationService({ prisma: platform });
  integrations = new IntegrationsService({ prisma: platform, configuration, secrets });

  const roleId = await ensurePlatformRole(platform);
  ownerId = (
    await platform.platformUser.create({
      data: {
        email: `email-owner-${crypto.randomUUID()}@brandspace.local`,
        name: 'Email Configuration Owner',
        status: 'ACTIVE',
        roleId,
      },
    })
  ).id;
  readOnlyId = (
    await platform.platformUser.create({
      data: {
        email: `email-readonly-${crypto.randomUUID()}@brandspace.local`,
        name: 'Read Only Staff',
        status: 'ACTIVE',
        roleId,
      },
    })
  ).id;

  await resetProviderSlot();
}, 120_000);

/**
 * Start from "Resend was never configured", every run.
 *
 * `integrationSecretRef` is deterministic so that a rotation finds the secret
 * the owner saved last time — which means a second run against a persistent
 * database would find the first run's secret and record a rotation where this
 * suite expects a first write. Narrow on purpose: one secret ref and one
 * provider record, both of which only this path creates.
 */
async function resetProviderSlot(): Promise<void> {
  const ref = `integration/${CATEGORY}/${PROVIDER}/${ENV.toLowerCase()}/apiKey`;
  const record = await platform.secretRecord.findUnique({
    where: { ref_environment: { ref, environment: ENV } },
  });
  if (record) {
    await platform.secretVersion.deleteMany({ where: { secretRecordId: record.id } });
    await platform.secretRecord.delete({ where: { id: record.id } });
  }

  const document = (await configuration.get(DOMAIN, ENV)) as {
    activeProviderKey: string | null;
    providers: { key: string }[];
  };
  if (!document.providers.some((provider) => provider.key === PROVIDER)) return;

  const draft = await configuration.createDraft(
    owner(),
    DOMAIN,
    ENV,
    'Isolation suite: clearing the Resend provider record before the run.',
    {
      ...document,
      providers: document.providers.filter((provider) => provider.key !== PROVIDER),
      activeProviderKey:
        document.activeProviderKey === PROVIDER ? null : document.activeProviderKey,
    },
  );
  await configuration.activate(owner(), draft.id);
}

/** Turn the provider on the way the Hub does: edit the document, activate it. */
async function activateResend(): Promise<void> {
  const document = (await configuration.get(DOMAIN, ENV)) as Record<string, unknown>;
  const next = structuredClone(document) as {
    activeProviderKey: string | null;
    providers: Record<string, unknown>[];
  };
  const record = next.providers.find((provider) => provider['key'] === PROVIDER);
  expect(record, 'Save must have created the record; Activate creates nothing').toBeTruthy();
  record!['status'] = 'active';
  next.activeProviderKey = PROVIDER;

  const draft = await configuration.createDraft(
    owner(),
    DOMAIN,
    ENV,
    'Activating Resend for transactional email.',
    next,
  );
  await configuration.activate(owner(), draft.id);
}

afterAll(async () => {
  /*
   * LEAVE THE ENVIRONMENT AS IT WAS FOUND, and the reason is not tidiness.
   *
   * This suite ACTIVATES Resend, and `integrations.email` is one document
   * shared by every suite that runs against this database — including the
   * Playwright journey, which asserts that a freshly saved provider is not yet
   * active. Leaving it on made that journey fail with "Yes" where it expected
   * "No", which reads as a product defect (Save silently activating) and is in
   * fact one test suite handing mutable state to another.
   *
   * `beforeAll` already clears the slot, so this is belt and braces rather than
   * the only guard — but a run that crashes midway leaves the document behind,
   * and the next suite to read it is the one that pays.
   */
  try {
    await resetProviderSlot();
  } finally {
    await platform?.$disconnect();
    await app?.$disconnect();
  }
});

// ---------------------------------------------------------------------------

describe('the owner saves the Resend credential from the Hub', () => {
  it('stores it through the Secret Service and references it from configuration', async () => {
    const saved = await integrations.saveConfiguration({
      actor: owner(),
      category: CATEGORY,
      providerKey: PROVIDER,
      environment: ENV,
      settings: { fromEmail: FROM_EMAIL, fromName: 'BrandSpace' },
      credentials: { apiKey: FAKE_RESEND_KEY },
      reason: 'Connecting Resend as the transactional email provider.',
    });

    const credential = saved.credentials.find((c) => c.fieldKey === 'apiKey');
    expect(credential?.present).toBe(true);
    expect(credential?.secretRef).toBeTruthy();
    expect(saved.configurationComplete).toBe(true);
    /*
     * THE WHOLE VIEW, not the one field. A defect that copied the value into an
     * unrelated key — a settings echo, a debug field, a message — would pass a
     * targeted assertion and fail this one.
     */
    expect(JSON.stringify(saved)).not.toContain(FAKE_RESEND_KEY);
  });

  it('writes a REFERENCE into the configuration document, never the value', async () => {
    const document = (await configuration.get(DOMAIN, ENV)) as {
      providers: {
        key: string;
        settings: Record<string, unknown>;
        secretRefs: Record<string, string>;
      }[];
    };
    const record = document.providers.find((provider) => provider.key === PROVIDER);

    expect(record?.secretRefs['apiKey']).toMatch(/^integration\/email\/resend\//);
    expect(record?.settings['fromEmail']).toBe(FROM_EMAIL);
    expect(JSON.stringify(document)).not.toContain(FAKE_RESEND_KEY);
  });

  it('exposes masked metadata only, and no path from the view back to the value', async () => {
    const view = await integrations.get(owner(), CATEGORY, PROVIDER, ENV);
    const credential = view.credentials.find((c) => c.fieldKey === 'apiKey');

    expect(credential?.present).toBe(true);
    expect(credential?.maskedHint).toBeTruthy();

    /*
     * A HINT IS A TAIL, AND THE ASSERTION IS ABOUT HOW MUCH OF ONE.
     *
     * The hint deliberately SHOWS the last few characters — that is what makes
     * it useful for telling two keys apart — so "the key does not contain the
     * hint" would be an assertion that could only pass if the feature were
     * broken. What matters is the bound: how many characters escape, and
     * whether anything but the tail does.
     */
    const revealed = credential!.maskedHint!.replace(/[^A-Za-z0-9]/g, '');
    expect(revealed.length).toBeLessThanOrEqual(4);
    expect(FAKE_RESEND_KEY.endsWith(revealed)).toBe(true);
    // Everything before the tail stays hidden.
    expect(credential!.maskedHint).not.toContain(FAKE_RESEND_KEY.slice(0, -revealed.length));
    expect(credential!.maskedHint).not.toBe(FAKE_RESEND_KEY);
  });

  it('keeps the value out of every audit event it writes', async () => {
    const events = await platform.auditEvent.findMany({
      where: { actorId: ownerId },
      orderBy: { occurredAt: 'desc' },
      take: 20,
    });

    expect(events.length).toBeGreaterThan(0);
    const payload = JSON.stringify(events);
    // The operation IS recorded — an audit trail that said nothing would pass
    // a "no secret" assertion trivially.
    expect(payload).toContain('apiKey');
    expect(payload).not.toContain(FAKE_RESEND_KEY);
  });

  it('leaves Resend inactive: saving is not activating', async () => {
    const view = await integrations.get(owner(), CATEGORY, PROVIDER, ENV);
    expect(view.enabled).toBe(false);

    const document = (await configuration.get(DOMAIN, ENV)) as {
      activeProviderKey: string | null;
      providers: { key: string; status: string }[];
    };
    expect(document.providers.find((p) => p.key === PROVIDER)?.status).toBe('draft');
    expect(document.activeProviderKey).not.toBe(PROVIDER);
  });
});

describe('Resend is not testable from the Hub, and that is deliberate', () => {
  /*
   * THE LEAST-PRIVILEGE CREDENTIAL DECIDES THE SURFACE.
   *
   * BrandSpace asks for a Resend SENDING-ACCESS key restricted to the verified
   * sending domain. It can send and do nothing else — every non-destructive
   * check Resend offers is a read, and a send-only key is refused all of them.
   *
   * A Test Connection button therefore had three possible behaviours: report a
   * correctly-scoped production key as broken, demand a Full Access key to make
   * the tick go green, or send an unsolicited probe message to a real inbox.
   * The registry marks the provider `testable: false` instead, and the proof
   * the key works is the controlled smoke email the owner performs after
   * activation.
   *
   * SAVE AND ACTIVATE REMAIN SEPARATE. Removing the middle step does not merge
   * the other two, which the surrounding suites assert.
   */
  it('declares itself untestable rather than failing an honest key', () => {
    const definition = findIntegration(CATEGORY, PROVIDER);
    expect(definition?.testable).toBe(false);
    // Still a real, usable adapter — untestable is not unavailable.
    expect(definition?.adapterAvailable).toBe(true);
    expect(definition?.developmentOnly).toBe(false);
  });

  it('asks for a send-only key by name, so nobody widens the scope to suit a button', () => {
    const definition = findIntegration(CATEGORY, PROVIDER);
    const apiKey = definition?.credentialFields.find((field) => field.key === 'apiKey');
    expect(apiKey?.helpEn).toContain('SENDING ACCESS ONLY');
    expect(apiKey?.helpEn).toContain('Do not use a Full Access key');
  });

  it('explains the missing button on the screen, in both languages', () => {
    const definition = findIntegration(CATEGORY, PROVIDER);
    expect(definition?.noteEn).toContain('no Test connection button');
    expect(definition?.noteEn).toContain('smoke email');
    expect(definition?.noteAr).not.toBe(definition?.noteEn);
    expect(definition?.noteAr.length).toBeGreaterThan(40);
  });

  it('REFUSES a test request at the service, not merely by hiding a button', async () => {
    /*
     * THE SCREEN HIDES THE BUTTON; THIS IS WHAT ENFORCES IT. A server action is
     * reachable by anybody who can reach the action, so an omitted control is
     * presentation rather than authorisation. Without the guard the request
     * would fall through to the tester, find no case for Resend, and record a
     * "no connection test is implemented" failure against a healthy
     * integration — a red mark an owner would act on.
     */
    let testerRan = false;

    const view = await integrations.testConnection({
      actor: owner(),
      category: CATEGORY,
      providerKey: PROVIDER,
      environment: ENV,
      tester: {
        async test() {
          testerRan = true;
          return { ok: true, latencyMs: 1, message: 'This must never run.' };
        },
      },
      requestedByPlatformUserId: ownerId,
    });

    expect(testerRan, 'no adapter may be reached for an untestable provider').toBe(false);
    expect(view.connection).not.toBe('ok');

    // The refusal is RECORDED, and says why rather than reporting a failure.
    const [latest] = await platform.integrationHealthCheck.findMany({
      where: { category: CATEGORY, providerKey: PROVIDER, environment: ENV },
      orderBy: { checkedAt: 'desc' },
      take: 1,
    });
    expect(latest?.outcome).toBe('REFUSED');
    expect(latest?.message).toContain('cannot be tested from here');
    expect(JSON.stringify(latest)).not.toContain(FAKE_RESEND_KEY);
  });

  it('is still inactive: nothing about removing the test activated it', async () => {
    const view = await integrations.get(owner(), CATEGORY, PROVIDER, ENV);
    expect(view.enabled).toBe(false);

    const document = (await configuration.get(DOMAIN, ENV)) as {
      activeProviderKey: string | null;
    };
    expect(document.activeProviderKey).not.toBe(PROVIDER);
  });
});

describe('activation is a separate, authorised act', () => {
  it('turns Resend on, and only then does resolution select it', async () => {
    await activateResend();

    const document = await configuration.get(DOMAIN, ENV);
    const selection = activeProviderSelection('email', ENV, document);

    expect(selection?.providerKey).toBe(PROVIDER);
    expect(selection?.settings['fromEmail']).toBe(FROM_EMAIL);
  });

  it('hands the resolver a REFERENCE, so a caller that cannot decrypt gets nothing usable', async () => {
    const document = await configuration.get(DOMAIN, ENV);
    const selection = activeProviderSelection('email', ENV, document);

    /*
     * THE BOUNDARY THAT KEEPS THE DASHBOARD OUT OF THE VAULT. `packages/
     * integrations` resolves which provider is live; it cannot resolve the
     * credential, and this asserts the difference rather than trusting it.
     */
    expect(selection?.secretRefs['apiKey']).toMatch(/^integration\/email\/resend\//);
    expect(JSON.stringify(selection)).not.toContain(FAKE_RESEND_KEY);

    // And the reference genuinely needs the vault to become a value.
    await expect(secrets.resolveSecret(selection!.secretRefs['apiKey']!, ENV)).resolves.toBe(
      FAKE_RESEND_KEY,
    );
  });

  it('records the activation with an author and a reason', async () => {
    const versions = await platform.configurationVersion.findMany({
      where: { domain: DOMAIN, environment: ENV },
      orderBy: { versionNumber: 'desc' },
      take: 3,
    });
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0]?.activatedByPlatformUserId).toBe(ownerId);
    expect(versions[0]?.changeReason).toBeTruthy();
    expect(JSON.stringify(versions)).not.toContain(FAKE_RESEND_KEY);
  });
});

describe('rotation', () => {
  it('replaces the value, keeps the reference, and never reads the old one back', async () => {
    const before = await integrations.get(owner(), CATEGORY, PROVIDER, ENV);
    const refBefore = before.credentials.find((c) => c.fieldKey === 'apiKey')?.secretRef;

    const after = await integrations.saveConfiguration({
      actor: owner(),
      category: CATEGORY,
      providerKey: PROVIDER,
      environment: ENV,
      settings: { fromEmail: FROM_EMAIL },
      credentials: { apiKey: ROTATED_KEY },
      reason: 'Rotating the Resend API key.',
    });

    const credential = after.credentials.find((c) => c.fieldKey === 'apiKey');
    expect(credential?.secretRef).toBe(refBefore);
    expect(credential?.lastRotatedAt).not.toBeNull();

    // The live value is the new one, and neither value is in the view.
    await expect(secrets.resolveSecret(refBefore!, ENV)).resolves.toBe(ROTATED_KEY);
    expect(JSON.stringify(after)).not.toContain(ROTATED_KEY);
    expect(JSON.stringify(after)).not.toContain(FAKE_RESEND_KEY);
  });
});

describe('who may do any of this', () => {
  it('refuses an owner who has not completed the MFA step-up (D-27)', async () => {
    await expect(
      integrations.saveConfiguration({
        actor: ownerWithoutMfa(),
        category: CATEGORY,
        providerKey: PROVIDER,
        environment: ENV,
        settings: { fromEmail: FROM_EMAIL },
        credentials: { apiKey: 'fixture-not-a-credential-mfa-attempt' },
        reason: 'Attempting to save without a verified second factor.',
      }),
    ).rejects.toThrow(/MFA/i);
  });

  it('refuses platform staff who may read configuration but not manage it', async () => {
    await expect(
      integrations.saveConfiguration({
        actor: readOnlyStaff(),
        category: CATEGORY,
        providerKey: PROVIDER,
        environment: ENV,
        settings: { fromEmail: FROM_EMAIL },
        credentials: { apiKey: 'fixture-not-a-credential-readonly-attempt' },
        reason: 'Attempting to save without the manage permission.',
      }),
    ).rejects.toThrow();
  });

  it('refuses read-only staff the activation itself', async () => {
    const document = (await configuration.get(DOMAIN, ENV)) as Record<string, unknown>;
    await expect(
      configuration.createDraft(
        readOnlyStaff(),
        DOMAIN,
        ENV,
        'Attempting to activate without the activate permission.',
        document,
      ),
    ).rejects.toThrow();
  });
});

describe('the tenant database identity cannot reach the credential at all', () => {
  /*
   * NOT "IS NOT GIVEN IT" BUT "CANNOT READ IT". The customer dashboard connects
   * as `brandspace_app`. These assert PostgreSQL's own refusal, which holds
   * whatever the application layer does — including a bug in it.
   */
  it('is refused the secret records', async () => {
    await expect(app.secretRecord.findMany()).rejects.toThrow(/permission denied/i);
  });

  it('is refused the secret VERSIONS that hold the ciphertext', async () => {
    await expect(app.secretVersion.findMany()).rejects.toThrow(/permission denied/i);
  });

  it('is refused the configuration versions that hold the reference', async () => {
    await expect(app.configurationVersion.findMany()).rejects.toThrow(/permission denied/i);
  });

  it('is refused the integration health checks', async () => {
    await expect(app.integrationHealthCheck.findMany()).rejects.toThrow(/permission denied/i);
  });
});

describe('the rendered message', () => {
  it('carries the link and the locale and nothing about the provider', async () => {
    const rendered = renderEmail({
      to: 'person@example.com',
      templateKey: 'auth.email_verification',
      locale: 'AR',
      link: 'https://app.example.test/ar/verify?token=abc',
    });

    expect(rendered.html).toContain('dir="rtl"');
    expect(rendered.html).toContain('https://app.example.test/ar/verify?token=abc');
    /*
     * A TEMPLATE THAT NAMED THE VENDOR would be a template that has to change
     * when the vendor does. More to the point here: it must not carry anything
     * from the credential or the configuration beyond the From identity the
     * adapter sets on the envelope.
     */
    expect(rendered.html.toLowerCase()).not.toContain('resend');
    expect(rendered.text.toLowerCase()).not.toContain('resend');
    expect(JSON.stringify(rendered)).not.toContain(ROTATED_KEY);
  });
});

describe('the registry describes Resend honestly', () => {
  it('declares exactly one secret field and three plain settings', () => {
    const definition = findIntegration(CATEGORY, PROVIDER);
    expect(definition?.credentialFields.map((f) => f.key)).toEqual(['apiKey']);
    expect(definition?.credentialFields.every((f) => f.secret)).toBe(true);
    expect(definition?.settingFields.map((f) => f.key)).toEqual([
      'fromEmail',
      'fromName',
      'replyTo',
    ]);
    expect(definition?.settingFields.some((f) => f.secret)).toBe(false);
    expect(definition?.developmentOnly).toBe(false);
  });
});
