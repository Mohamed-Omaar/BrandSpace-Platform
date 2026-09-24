import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_DEFAULT_LOCALE, DEFAULT_LOCALE } from '@brandspace/ui';
import { resolveContentLanguage } from '../../apps/dashboard/src/server/content-language';

/**
 * PHASE 6 FINAL · D-277 — ENGLISH IS THE CUSTOMER DEFAULT.
 *
 * The owner decided the customer interface starts in English unless `/ar` is
 * asked for, and that interface language and content language are separate.
 * Pinned here so an old D-03 fallback cannot creep back in one action at a time.
 */

const ROOT = path.resolve(__dirname, '../..');
const DASHBOARD = path.join(ROOT, 'apps/dashboard/src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    let directory = false;
    try {
      directory = statSync(full).isDirectory();
    } catch {
      continue; // a probe file planted and removed by another suite
    }
    if (directory) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function read(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

describe('D-277 · the customer interface defaults to English', () => {
  it('the customer default is English; the website keeps Arabic (the Control Center has its own, D-310)', () => {
    expect(CUSTOMER_DEFAULT_LOCALE).toBe('en');
    expect(DEFAULT_LOCALE).toBe('ar');
  });

  it('the dashboard redirects a locale-less path to the CUSTOMER default', () => {
    const middleware = read(path.join(DASHBOARD, 'middleware.ts'));
    expect(middleware).toMatch(/\/\$\{CUSTOMER_DEFAULT_LOCALE\}/);
    expect(middleware).not.toMatch(/\bDEFAULT_LOCALE\b(?<!CUSTOMER_DEFAULT_LOCALE)/);
  });

  it('no dashboard action falls back to Arabic when the form carries no locale', () => {
    const offenders = sources(DASHBOARD).filter((file) =>
      /\?\?\s*'ar'|\?\?\s*'AR'/.test(read(file)),
    );
    expect(offenders.map((file) => path.relative(ROOT, file))).toEqual([]);
  });

  it('new rows default to English in the schema', () => {
    const schema = read(path.join(ROOT, 'packages/database/prisma/schema.prisma'));
    expect(schema).toMatch(/primaryLocale Locale\s+@default\(EN\)/);
    expect(schema).not.toMatch(/Locale\s+@default\(AR\)/);
  });
});

describe('D-277 · content language is not interface language', () => {
  it('an explicit choice wins', () => {
    expect(resolveContentLanguage('AR', 'EN')).toBe('AR');
    expect(resolveContentLanguage('EN', 'AR')).toBe('EN');
  });

  it('without one, the brand’s own preference', () => {
    expect(resolveContentLanguage(null, 'AR')).toBe('AR');
    expect(resolveContentLanguage('fr', 'AR')).toBe('AR');
  });

  it('without either, English — never a silent Arabic', () => {
    expect(resolveContentLanguage(undefined, null)).toBe('EN');
  });

  it('the composer starts from the brand’s preference, not the UI locale', () => {
    const composer = read(path.join(DASHBOARD, 'app/[locale]/content/compose/composer-view.tsx'));
    expect(composer).not.toMatch(/useState<ContentLocale>\(locale === 'ar'/);
    expect(composer).toMatch(/defaultLocale \?\? 'EN'/);
  });
});
