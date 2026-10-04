import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { arEgOverrides } from '../../apps/dashboard/src/i18n/ar-eg';
import {
  dictionaryFor,
  evidenceRefs,
  messageLocaleFor,
  messages,
  optionalMessage,
  translator,
  type MessageKey,
} from '../../apps/dashboard/src/i18n/messages';

/**
 * D-470 — THE INTERFACE ARABIC FOLLOWS THE WORKSPACE'S COUNTRY.
 *
 * An Arabic reader in an Egyptian workspace reads `ar-EG`: the Egyptian layer
 * laid over formal Arabic key by key. Every other Arabic reader, and every
 * screen before a workspace exists, reads formal Arabic. English is untouched.
 */

const overrides = arEgOverrides as Readonly<Record<string, string>>;
const overridden = Object.keys(overrides) as MessageKey[];
const notOverridden = (Object.keys(messages.ar) as MessageKey[]).filter(
  (key) => !(key in overrides),
);

describe('messageLocaleFor: the words follow the route language and the workspace country', () => {
  it('Egypt reads Egyptian Arabic on the Arabic route', () => {
    expect(messageLocaleFor('ar', 'EG')).toBe('ar-EG');
    expect(messageLocaleFor('ar', 'eg')).toBe('ar-EG');
  });

  it('every other country, and no country at all, reads formal Arabic', () => {
    for (const country of ['SA', 'AE', 'KW', 'US', 'GB', '']) {
      expect(messageLocaleFor('ar', country), country).toBe('ar');
    }
    expect(messageLocaleFor('ar', null)).toBe('ar');
    expect(messageLocaleFor('ar', undefined)).toBe('ar');
  });

  it('the English route is English whatever the country', () => {
    expect(messageLocaleFor('en', 'EG')).toBe('en');
    expect(messageLocaleFor('en', 'SA')).toBe('en');
    expect(messageLocaleFor('en', null)).toBe('en');
  });
});

describe('the Egyptian layer falls back to formal Arabic, key by key', () => {
  it('a key the layer has reads the Egyptian string', () => {
    const t = translator('ar-EG');
    expect(overridden.length).toBeGreaterThan(0);
    for (const key of overridden) expect(t(key), key).toBe(overrides[key]);
  });

  it('a key the layer lacks reads the formal string, never English or nothing', () => {
    const t = translator('ar-EG');
    expect(notOverridden.length).toBeGreaterThan(0);
    for (const key of notOverridden) expect(t(key), key).toBe(messages.ar[key]);
  });

  it('the Egyptian dictionary has exactly the formal key set', () => {
    expect(Object.keys(dictionaryFor('ar-EG')).sort()).toEqual(Object.keys(messages.ar).sort());
  });

  it('formal Arabic and English are not touched by the layer', () => {
    expect(dictionaryFor('ar')).toBe(messages.ar);
    expect(dictionaryFor('en')).toBe(messages.en);
    for (const key of overridden) {
      expect(translator('ar')(key), key).toBe(messages.ar[key]);
      expect(translator('en')(key), key).toBe(messages.en[key]);
    }
  });

  it('optionalMessage reads the same layer, and still answers null for a missing key', () => {
    const [key] = overridden;
    expect(optionalMessage('ar-EG', key as string)).toBe(overrides[key as string]);
    expect(optionalMessage('ar-EG', 'no.such.key')).toBeNull();
    expect(optionalMessage('ar-EG', notOverridden[0] as string)).toBe(
      messages.ar[notOverridden[0] as MessageKey],
    );
  });

  it('Arabic punctuation follows the Egyptian reader too', () => {
    expect(evidenceRefs('ar-EG', [1, 2])).toBe(evidenceRefs('ar', [1, 2]));
  });

  it('every Egyptian string is Arabic, as P6-14 requires of the formal ones', () => {
    // The prototype writes its product names in Latin in Arabic too (the
    // design note's only exception): a value that IS one of them passes.
    const latinProductNames = new Set(['Brand Brain', 'BrandSpace']);
    for (const [key, value] of Object.entries(overrides)) {
      if (latinProductNames.has(value)) continue;
      expect(/[؀-ۿ]/.test(value), key).toBe(true);
    }
  });
});

describe('workspace pages read their words through the message locale', () => {
  /*
   * A page that resolves a workspace session and then translates with the
   * ROUTE locale would show an Egyptian member formal Arabic — the miss this
   * guard exists to catch as each prototype screen is ported.
   */
  const root = path.resolve(__dirname, '../../apps/dashboard/src/app/[locale]');
  const pages: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'page.tsx') pages.push(full);
    }
  };
  walk(root);

  it('finds the workspace pages', () => {
    expect(pages.length).toBeGreaterThan(30);
  });

  it('no page with a workspace session translates with the route locale', () => {
    const offenders = pages.filter((file) => {
      const source = readFileSync(file, 'utf8');
      const hasSession =
        /await (requireWorkspacePage|requireWorkspace|pendingDeletionSession)\(/.test(source);
      return hasSession && /translator\(locale\)/.test(source);
    });
    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  });
});
