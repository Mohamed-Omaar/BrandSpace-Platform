import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dictionaryFor,
  messageLocaleFor,
  messages,
  translator,
  type MessageKey,
} from '../../apps/dashboard/src/i18n/messages';

/**
 * ROUND 4, STEP 6 — ONE ARABIC FOR EVERY COUNTRY (replaces D-470).
 *
 * An Arabic reader reads the product's formal Arabic whatever the workspace's
 * country, Egypt included; the Egyptian layer and the country switch are gone.
 * English is untouched.
 */

describe('messageLocaleFor: the words follow the route language only', () => {
  it('the Arabic route is formal Arabic', () => {
    expect(messageLocaleFor('ar')).toBe('ar');
  });

  it('every other route is English', () => {
    expect(messageLocaleFor('en')).toBe('en');
    expect(messageLocaleFor('ar-EG')).toBe('en');
  });
});

describe('there is one Arabic dictionary', () => {
  it('Arabic and English are the two dictionaries', () => {
    expect(dictionaryFor('ar')).toBe(messages.ar);
    expect(dictionaryFor('en')).toBe(messages.en);
  });

  it('a retired dialect tag can no longer select a third dictionary', () => {
    expect(dictionaryFor('ar-EG')).toBe(messages.en);
  });

  it('every Arabic string is read as written', () => {
    const t = translator('ar');
    for (const key of Object.keys(messages.ar) as MessageKey[]) {
      expect(t(key), key).toBe(messages.ar[key]);
    }
  });
});

describe('workspace pages read their words through the message locale', () => {
  /*
   * Kept after Step 6: a workspace page reads its words through the one
   * message locale its session resolved, so the words have exactly one path.
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
