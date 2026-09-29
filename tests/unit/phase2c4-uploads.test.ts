import { readFileSync } from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { defaultPayload } from '@brandspace/config';
import {
  ExtractionFailedError,
  ExtractorRegistry,
  PptxExtractor,
  brandBrainPolicyFrom,
  checkSignature,
  declaredOoxmlKind,
  extractorRegistryFor,
  strictUtf8,
  type ExtractionLimits,
  type TextExtractor,
} from '@brandspace/brand-brain';
import { optionalMessage } from '../../apps/dashboard/src/i18n/messages';
import { contentTypesFor, docxPackage, pptxPackage } from '../support/ooxml';

/**
 * PHASE 2C-4 (Item 5, D5) — WHAT AN UPLOAD IS, DECIDED BY ITS BYTES.
 *
 * The door's checks without a database: the six accepted formats, the refused
 * legacy and look-alike formats, the OOXML main-part declaration, the strict
 * UTF-8 rule for text, the exact binary 20 MiB default, the whole-document
 * timeout, the PPTX slide ceiling, and a translation in both languages for
 * every reason a source can fail with.
 */

const LIMITS: ExtractionLimits = {
  maxPages: 5,
  maxTextChars: 50_000,
  maxArchiveEntries: 64,
  maxArchiveBytes: 4 * 1024 * 1024,
  maxCompressionRatio: 200,
  timeoutMs: 5_000,
};

const TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
} as const;

const PDF = new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n', 'latin1'));
/** An OLE2 compound file header — what a legacy `.doc` or `.ppt` starts with. */
const OLE2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

/** The door, as the ingestion service runs it: allow-list, signature, then the reader's own check. */
async function refusal(mimeType: string, bytes: Uint8Array): Promise<string | null> {
  const policy = brandBrainPolicyFrom(defaultPayload('brand-brain'));
  const registry = await extractorRegistryFor(LIMITS);
  if (!policy.ingestion.allowedMimeTypes.includes(mimeType) || !registry.supports(mimeType)) {
    return 'unsupported_format';
  }
  if (bytes.byteLength > policy.ingestion.maxFileBytes) return 'file_too_large';
  if (!checkSignature(mimeType, bytes).ok) return 'content_does_not_match_type';
  try {
    registry.validate({ bytes, mimeType });
  } catch (error: unknown) {
    if (error instanceof ExtractionFailedError) return error.reason;
    throw error;
  }
  return null;
}

describe('the six accepted formats pass on their own bytes', () => {
  it.each([
    ['PDF', TYPES.pdf, PDF],
    ['DOCX', TYPES.docx, docxPackage(['Our audience is founders.'])],
    ['PPTX', TYPES.pptx, pptxPackage([['Who we are']])],
    ['text/plain', TYPES.txt, strToU8('Our audience is founders.')],
    ['text/csv', TYPES.csv, strToU8('area,fact\naudience,founders\n')],
    ['text/markdown', TYPES.md, strToU8('# Brand\n\nOur audience is founders.')],
  ])('%s', async (_label, mimeType, bytes) => {
    expect(await refusal(mimeType, bytes)).toBeNull();
  });

  it('the configured allow-list is exactly those six', () => {
    expect(defaultPayload('brand-brain').upload.allowedMimeTypes).toEqual([
      TYPES.pdf,
      TYPES.docx,
      TYPES.pptx,
      TYPES.txt,
      TYPES.csv,
      TYPES.md,
    ]);
  });
});

describe('refused formats, and files that pretend', () => {
  it('refuses legacy binary Word and PowerPoint (.doc, .ppt)', async () => {
    expect(await refusal('application/msword', OLE2)).toBe('unsupported_format');
    expect(await refusal('application/vnd.ms-powerpoint', OLE2)).toBe('unsupported_format');
    // Even when a legacy file is declared as its modern cousin, the bytes refuse it.
    expect(await refusal(TYPES.docx, OLE2)).toBe('content_does_not_match_type');
  });

  it('refuses an XLSX, a generic ZIP, and a Word/PowerPoint swap', async () => {
    const xlsx = zipSync({
      '[Content_Types].xml': contentTypesFor('xlsx'),
      'xl/workbook.xml': strToU8('<workbook/>'),
    });
    const genericZip = zipSync({ 'notes.txt': strToU8('just a zip') });
    expect(await refusal(TYPES.docx, xlsx)).toBe('ooxml_type_mismatch');
    expect(await refusal(TYPES.pptx, xlsx)).toBe('ooxml_type_mismatch');
    expect(await refusal(TYPES.docx, genericZip)).toBe('ooxml_content_types_missing');
    expect(await refusal(TYPES.docx, pptxPackage([['A slide']]))).toBe('ooxml_type_mismatch');
    expect(await refusal(TYPES.pptx, docxPackage(['A paragraph']))).toBe('ooxml_type_mismatch');
  });

  it('refuses a package with no main-part declaration, and a malformed one', async () => {
    const undeclared = zipSync({
      '[Content_Types].xml': contentTypesFor('none'),
      'word/document.xml': strToU8('<w:document/>'),
    });
    expect(await refusal(TYPES.docx, undeclared)).toBe('ooxml_main_part_missing');
    const truncated = docxPackage(['Our audience is founders.']).slice(0, 40);
    expect(await refusal(TYPES.docx, truncated)).toBe('archive_unreadable');
  });

  it('refuses a spoofed extension and a bad signature', async () => {
    // A PDF named `.docx`, and text named `.pdf`.
    expect(await refusal(TYPES.docx, PDF)).toBe('content_does_not_match_type');
    expect(await refusal(TYPES.pdf, strToU8('not a pdf at all'))).toBe(
      'content_does_not_match_type',
    );
    // A PDF declared as text: its signature says PDF, whatever it decodes as.
    expect(await refusal(TYPES.txt, PDF)).toBe('content_does_not_match_type');
    // Bytes the lenient sample takes for text, the strict decode does not.
    expect(await refusal(TYPES.txt, new Uint8Array([0x25, 0x50, 0xff, 0xfe]))).toBe(
      'text_not_utf8',
    );
  });

  it('refuses a macro payload at the door, from the archive directory', async () => {
    const macro = docxPackage(['Harmless.'], { 'word/vbaProject.bin': strToU8('x') });
    expect(await refusal(TYPES.docx, macro)).toBe('archive_unsafe_entry');
  });

  it('declaredOoxmlKind reads only the content-types part', () => {
    expect(declaredOoxmlKind(docxPackage(['x']), LIMITS)).toBe('docx');
    expect(declaredOoxmlKind(pptxPackage([['x']]), LIMITS)).toBe('pptx');
  });
});

describe('text is UTF-8, strictly, over the WHOLE file', () => {
  it('accepts valid UTF-8, Arabic included', () => {
    expect(strictUtf8(strToU8('نبرة صوت العلامة'))).toBe('نبرة صوت العلامة');
  });

  it('strips an optional UTF-8 BOM', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8('Our audience')]);
    expect(strictUtf8(withBom)).toBe('Our audience');
  });

  it('refuses invalid UTF-8 anywhere, even past the signature sample', async () => {
    const tail = new Uint8Array(70 * 1024).fill(0x61);
    tail[tail.length - 1] = 0xff;
    expect(() => strictUtf8(tail)).toThrow(ExtractionFailedError);
    expect(await refusal(TYPES.txt, tail)).toBe('text_not_utf8');
  });

  it('refuses a NUL byte anywhere', async () => {
    const late = new Uint8Array(70 * 1024).fill(0x61);
    late[late.length - 10] = 0;
    expect(await refusal(TYPES.txt, late)).toBe('text_contains_nul');
    expect(() => strictUtf8(strToU8('a\u0000b'))).toThrow(/text_contains_nul/);
  });
});

describe('limits', () => {
  it('the upload ceiling is EXACTLY 20 MiB, binary', () => {
    const { maxFileBytes } = defaultPayload('brand-brain').upload;
    expect(maxFileBytes).toBe(20 * 1024 * 1024);
    expect(maxFileBytes).toBe(20_971_520);
    expect(maxFileBytes).not.toBe(20_000_000);
  });

  it('accepts a file of exactly 20 MiB and refuses one byte more', async () => {
    const exact = new Uint8Array(20 * 1024 * 1024).fill(0x61);
    const over = new Uint8Array(20 * 1024 * 1024 + 1).fill(0x61);
    expect(await refusal(TYPES.txt, exact)).toBeNull();
    expect(await refusal(TYPES.txt, over)).toBe('file_too_large');
  });

  it('the dashboard transport ceiling sits above the rule', () => {
    const config = readFileSync(
      path.join(__dirname, '../../apps/dashboard/next.config.mjs'),
      'utf8',
    );
    expect(config).toMatch(/bodySizeLimit: '24mb'/);
    expect(config).toMatch(/proxyClientMaxBodySize: '24mb'/);
    expect(24 * 1024 * 1024).toBeGreaterThan(20 * 1024 * 1024);
  });

  it('extraction.maxPages bounds PPTX slides as it bounds PDF pages', async () => {
    const deck = pptxPackage(Array.from({ length: 9 }, (_x, i) => [`Slide body ${i + 1}`]));
    const result = await new PptxExtractor(LIMITS).extract({
      bytes: deck,
      mimeType: TYPES.pptx,
      fileName: 'deck.pptx',
    });
    expect(result.pageCount).toBe(LIMITS.maxPages);
    expect(result.text).toContain('Slide body 5');
    expect(result.text).not.toContain('Slide body 6');
  });

  it('the archive entry, size and ratio caps apply at the door', async () => {
    const many: Record<string, Uint8Array> = { '[Content_Types].xml': contentTypesFor('docx') };
    for (let i = 0; i < LIMITS.maxArchiveEntries + 1; i += 1) many[`f${i}.xml`] = strToU8('x');
    expect(await refusal(TYPES.docx, zipSync(many))).toBe('archive_too_many_entries');

    const bomb = zipSync({
      '[Content_Types].xml': contentTypesFor('docx'),
      'word/document.xml': new Uint8Array(2 * 1024 * 1024),
    });
    expect(await refusal(TYPES.docx, bomb)).toBe('archive_compression_ratio');

    const big = new Uint8Array(LIMITS.maxArchiveBytes + 1);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 2654435761) >>> 24;
    const large = zipSync({ '[Content_Types].xml': contentTypesFor('docx'), 'word/x.bin': big });
    expect(await refusal(TYPES.docx, large)).toBe('archive_entry_too_large');
  });

  it('the max text characters cap is applied to text sources', async () => {
    const registry = await extractorRegistryFor({ ...LIMITS, maxTextChars: 1_000 });
    const long = strToU8(`${'Our audience is founders. '.repeat(200)}`);
    const result = await registry.extract({ bytes: long, mimeType: TYPES.txt, fileName: 'a.txt' });
    expect(result.text.length).toBeLessThanOrEqual(1_000);
  });

  it('extraction.timeoutMs bounds the WHOLE extraction, for any format', async () => {
    const slow: TextExtractor = {
      supports: (type) => type === TYPES.txt,
      extract: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ text: 'late', pageCount: null, boundaries: [] }), 500),
        ),
    };
    const registry = new ExtractorRegistry([slow], { timeoutMs: 50 });
    await expect(
      registry.extract({ bytes: strToU8('x'), mimeType: TYPES.txt, fileName: 'a.txt' }),
    ).rejects.toMatchObject({ reason: 'extraction_timed_out' });
  });

  it('a synchronous extraction that overruns the deadline is refused too', async () => {
    const busy: TextExtractor = {
      supports: (type) => type === TYPES.txt,
      extract: async () => {
        const until = Date.now() + 80;
        while (Date.now() < until) {
          // A parse that cannot be pre-empted.
        }
        return { text: 'late', pageCount: null, boundaries: [] };
      },
    };
    const registry = new ExtractorRegistry([busy], { timeoutMs: 20 });
    await expect(
      registry.extract({ bytes: strToU8('x'), mimeType: TYPES.txt, fileName: 'a.txt' }),
    ).rejects.toMatchObject({ reason: 'extraction_timed_out' });
  });
});

describe('every failure reason reads in both languages, and nothing leaks', () => {
  const REASONS = [
    'unsupported_format',
    'file_too_large',
    'content_does_not_match_type',
    'ooxml_content_types_missing',
    'ooxml_main_part_missing',
    'ooxml_type_mismatch',
    'text_not_utf8',
    'text_contains_nul',
    'archive_unreadable',
    'archive_unsafe_entry',
    'archive_too_many_entries',
    'archive_entry_too_large',
    'archive_too_large',
    'archive_compression_ratio',
    'document_part_missing',
    'no_text_found',
    'pdf_unreadable',
    'pdf_has_no_text_layer',
    'extraction_timed_out',
    'extraction_failed',
    'object_missing',
    'stuck_timeout',
  ];

  it.each(REASONS)('%s has en and ar copy, and they differ', (reason) => {
    const en = optionalMessage('en', `bb.failure.${reason}`);
    const ar = optionalMessage('ar', `bb.failure.${reason}`);
    expect(en).toBeTruthy();
    expect(ar).toBeTruthy();
    expect(ar).not.toBe(en);
    expect(en).not.toMatch(/Error|stack|\/|_/);
  });

  it('an ExtractionFailedError carries its key as its message, never a library’s words', () => {
    const error = new ExtractionFailedError('archive_unreadable', new Error('offset 0x3f7 bad'));
    expect(error.message).toBe('archive_unreadable');
    expect(error.message).not.toContain('0x3f7');
  });

  it('the status codes a refused or repeated upload lands on read in both languages', () => {
    for (const code of ['SOURCE_REFUSED', 'SOURCE_ALREADY_FAILED', 'SOURCE_READ_AGAIN']) {
      const file = readFileSync(
        path.join(__dirname, '../../apps/dashboard/src/i18n/messages.ts'),
        'utf8',
      );
      expect(file).toContain(`${code}: {`);
    }
  });
});
