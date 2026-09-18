import { describe, expect, it } from 'vitest';
import {
  applyProviderRecord,
  editableSettingFields,
  findIntegration,
  integrationSecretRef,
  parseCredentialInput,
  parseSettingsInput,
  secretCategoryFor,
  type IntegrationDefinition,
} from '@brandspace/integrations';

/**
 * THE REGISTRY DECIDES WHAT A FORM MAY SAY — the Phase 10 correction, §4 and §10.
 *
 * WHAT THESE TESTS ARE FOR, and it is not coverage. The Integrations Hub now
 * accepts input from an owner, which makes it the first Control Center screen
 * where "what did the browser send" and "what may be stored" are different
 * questions. Every function below answers the second one by walking the
 * REGISTRY and reading values out of the submission — never by walking the
 * submission — so an undeclared key is not blocked, it is never looked at.
 * These tests hold that shape in place.
 *
 * AND THE MAPPING IS TESTED WITH SYNTHETIC DEFINITIONS ON PURPOSE. §11 forbids
 * adding a real vendor, and §5 requires that a real adapter registered later can
 * be configured from the Hub without a second administration workflow. Those two
 * are only compatible if the mapping is exercised against a definition the
 * registry does not contain — which is exactly what `applyProviderRecord` takes.
 * No fake vendor row exists anywhere an owner can see.
 */

/** A definition shaped like a future real AI adapter. Never registered. */
const FUTURE_AI: IntegrationDefinition = {
  providerKey: 'future-ai-adapter',
  displayNameEn: 'Future AI adapter',
  displayNameAr: 'محوّل ذكاء اصطناعي مستقبلي',
  category: 'ai',
  supportedEnvironments: ['DEVELOPMENT', 'STAGING', 'PRODUCTION'],
  capabilities: { text: true },
  credentialFields: [
    { key: 'apiKey', labelEn: 'API key', labelAr: 'مفتاح', secret: true, required: true },
  ],
  settingFields: [
    {
      key: 'baseUrl',
      labelEn: 'Base URL',
      labelAr: 'الرابط',
      secret: false,
      required: true,
      kind: 'url',
    },
  ],
  adapterAvailable: true,
  testable: true,
  developmentOnly: false,
  noteEn: 'A synthetic definition used only to prove the mapping.',
  noteAr: 'تعريف اصطناعي لإثبات التحويل فقط.',
};

/** A definition shaped like a future real social developer application. */
const FUTURE_SOCIAL: IntegrationDefinition = {
  ...FUTURE_AI,
  providerKey: 'linkedin',
  category: 'social',
  credentialFields: [
    {
      key: 'clientSecret',
      labelEn: 'Client secret',
      labelAr: 'سر العميل',
      secret: true,
      required: true,
    },
  ],
  settingFields: [
    { key: 'appId', labelEn: 'App id', labelAr: 'المعرّف', secret: false, required: true },
    {
      key: 'redirectUri',
      labelEn: 'Redirect URI',
      labelAr: 'رابط العودة',
      secret: false,
      required: true,
      kind: 'url',
    },
  ],
};

describe('a form is parsed against the registry, never the other way round', () => {
  const payment = findIntegration('payment', 'development-mock')!;

  it('reads only the fields this provider declares', () => {
    const { settings, ignored } = parseSettingsInput(payment, {
      hostedBaseUrl: 'https://pay.example.test',
      adminOverride: 'true',
      activeProviderKey: 'development-mock',
    });

    expect(settings).toEqual({ hostedBaseUrl: 'https://pay.example.test' });
    // Named rather than silently dropped, so a caller can say what it ignored.
    expect(ignored).toContain('adminOverride');
    expect(ignored).toContain('activeProviderKey');
  });

  it('never reads a generated field from a submission', () => {
    // A webhook URL an owner can type is a payment callback an owner can
    // redirect. The registry marks it generated; the parser does not look.
    const { settings } = parseSettingsInput(payment, {
      hostedBaseUrl: 'https://pay.example.test',
      webhookUrl: 'https://attacker.example/collect',
    });
    expect(settings['webhookUrl']).toBeUndefined();
    expect(editableSettingFields(payment).map((field) => field.key)).not.toContain('webhookUrl');
  });

  it('refuses a required field left empty', () => {
    expect(() => parseSettingsInput(payment, {})).toThrow(/required/i);
  });

  it('refuses a URL field that is not an http(s) URL', () => {
    for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url']) {
      expect(() => parseSettingsInput(payment, { hostedBaseUrl: value })).toThrow(/URL/i);
    }
  });

  it('treats an absent credential as "leave it alone", not "clear it"', () => {
    // The form cannot pre-populate a secret, so an empty box is the normal
    // state of every edit that is not a rotation.
    expect(parseCredentialInput(payment, {})).toEqual({});
    expect(parseCredentialInput(payment, { webhookSecret: '   ' })).toEqual({});
    expect(parseCredentialInput(payment, { webhookSecret: ' whsec-abc ' })).toEqual({
      webhookSecret: 'whsec-abc',
    });
  });

  it('ignores an undeclared credential key entirely', () => {
    expect(parseCredentialInput(payment, { apiKey: 'sk-not-declared-here' })).toEqual({});
  });
});

describe('a credential reference is deterministic and environment-scoped', () => {
  const payment = findIntegration('payment', 'development-mock')!;

  it('produces the same reference for the same slot, so a rotation finds it', () => {
    const first = integrationSecretRef(payment, 'DEVELOPMENT', 'webhookSecret');
    const second = integrationSecretRef(payment, 'DEVELOPMENT', 'webhookSecret');
    expect(first).toBe(second);
  });

  it('separates environments, so staging and production are never confused', () => {
    expect(integrationSecretRef(payment, 'STAGING', 'webhookSecret')).not.toBe(
      integrationSecretRef(payment, 'PRODUCTION', 'webhookSecret'),
    );
  });

  it('classifies the secret the way the Secrets page would', () => {
    expect(secretCategoryFor('payment')).toBe('payment_provider');
    expect(secretCategoryFor('ai')).toBe('ai_provider');
    expect(secretCategoryFor('social')).toBe('social_oauth_app');
    expect(secretCategoryFor('email')).toBe('email_provider');
    expect(secretCategoryFor('storage')).toBe('object_storage');
  });
});

describe('the Hub writes into the canonical documents, and cannot activate', () => {
  it('creates an ai.providers record with the eligibility gates still unverified', () => {
    const next = applyProviderRecord({
      definition: FUTURE_AI,
      domain: 'ai.providers',
      document: { providers: [] },
      settings: { baseUrl: 'https://api.example.test' },
      secretRefs: { apiKey: 'integration/ai/future-ai-adapter/production/apiKey' },
    }) as { providers: Record<string, unknown>[] };

    const record = next.providers[0]!;
    expect(record['key']).toBe('future-ai-adapter');
    expect(record['baseUrl']).toBe('https://api.example.test');
    expect(record['apiKeySecretRef']).toBe('integration/ai/future-ai-adapter/production/apiKey');

    /*
     * D-13 IS NOT CLEARED BY FILLING IN A FORM. A person confirms in a privacy
     * review that a vendor does not train on customer data; `validateConfiguration`
     * refuses to activate a provider still sitting on the default. Creating the
     * row pre-cleared would have turned an owner decision into a side effect.
     */
    expect(record['status']).toBe('draft');
    expect(record['noTrainingGuarantee']).toBe(false);
    expect(record['dataRetentionPolicy']).toBe('unverified');
  });

  it('updates an existing ai.providers record without touching its status', () => {
    const next = applyProviderRecord({
      definition: FUTURE_AI,
      domain: 'ai.providers',
      document: {
        providers: [
          {
            key: 'future-ai-adapter',
            name: 'Future AI adapter',
            baseUrl: 'https://old.example.test',
            apiKeySecretRef: null,
            status: 'active',
            noTrainingGuarantee: true,
            dataRetentionPolicy: 'zero_retention',
          },
        ],
      },
      settings: { baseUrl: 'https://new.example.test' },
      secretRefs: { apiKey: 'integration/ai/future-ai-adapter/production/apiKey' },
    }) as { providers: Record<string, unknown>[] };

    const record = next.providers[0]!;
    expect(record['baseUrl']).toBe('https://new.example.test');
    // Saving a new base URL must not disable a live provider, and must not
    // clear a gate somebody cleared deliberately.
    expect(record['status']).toBe('active');
    expect(record['noTrainingGuarantee']).toBe(true);
  });

  it('creates a social developer-application record for a registered adapter', () => {
    const next = applyProviderRecord({
      definition: FUTURE_SOCIAL,
      domain: 'integrations.social-apps',
      document: { applications: [] },
      settings: { appId: '1234567890', redirectUri: 'https://app.example.test/oauth/callback' },
      secretRefs: { clientSecret: 'integration/social/linkedin/production/clientSecret' },
    }) as { applications: Record<string, unknown>[] };

    const record = next.applications[0]!;
    expect(record['providerKey']).toBe('linkedin');
    expect(record['appId']).toBe('1234567890');
    expect(record['clientSecretRef']).toBe('integration/social/linkedin/production/clientSecret');
    expect(record['status']).toBe('draft');
  });

  it('refuses to record an AI provider with no base URL rather than writing an invalid draft', () => {
    expect(() =>
      applyProviderRecord({
        definition: FUTURE_AI,
        domain: 'ai.providers',
        document: { providers: [] },
        settings: {},
        secretRefs: {},
      }),
    ).toThrow(/base URL/i);
  });

  it('never writes activeProviderKey, whatever the document held', () => {
    const payment = findIntegration('payment', 'development-mock')!;
    for (const activeProviderKey of [null, 'something-else']) {
      const next = applyProviderRecord({
        definition: payment,
        domain: 'integrations.payment',
        document: { activeProviderKey, providers: [] },
        settings: { hostedBaseUrl: 'https://pay.example.test' },
        secretRefs: {
          webhookSecret: 'integration/payment/development-mock/development/webhookSecret',
        },
      }) as { activeProviderKey: string | null; providers: Record<string, unknown>[] };

      // SAVE IS NOT ACTIVATE (§6), guaranteed by the function being incapable
      // of it rather than by a caller remembering not to ask.
      expect(next.activeProviderKey).toBe(activeProviderKey);
      expect(next.providers[0]!['status']).toBe('draft');
    }
  });

  it('leaves the source document untouched', () => {
    const document = Object.freeze({ activeProviderKey: null, providers: [] });
    const payment = findIntegration('payment', 'development-mock')!;
    const next = applyProviderRecord({
      definition: payment,
      domain: 'integrations.payment',
      document,
      settings: { hostedBaseUrl: 'https://pay.example.test' },
      secretRefs: {},
    }) as { providers: unknown[] };

    // The caller holds the active document; mutating it would corrupt the
    // value a draft is diffed against.
    expect(document.providers).toHaveLength(0);
    expect(next.providers).toHaveLength(1);
  });

  it('merges settings rather than replacing the whole map', () => {
    const payment = findIntegration('payment', 'development-mock')!;
    const next = applyProviderRecord({
      definition: payment,
      domain: 'integrations.payment',
      document: {
        activeProviderKey: null,
        providers: [
          {
            key: 'development-mock',
            name: 'Development payment provider',
            status: 'draft',
            settings: {
              webhookUrl: 'https://api.example.test/v1/billing/webhook/development-mock',
            },
            secretRefs: {
              webhookSecret: 'integration/payment/development-mock/development/webhookSecret',
            },
          },
        ],
      },
      settings: { hostedBaseUrl: 'https://pay.example.test' },
      secretRefs: {},
    }) as { providers: Record<string, Record<string, unknown>>[] };

    const record = next.providers[0]!;
    // Both survive: an edit to one setting must not drop a generated one, and
    // an edit with no credential must not detach a working key.
    expect(record['settings']!['hostedBaseUrl']).toBe('https://pay.example.test');
    expect(record['settings']!['webhookUrl']).toContain('/v1/billing/webhook/');
    expect(record['secretRefs']!['webhookSecret']).toContain('webhookSecret');
  });
});

describe('the registry still lists no vendor, after all of this', () => {
  it('registers neither of the synthetic definitions these tests use', () => {
    // §11: the mapping is proven against shapes a real adapter would have, and
    // not one of them is reachable from the Control Center.
    expect(findIntegration('ai', 'future-ai-adapter')).toBeUndefined();
    expect(findIntegration('social', 'linkedin')).toBeUndefined();
  });
});
