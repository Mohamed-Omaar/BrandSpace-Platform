import { afterEach, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  ExtractionFailedError,
  InMemoryObjectStore,
  PdfExtractor,
  extractSourceDocument,
  extractorRegistryFor,
  failureLogFields,
  type ExtractionLimits,
  type StartedIngestion,
} from '@brandspace/brand-brain';
import { contentTypesFor } from '../support/ooxml';

/**
 * PR U — WHY A FILE COULD NOT BE READ, AND WHOSE FAULT IT WAS.
 *
 * Staging: every PDF failed three times with `extraction_failed`, before any
 * AI call. The worker ran Node 20.20.2; pdf.js 6 calls
 * `Promise.withResolvers`, which Node 20 does not have, so `getDocument`
 * threw a TypeError OUTSIDE the extractor's classification and the general
 * reason swallowed it. Word and text files were read.
 *
 * These tests run that failure on any Node by removing the built-in, and
 * check the operator log's fields are the same for PDF, Word and text.
 */

const LIMITS: ExtractionLimits = {
  maxPages: 10,
  maxTextChars: 50_000,
  maxArchiveEntries: 64,
  maxArchiveBytes: 4 * 1024 * 1024,
  maxCompressionRatio: 200,
  timeoutMs: 20_000,
};

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TXT = 'text/plain';

function pdf(lines: readonly string[]): Uint8Array {
  const content = lines
    .map((line, index) => `BT /F1 12 Tf 20 ${180 - index * 20} Td (${line}) Tj ET`)
    .join('\n');
  const source = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${content.length}>>stream
${content}
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
`;
  return new Uint8Array(Buffer.from(source, 'latin1'));
}

function docx(paragraphs: readonly string[]): Uint8Array {
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  return zipSync({
    '[Content_Types].xml': contentTypesFor('docx'),
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
    ),
  });
}

/**
 * Node 20, on any Node: the built-in pdf.js 6 needs, removed for one call.
 * Reached through a structural view because the tests compile against
 * ES2022, whose `PromiseConstructor` does not declare it (ES2024 does).
 */
const promiseConstructor = Promise as unknown as { withResolvers?: unknown };
const original = promiseConstructor.withResolvers;
function withoutWithResolvers(): void {
  delete promiseConstructor.withResolvers;
}
afterEach(() => {
  promiseConstructor.withResolvers = original;
});

function started(mimeType: string, fileName: string): StartedIngestion {
  return {
    jobId: 'job',
    documentId: 'doc',
    brandId: 'brand',
    storageKey: `key/${fileName}`,
    mimeType,
    fileName,
    targetArea: null,
    attempt: 1,
    maxAttempts: 3,
    removed: false,
    claimed: true,
  };
}

async function run(mimeType: string, fileName: string, bytes: Uint8Array) {
  const store = new InMemoryObjectStore();
  const claim = started(mimeType, fileName);
  await store.put(claim.storageKey, bytes, mimeType);
  return extractSourceDocument({
    store,
    extractors: await extractorRegistryFor(LIMITS),
    started: claim,
  });
}

describe('PR U · the PDF reader on a runtime without Promise.withResolvers', () => {
  it('is reader_unavailable (ours, retryable), not a general failure or a damaged file', async () => {
    withoutWithResolvers();
    const error = await new PdfExtractor(LIMITS)
      .extract({ bytes: pdf(['Our tone is calm']), mimeType: PDF, fileName: 'a.pdf' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExtractionFailedError);
    expect((error as ExtractionFailedError).reason).toBe('reader_unavailable');
    expect((error as ExtractionFailedError).cause).toBeInstanceOf(TypeError);
  });

  it('the worker path stores reader_unavailable and logs the class, type and size', async () => {
    withoutWithResolvers();
    const bytes = pdf(['VETS VAN brings the vet to your door']);
    const outcome = await run(PDF, 'VETS-VAN-Brand-Guidelines.pdf', bytes);
    expect(outcome).toEqual({
      ok: false,
      reason: 'reader_unavailable',
      terminal: false,
      diagnostic: {
        stage: 'parse',
        errorClass: 'ExtractionFailedError',
        causeClass: 'TypeError',
        errorCode: 'reader_unavailable',
        mimeType: PDF,
        sizeBytes: bytes.byteLength,
      },
    });
  });

  it('the same PDF reads on the pinned runtime', async () => {
    const outcome = await run(PDF, 'a.pdf', pdf(['VETS VAN brings the vet to your door']));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.extracted.text).toContain('VETS VAN');
  });
});

describe('PR U · the failure log has the same fields for PDF, Word and text', () => {
  const SECRET_NAME = 'Customer Confidential Plan.pdf';
  const CONTENT = 'Confidential launch price 999';

  it('names stage, class, code, type and size — never the file name, message or content', async () => {
    withoutWithResolvers();
    const cases = [
      await run(PDF, SECRET_NAME, pdf([CONTENT])),
      // Not a zip at all: the Word reader refuses it as damaged.
      await run(DOCX, SECRET_NAME, strToU8(`PK${CONTENT}`)),
      // Not UTF-8: the text reader refuses it.
      await run(TXT, SECRET_NAME, new Uint8Array([0x41, 0xc3, 0x28, 0x42])),
    ];
    const keys = cases.map((outcome) => {
      expect(outcome.ok).toBe(false);
      const fields = failureLogFields(outcome.ok ? undefined : outcome.diagnostic);
      const text = JSON.stringify(fields);
      expect(text).not.toContain('Confidential');
      expect(text).not.toContain('withResolvers');
      return Object.keys(fields).sort();
    });
    const expected = [
      'causeClass',
      'errorClass',
      'errorCode',
      'failureStage',
      'mimeType',
      'sizeBytes',
    ].sort();
    expect(keys[0]).toEqual(expected);
    // Word and text failures have no wrapped cause; every other field is there.
    for (const fieldKeys of keys.slice(1)) {
      expect(fieldKeys).toEqual(expected.filter((key) => fieldKeys.includes(key)));
      expect(fieldKeys).toEqual(
        expect.arrayContaining([
          'errorClass',
          'errorCode',
          'failureStage',
          'mimeType',
          'sizeBytes',
        ]),
      );
    }
    expect(cases.map((outcome) => (outcome.ok ? null : outcome.reason))).toEqual([
      'reader_unavailable',
      'archive_unreadable',
      'text_not_utf8',
    ]);
  });

  it('a Word and a text file that read well log nothing', async () => {
    const word = await run(DOCX, 'a.docx', docx(['VETS VAN brings the vet to your door.']));
    const text = await run(TXT, 'a.txt', strToU8('Our tone is warm and calm.'));
    expect(word.ok && text.ok).toBe(true);
    expect(failureLogFields(undefined)).toEqual({});
  });

  it('a storage read failure is stage "read", with no size (nothing was read)', async () => {
    const store = new InMemoryObjectStore();
    store.get = async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    };
    const outcome = await extractSourceDocument({
      store,
      extractors: await extractorRegistryFor(LIMITS),
      started: started(TXT, 'a.txt'),
    });
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'extraction_failed',
      terminal: false,
      diagnostic: { stage: 'read', errorClass: 'Error', errorCode: 'ECONNRESET', sizeBytes: null },
    });
  });
});
