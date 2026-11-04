import { describe, expect, it } from 'vitest';
import { defaultPayload } from '@brandspace/config';
import { brandBrainPolicyFrom } from '@brandspace/brand-brain';
import { productFactsLines } from '@brandspace/copilot';

/**
 * PR U — THE DEFAULT PRODUCT FACTS, PINNED.
 *
 * What the Copilot is told Brandspace reads when nothing narrower has been
 * activated: built from the `brand-brain` domain's own schema defaults
 * (`packages/config/src/domains.ts`), with no database. The isolation test
 * follows whatever its database has activated; this one fixes the default
 * text, so a change to the defaults or to the wording is seen here.
 */
describe('PR U · PRODUCT FACTS from the default brand-brain configuration', () => {
  const policy = brandBrainPolicyFrom(defaultPayload('brand-brain'));
  const text = productFactsLines({
    upload: policy.ingestion,
    extraction: policy.extraction,
  }).join('\n');

  it('lists exactly the six default types, in order', () => {
    expect(text).toContain(
      '- Brand Brain reads ONLY these file types: PDF (.pdf) with selectable text, Word (.docx), PowerPoint (.pptx), plain text (.txt), CSV (.csv), Markdown (.md). Every other type is not accepted.',
    );
  });

  it('says the default size limit as "up to 20 MB"', () => {
    expect(text).toContain(
      `- Each file may be up to 20 MB; at most the first ${policy.extraction.maxPages} pages are read; a brand may hold up to ${policy.ingestion.maxDocumentsPerBrand} files.`,
    );
  });

  it('never mentions Excel or spreadsheets', () => {
    expect(text).not.toMatch(/excel|\.xlsx?\b|spreadsheet/i);
  });
});
