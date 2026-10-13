import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEGAL_DOCUMENT_KEYS,
  LEGAL_VERSION,
  legalDocument,
  legalPlaceholders,
} from '../../apps/dashboard/src/legal/documents';
import { defaultPayload, parseConfigPayload } from '@brandspace/config';

/**
 * PR F, Q11 — the beta's legal documents: the same sections in both languages,
 * the clause every upload control links to, a version sign-up can carry, and
 * placeholders that are listed rather than hidden.
 */
const ROOT = join(__dirname, '..', '..');

describe('the legal documents', () => {
  it.each(LEGAL_DOCUMENT_KEYS)('%s has the same sections in English and Arabic', (key) => {
    const en = legalDocument(key, 'en');
    const ar = legalDocument(key, 'ar');
    expect(ar.sections.map((s) => s.id)).toEqual(en.sections.map((s) => s.id));
    for (const doc of [en, ar]) {
      expect(doc.title.length).toBeGreaterThan(0);
      for (const section of doc.sections) expect(section.body.length).toBeGreaterThan(0);
    }
  });

  it('the Terms carry the "uploads" clause that every upload control links to', () => {
    for (const locale of ['en', 'ar']) {
      const uploads = legalDocument('terms', locale).sections.find((s) => s.id === 'uploads');
      expect(uploads).toBeDefined();
    }
    expect(JSON.stringify(legalDocument('terms', 'en'))).toContain('not scanned for malware');
  });

  it('every route exists as a public page', () => {
    for (const key of LEGAL_DOCUMENT_KEYS) {
      const page = join(ROOT, `apps/dashboard/src/app/[locale]/(legal)/${key}/page.tsx`);
      expect(existsSync(page), key).toBe(true);
      // No session is asked for: a legal page must open for anyone.
      expect(readFileSync(page, 'utf8')).not.toMatch(
        /requireWorkspace|getCustomer|requireCustomer/,
      );
    }
  });

  it('the version fits the configuration field sign-up records', () => {
    const payload = {
      ...(defaultPayload('onboarding') as Record<string, unknown>),
      legalDocuments: [
        {
          key: 'terms-of-service',
          title: { en: 'Terms of Service', ar: 'شروط الخدمة' },
          version: LEGAL_VERSION,
          url: { en: '/en/terms', ar: '/ar/terms' },
          required: true,
        },
      ],
    };
    const parsed = parseConfigPayload('onboarding', payload) as {
      legalDocuments: { version: string; reviewed: boolean }[];
    };
    expect(parsed.legalDocuments[0]?.version).toBe(LEGAL_VERSION);
    // Not reviewed until the owner says so.
    expect(parsed.legalDocuments[0]?.reviewed).toBe(false);
  });

  it('lists its placeholders, in both languages', () => {
    const placeholders = legalPlaceholders();
    expect(placeholders).toContain('[LEGAL ENTITY NAME]');
    expect(placeholders).toContain('[GOVERNING LAW]');
    expect(placeholders).toContain('[اسم الكيان القانوني]');
    expect(placeholders).toContain('[القانون الواجب التطبيق]');
  });
});
