import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

import {
  findIntegration,
  findIntegrationCategory,
  INTEGRATION_CATEGORIES,
  INTEGRATION_CATEGORY_DEFINITIONS,
  INTEGRATION_DEFINITIONS,
  INTEGRATION_ENVIRONMENTS,
  integrationsInCategory,
  selectionRefusal,
  settingsSchemaFor,
} from '@brandspace/integrations';
import { CONFIG_DOMAIN_KEYS } from '@brandspace/config';

/**
 * The integrations registry — Phase 10 §2 and §4.
 *
 * WHAT THESE TESTS ARE FOR. The Control Center's Integrations screen is
 * GENERATED from this registry, which means a wrong entry is not a wrong
 * constant — it is a wrong screen, shown to the person deciding what to buy.
 * The assertions below are about HONESTY more than correctness: a provider
 * without an adapter must not be offered, a credential must not be storable
 * anywhere but the vault, and a development double must not be selectable in
 * production whichever screen asks.
 */

describe('every registered integration is honest about itself', () => {
  it('has an adapter, because the Hub offers only what BrandSpace can talk to', () => {
    /*
     * §4's rule, asserted rather than promised. Listing a vendor with an empty
     * adapter would be choosing the owner's provider by implication — exactly
     * what D-204 declined to do for payments.
     */
    for (const definition of INTEGRATION_DEFINITIONS) {
      expect(definition.adapterAvailable, definition.providerKey).toBe(true);
    }
  });

  it('belongs to a category that exists and is reachable both ways', () => {
    for (const definition of INTEGRATION_DEFINITIONS) {
      expect(findIntegrationCategory(definition.category)).toBeDefined();
      expect(findIntegration(definition.category, definition.providerKey)).toBe(definition);
      expect(integrationsInCategory(definition.category)).toContain(definition);
    }
  });

  it('declares at least one environment, and only real ones', () => {
    for (const definition of INTEGRATION_DEFINITIONS) {
      expect(definition.supportedEnvironments.length).toBeGreaterThan(0);
      for (const environment of definition.supportedEnvironments) {
        expect(INTEGRATION_ENVIRONMENTS).toContain(environment);
      }
    }
  });

  it('marks every credential field secret and every setting field not', () => {
    // A credential written into the configuration document instead of the vault
    // would be a secret in a readable, versioned, exportable place.
    for (const definition of INTEGRATION_DEFINITIONS) {
      for (const field of definition.credentialFields) {
        expect(field.secret, `${definition.providerKey}.${field.key}`).toBe(true);
      }
      for (const field of definition.settingFields) {
        expect(field.secret, `${definition.providerKey}.${field.key}`).toBe(false);
      }
    }
  });

  it('gives every row a note in both languages', () => {
    // The screen is bilingual, and a row whose explanation exists in only one
    // language is a row half the audience cannot evaluate.
    for (const definition of INTEGRATION_DEFINITIONS) {
      expect(definition.noteEn.length, definition.providerKey).toBeGreaterThan(20);
      expect(definition.noteAr.length, definition.providerKey).toBeGreaterThan(20);
      expect(definition.displayNameAr).not.toBe(definition.displayNameEn);
    }
  });

  it('declares at least one capability, so "declared, never assumed" means something', () => {
    for (const definition of INTEGRATION_DEFINITIONS) {
      expect(Object.keys(definition.capabilities).length, definition.providerKey).toBeGreaterThan(
        0,
      );
    }
  });
});

describe('the categories', () => {
  it('names a configuration domain that actually exists', () => {
    // A category pointing at a domain the configuration service does not have
    // would render an empty screen with no error.
    for (const category of INTEGRATION_CATEGORY_DEFINITIONS) {
      expect(CONFIG_DOMAIN_KEYS, category.key).toContain(category.configDomain);
    }
  });

  it('covers every category key exactly once', () => {
    expect(INTEGRATION_CATEGORY_DEFINITIONS.map((c) => c.key).sort()).toEqual(
      [...INTEGRATION_CATEGORIES].sort(),
    );
  });

  it('requires in production exactly the four the platform cannot serve without', () => {
    /*
     * Stated as a list rather than a rule, because each one is a judgement:
     * without AI every feature in the product is unavailable; without payments
     * nothing can be sold; without email nobody can finish signing up; without
     * storage no file can be kept. Social and observability are genuinely
     * optional, and taking the platform down because nobody registered a TikTok
     * application would be a self-inflicted outage.
     */
    const required = INTEGRATION_CATEGORY_DEFINITIONS.filter((c) => c.requiredInProduction).map(
      (c) => c.key,
    );
    expect(required.sort()).toEqual(['ai', 'email', 'payment', 'storage']);
  });
});

describe('selection refusals', () => {
  it('refuses every development-only integration in production', () => {
    const developmentOnly = INTEGRATION_DEFINITIONS.filter((d) => d.developmentOnly);
    expect(developmentOnly.length).toBeGreaterThan(0);
    for (const definition of developmentOnly) {
      expect(selectionRefusal(definition, 'PRODUCTION')).toMatch(
        /never be activated in production/i,
      );
    }
  });

  it('allows them where they belong', () => {
    for (const definition of INTEGRATION_DEFINITIONS.filter((d) => d.developmentOnly)) {
      expect(selectionRefusal(definition, 'DEVELOPMENT')).toBeNull();
    }
  });

  it('refuses an environment a provider does not declare', () => {
    const definition = INTEGRATION_DEFINITIONS.find(
      (d) => !d.supportedEnvironments.includes('PRODUCTION') && !d.developmentOnly,
    );
    // Only meaningful if such a definition exists; every entry today is a
    // development double, and the assertion above covers those.
    if (definition) {
      expect(selectionRefusal(definition, 'PRODUCTION')).toContain('does not support');
    }
  });
});

describe('the settings schema', () => {
  it('requires exactly the fields the definition marks required', () => {
    for (const definition of INTEGRATION_DEFINITIONS) {
      const schema = settingsSchemaFor(definition);
      const complete = Object.fromEntries(definition.settingFields.map((f) => [f.key, 'x']));
      expect(schema.safeParse(complete).success, definition.providerKey).toBe(true);
      for (const field of definition.settingFields.filter((f) => f.required)) {
        const missing = { ...complete };
        delete (missing as Record<string, string>)[field.key];
        expect(schema.safeParse(missing).success, `${definition.providerKey}.${field.key}`).toBe(
          false,
        );
      }
    }
  });
});

describe('the package cannot decrypt anything', () => {
  it('never calls resolveSecret', () => {
    /*
     * `packages/integrations` is one of only three packages allowed to import
     * the Secret Service, and it needs it for MASKED METADATA ONLY. The lint
     * allowance says so in a comment; this says so in a test, because the
     * package that can NAME the Secret Service is one edit away from
     * decrypting with it.
     */
    const sources = globSync('packages/integrations/src/**/*.ts');
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain('resolveSecret');
      expect(text, file).not.toContain('decryptSecret');
    }
  });
});
