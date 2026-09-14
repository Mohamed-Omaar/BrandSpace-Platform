import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  DocxExtractor,
  ExtractionFailedError,
  ExtractorRegistry,
  PdfExtractor,
  PlainTextExtractor,
  PptxExtractor,
  checkSignature,
  defaultExtractors,
  detectFormat,
  type ExtractionLimits,
} from '@brandspace/brand-brain';

/**
 * Document extraction, against files built here rather than fixtures.
 *
 * WHY BUILT RATHER THAN COMMITTED. A hostile file committed to the repository
 * is a hostile file in the repository: a zip bomb trips scanners, a
 * macro-bearing `.docx` trips antivirus on every clone, and both are harder to
 * reason about than the eight lines that produce them. Building them makes the
 * ATTACK legible — a reader can see that the bomb is one entry of a million
 * zeroes — and it keeps the repository clean.
 *
 * F-70 is what this closes: PDF, Word and PowerPoint were refused at upload
 * because nothing could read them, which is the honest behaviour for a feature
 * that does not exist and no substitute for the feature.
 */

const LIMITS: ExtractionLimits = {
  maxPages: 10,
  maxTextChars: 50_000,
  maxArchiveEntries: 64,
  maxArchiveBytes: 4 * 1024 * 1024,
  maxCompressionRatio: 200,
  timeoutMs: 20_000,
};

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// --- builders ---------------------------------------------------------------

function docx(
  paragraphs: readonly string[],
  extraEntries: Record<string, Uint8Array> = {},
): Uint8Array {
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
    ),
    ...extraEntries,
  });
}

function pptx(slides: readonly (readonly string[])[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
  };
  slides.forEach((runs, index) => {
    const body = runs.map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join('');
    entries[`ppt/slides/slide${index + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><p:sld xmlns:a="x" xmlns:p="y"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`,
    );
  });
  return zipSync(entries);
}

/**
 * A small, genuinely valid PDF with a text layer.
 *
 * Hand-built rather than produced by a writer library: the point is to feed
 * pdf.js a real document, and one small enough that a reader of this test can
 * see exactly what text is in it.
 */
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

// --- what a file actually is ------------------------------------------------

describe('the bytes decide the format, not the caller', () => {
  it('recognises each format from its own signature', () => {
    expect(detectFormat(pdf(['x']))).toBe('pdf');
    expect(detectFormat(docx(['x']))).toBe('ooxml');
    expect(detectFormat(strToU8('plain words'))).toBe('text');
    expect(detectFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'png',
    );
    expect(detectFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
  });

  it('reads Arabic text as text', () => {
    // The UTF-8 check is the only way a text file is recognised, so a
    // non-Latin document must not fall through to `unknown`.
    expect(detectFormat(strToU8('نبرة صوت العلامة بالعربية'))).toBe('text');
  });

  it('refuses a PDF that claims to be a Word document', () => {
    // The rename attack, which is what makes the declared type unusable for
    // choosing a parser.
    const check = checkSignature(DOCX_TYPE, pdf(['hidden']));
    expect(check.ok).toBe(false);
    expect(check.detected).toBe('pdf');
    expect(check.expected).toBe('ooxml');
  });

  it('refuses binary content that claims to be plain text', () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe]);
    expect(checkSignature('text/plain', binary).ok).toBe(false);
  });

  it('refuses an empty file', () => {
    // Nothing to check and nothing to extract. Accepting it would produce
    // "processed, 0 facts found", which teaches a customer the feature is
    // broken.
    expect(checkSignature('text/plain', new Uint8Array()).ok).toBe(false);
  });

  it('accepts each format under its own declared type', () => {
    expect(checkSignature('application/pdf', pdf(['x'])).ok).toBe(true);
    expect(checkSignature(DOCX_TYPE, docx(['x'])).ok).toBe(true);
    expect(checkSignature('text/markdown', strToU8('# Heading')).ok).toBe(true);
  });
});

// --- Word -------------------------------------------------------------------

describe('Word documents', () => {
  const extractor = new DocxExtractor(LIMITS);

  it('extracts the text, in document order', async () => {
    const result = await extractor.extract({
      bytes: docx(['Our mission is clarity.', 'We serve independent retailers.']),
      mimeType: DOCX_TYPE,
      fileName: 'brand.docx',
    });

    expect(result.text).toContain('Our mission is clarity.');
    expect(result.text).toContain('We serve independent retailers.');
    expect(result.text.indexOf('Our mission')).toBeLessThan(result.text.indexOf('We serve'));
    // No page concept in a `.docx`: pagination depends on the renderer, so
    // claiming a page would be inventing a citation nobody can check (D-65).
    expect(result.pageCount).toBeNull();
  });

  it('decodes XML entities rather than printing them', async () => {
    const result = await extractor.extract({
      bytes: docx(['Sales &amp; marketing &lt;strategy&gt;']),
      mimeType: DOCX_TYPE,
      fileName: 'brand.docx',
    });
    expect(result.text).toContain('Sales & marketing <strategy>');
  });

  it('is deterministic: the same bytes give the same text', async () => {
    const bytes = docx(['One.', 'Two.', 'Three.']);
    const first = await extractor.extract({ bytes, mimeType: DOCX_TYPE, fileName: 'a.docx' });
    const second = await extractor.extract({ bytes, mimeType: DOCX_TYPE, fileName: 'a.docx' });
    // D-65: a citation recorded today must point at the same text next year.
    expect(second.text).toBe(first.text);
    expect(second.boundaries).toEqual(first.boundaries);
  });

  it('refuses a document carrying macros', async () => {
    const bytes = docx(['Harmless looking text.'], {
      'word/vbaProject.bin': strToU8('macro payload'),
    });
    await expect(
      extractor.extract({ bytes, mimeType: DOCX_TYPE, fileName: 'macro.docm' }),
    ).rejects.toMatchObject({ reason: 'archive_unsafe_entry' });
  });

  it('refuses a document carrying an embedded executable', async () => {
    const bytes = docx(['Invoice attached.'], {
      'word/embeddings/oleObject1.bin': strToU8('MZ...'),
    });
    await expect(
      extractor.extract({ bytes, mimeType: DOCX_TYPE, fileName: 'invoice.docx' }),
    ).rejects.toMatchObject({ reason: 'archive_unsafe_entry' });
  });

  it('refuses an archive entry that escapes its own directory', async () => {
    const bytes = docx(['Text.'], { '../../etc/passwd': strToU8('root:x:0:0:') });
    await expect(
      extractor.extract({ bytes, mimeType: DOCX_TYPE, fileName: 'slip.docx' }),
    ).rejects.toMatchObject({ reason: 'archive_unsafe_entry' });
  });

  it('refuses a decompression bomb BEFORE inflating it', async () => {
    /*
     * One entry of two million zero bytes. Deflate reduces it to a couple of
     * kilobytes, so the ratio is in the hundreds — past the ceiling, and far
     * past anything a real Office document reaches (2:1 to 20:1). It stays
     * UNDER `maxArchiveBytes` on purpose, so the refusal can only have come
     * from the ratio guard rather than from the size guard beside it.
     *
     * The assertion that matters is not just that it is refused: it is that the
     * refusal happens from the archive DIRECTORY, before the entry is inflated.
     * A guard that ran after inflating would already have allocated the memory
     * the attack is trying to make it allocate.
     */
    const bomb = zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
      'word/document.xml': new Uint8Array(2 * 1024 * 1024),
    });
    expect(bomb.byteLength).toBeLessThan(100 * 1024);
    expect(2 * 1024 * 1024).toBeLessThan(LIMITS.maxArchiveBytes);

    await expect(
      extractor.extract({ bytes: bomb, mimeType: DOCX_TYPE, fileName: 'bomb.docx' }),
    ).rejects.toMatchObject({ reason: 'archive_compression_ratio' });
  });

  it('refuses an entry larger than the configured ceiling', async () => {
    // The size guard, separately from the ratio guard: incompressible bytes
    // have a ratio of about 1 and would sail past it.
    const random = new Uint8Array(300 * 1024);
    for (let index = 0; index < random.length; index += 1) random[index] = (index * 37) % 251;
    const small = new DocxExtractor({ ...LIMITS, maxArchiveBytes: 128 * 1024 });

    await expect(
      small.extract({
        bytes: docx(['Text.'], { 'word/media/blob.bin': random }),
        mimeType: DOCX_TYPE,
        fileName: 'big.docx',
      }),
    ).rejects.toMatchObject({ reason: 'archive_entry_too_large' });
  });

  it('refuses a truncated or corrupt archive without leaking the parser', async () => {
    const truncated = docx(['Text.']).slice(0, 40);
    const error = await extractor
      .extract({ bytes: truncated, mimeType: DOCX_TYPE, fileName: 'corrupt.docx' })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(ExtractionFailedError);
    // The message is the REASON KEY and nothing else. A parser's own message
    // names offsets and internal state, and an Error's message is the value
    // most likely to be logged or rendered.
    expect((error as ExtractionFailedError).message).toMatch(/^[a-z_]+$/);
  });

  it('refuses a document with no text rather than returning an empty one', async () => {
    await expect(
      extractor.extract({ bytes: docx([]), mimeType: DOCX_TYPE, fileName: 'empty.docx' }),
    ).rejects.toMatchObject({ reason: 'no_text_found' });
  });

  it('does not expand a custom XML entity', async () => {
    /*
     * A billion-laughs payload. It is inert here for a structural reason rather
     * than a defensive one: there is no XML parser, so no DTD is read and no
     * custom entity is ever defined. The `&lol;` reference is simply text the
     * scanner does not recognise and leaves alone.
     */
    const bytes = zipSync({
      'word/document.xml': strToU8(
        `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY lol "ha"><!ENTITY lol2 "&lol;&lol;&lol;">]>` +
          `<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>&lol2;</w:t></w:r></w:p></w:body></w:document>`,
      ),
    });
    const result = await extractor.extract({
      bytes,
      mimeType: DOCX_TYPE,
      fileName: 'xxe.docx',
    });
    expect(result.text).toBe('&lol2;');
  });
});

// --- PowerPoint -------------------------------------------------------------

describe('PowerPoint documents', () => {
  const extractor = new PptxExtractor(LIMITS);

  it('extracts each slide and cites it by number', async () => {
    const result = await extractor.extract({
      bytes: pptx([['Who we are'], ['What we sell'], ['Proof points']]),
      mimeType: PPTX_TYPE,
      fileName: 'deck.pptx',
    });

    expect(result.pageCount).toBe(3);
    expect(result.text).toContain('Who we are');
    expect(result.boundaries.map((b) => b.label)).toEqual(['slide 1', 'slide 2', 'slide 3']);
  });

  it('orders slides numerically, not lexicographically', async () => {
    // `slide10` must follow `slide9`. Sorting by name puts it after `slide1`,
    // which silently reorders the deck and makes every locator past slide 9
    // point at the wrong slide.
    const slides = Array.from({ length: 11 }, (_unused, index) => [`Slide body ${index + 1}`]);
    const result = await extractor.extract({
      bytes: pptx(slides),
      mimeType: PPTX_TYPE,
      fileName: 'long.pptx',
    });

    expect(result.text.indexOf('Slide body 9')).toBeLessThan(result.text.indexOf('Slide body 10'));
    expect(result.boundaries.at(-1)?.label).toBe('slide 11');
  });
});

// --- PDF --------------------------------------------------------------------

describe('PDF documents', () => {
  const extractor = new PdfExtractor(LIMITS);

  it('extracts the text layer and cites it by page', async () => {
    const result = await extractor.extract({
      bytes: pdf(['Our positioning is clarity', 'We serve independent retailers']),
      mimeType: 'application/pdf',
      fileName: 'brand.pdf',
    });

    expect(result.text).toContain('Our positioning is clarity');
    expect(result.pageCount).toBe(1);
    expect(result.boundaries[0]?.label).toBe('page 1');
  });

  it('is deterministic', async () => {
    const bytes = pdf(['Stable text for a stable citation']);
    const first = await extractor.extract({
      bytes,
      mimeType: 'application/pdf',
      fileName: 'a.pdf',
    });
    const second = await extractor.extract({
      bytes,
      mimeType: 'application/pdf',
      fileName: 'a.pdf',
    });
    expect(second.text).toBe(first.text);
  });

  it('does not consume the caller’s buffer', async () => {
    /*
     * pdf.js takes ownership of the array it is handed and detaches it. Handing
     * it the ingestion service's own bytes would leave that service holding an
     * empty array — which surfaces much later as a checksum that no longer
     * matches the file it was computed from.
     */
    const bytes = pdf(['Text']);
    const before = bytes.byteLength;
    await extractor.extract({ bytes, mimeType: 'application/pdf', fileName: 'a.pdf' });
    expect(bytes.byteLength).toBe(before);
  });

  it('refuses a damaged PDF with a customer-safe reason', async () => {
    const damaged = new Uint8Array(Buffer.from('%PDF-1.4\nnot really a pdf at all', 'latin1'));
    await expect(
      extractor.extract({ bytes: damaged, mimeType: 'application/pdf', fileName: 'bad.pdf' }),
    ).rejects.toMatchObject({ reason: expect.stringMatching(/^pdf_/) as unknown as string });
  });

  it('says so when a PDF is a scan with no text layer', async () => {
    // An empty page, which is what a scan looks like to a text extractor.
    const scan = new Uint8Array(
      Buffer.from(
        `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
`,
        'latin1',
      ),
    );
    await expect(
      extractor.extract({ bytes: scan, mimeType: 'application/pdf', fileName: 'scan.pdf' }),
    ).rejects.toMatchObject({ reason: 'pdf_has_no_text_layer' });
  });
});

// --- limits and the registry ------------------------------------------------

describe('the configured limits actually bound the work', () => {
  it('a text file is truncated at the character ceiling', async () => {
    const tiny: ExtractionLimits = { ...LIMITS, maxTextChars: 100 };
    const result = await new PlainTextExtractor(tiny).extract({
      bytes: strToU8('word '.repeat(5_000)),
      mimeType: 'text/plain',
      fileName: 'long.txt',
    });
    expect(result.text.length).toBe(100);
  });

  it('a PDF is not read past the page ceiling', async () => {
    // The ceiling is what stops "the document declares fifty thousand pages"
    // from being a reason to read fifty thousand pages.
    const onePage = new PdfExtractor({ ...LIMITS, maxPages: 1 });
    const result = await onePage.extract({
      bytes: pdf(['Page one text']),
      mimeType: 'application/pdf',
      fileName: 'a.pdf',
    });
    expect(result.pageCount).toBe(1);
  });

  it('an archive is refused past the entry ceiling', async () => {
    const many: Record<string, Uint8Array> = {};
    for (let index = 0; index < 40; index += 1) {
      many[`word/media/image${index}.png`] = strToU8('x');
    }
    const extractor = new DocxExtractor({ ...LIMITS, maxArchiveEntries: 5 });
    await expect(
      extractor.extract({
        bytes: docx(['Text.'], many),
        mimeType: DOCX_TYPE,
        fileName: 'many.docx',
      }),
    ).rejects.toMatchObject({ reason: 'archive_too_many_entries' });
  });
});

describe('the default registry covers exactly the supported formats', () => {
  it('claims text, Word, PowerPoint and PDF', async () => {
    const registry = new ExtractorRegistry(await defaultExtractors(LIMITS));
    for (const type of ['text/plain', 'text/markdown', 'text/csv', DOCX_TYPE, PPTX_TYPE]) {
      expect(registry.supports(type), `${type} has no extractor`).toBe(true);
    }
    expect(registry.supports('application/pdf')).toBe(true);
  });

  it('claims no image type, which is D-93 rather than an oversight', async () => {
    // Reading a PNG needs OCR, and no OCR option meets this feature's bar —
    // see the `allowedMimeTypes` comment in the configuration schema. An
    // operator who adds one to the allow-list gets an honest refusal at upload
    // rather than a document stuck in FAILED.
    const registry = new ExtractorRegistry(await defaultExtractors(LIMITS));
    expect(registry.supports('image/png')).toBe(false);
    expect(registry.supports('image/jpeg')).toBe(false);
  });
});
