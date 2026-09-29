import { unzipSync, type UnzipFileInfo } from 'fflate';
import type { ExtractedText, ExtractionInput, TextExtractor } from './extraction';
import { ExtractionFailedError, type ExtractionLimits } from './extraction';

/**
 * Word and PowerPoint, read WITHOUT a document parser.
 *
 * WHY NOT A LIBRARY. A `.docx` is a ZIP of XML, and the text lives in one part
 * of it under one element name. A document-conversion library brings a very
 * large amount of code — styles, numbering, images, HTML generation — all of it
 * running on bytes a customer uploaded, to produce prose we then throw the
 * formatting away from. The parser IS the attack surface here, and the smallest
 * one that does the job is a bounded ZIP read plus a scan for one element.
 * `fflate` (MIT, no dependencies) does the inflating; everything else is below.
 *
 * WHAT IS REFUSED, AND WHY EACH ONE.
 *
 *   - MACROS. `vbaProject.bin` is refused outright. We never execute it and
 *     could not, but a macro-bearing document is one a customer should not be
 *     circulating through a knowledge base, and silently ingesting its text
 *     normalises it.
 *   - EMBEDDED OBJECTS. `word/embeddings/`, `ppt/embeddings/` and any entry
 *     that is a Windows executable by extension. These are OLE payloads — a
 *     packaged `.exe` inside a `.docx` is a real and common delivery technique.
 *   - PATH ESCAPES. An entry named `../` or with an absolute path. Nothing here
 *     writes to disk, so this cannot escape anything today; it is refused
 *     because a legitimate Office file never contains one, which makes it a
 *     reliable signal that the archive was built to attack something.
 *   - DECOMPRESSION BOMBS. Enforced BEFORE inflating, per entry and in total,
 *     by size and by ratio. A filter that ran after inflating would be a
 *     comment rather than a control.
 *
 * WHAT IS NEVER FOLLOWED. Relationships. `document.xml.rels` can name external
 * targets — a `TargetMode="External"` hyperlink, a linked image, a remote
 * template — and following one would turn every upload into a server-side
 * request forgery with the customer choosing the URL. This reader resolves no
 * relationship of any kind: it opens the parts it names below and nothing else,
 * so there is no code path that could make a request.
 *
 * XXE IS STRUCTURALLY IMPOSSIBLE HERE. There is no XML parser: no DTD is read,
 * no entity is defined, and the only entities decoded are the five predefined
 * ones plus bounded numeric references. A billion-laughs payload is inert
 * because nothing expands a custom entity.
 */

/** Refused outright, wherever they appear in the archive. */
const FORBIDDEN_ENTRY_PATTERNS: readonly RegExp[] = [
  /(^|\/)vbaProject\.bin$/i,
  /(^|\/)(word|ppt|xl)\/embeddings\//i,
  /\.(exe|dll|scr|com|bat|cmd|jar|msi|vbs|js|ps1)$/i,
];

function entryIsSafe(name: string): boolean {
  if (name.startsWith('/') || name.includes('..')) return false;
  // A Windows drive-absolute path, which a ZIP should never contain.
  if (/^[A-Za-z]:/.test(name)) return false;
  return !FORBIDDEN_ENTRY_PATTERNS.some((pattern) => pattern.test(name));
}

const DOCX_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;
const PPTX_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const;

/**
 * PHASE 2C-4 — WHAT THE PACKAGE SAYS ITS MAIN PART IS.
 *
 * ZIP MAGIC IS NOT A FORMAT. `PK\x03\x04` opens a Word file, a PowerPoint
 * file, a spreadsheet, a JAR and every other ZIP, so the signature check alone
 * would let an `.xlsx` or a generic archive renamed `.docx` reach the reader.
 * An OOXML package declares its main part in `[Content_Types].xml` (ECMA-376
 * Part 2, the Open Packaging Conventions); that declaration is what makes a
 * package a Word document or a presentation, and it must agree with the type
 * the upload was declared as.
 *
 * Reading it inflates exactly ONE small part. Every central-directory entry is
 * still walked through `readParts`' filter, so the entry-count, path, size and
 * compression-ratio guards all run first; nothing else is inflated.
 */
const MAIN_PART_TYPE = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
} as const;

export type OoxmlKind = keyof typeof MAIN_PART_TYPE;

const CONTENT_TYPES_PART = '[Content_Types].xml';

/** The package kind `[Content_Types].xml` declares, or the reason it declares none. */
function kindFromContentTypes(part: ArchivePart | undefined): OoxmlKind {
  if (!part) throw new ExtractionFailedError('ooxml_content_types_missing');
  const declared = new Set(
    [...part.xml.matchAll(/\bContentType\s*=\s*(["'])([^"']*)\1/g)].map((match) =>
      decodeXmlText(match[2] ?? '')
        .trim()
        .toLowerCase(),
    ),
  );
  const docx = declared.has(MAIN_PART_TYPE.docx);
  const pptx = declared.has(MAIN_PART_TYPE.pptx);
  if (docx && pptx) throw new ExtractionFailedError('ooxml_type_mismatch');
  if (docx) return 'docx';
  if (pptx) return 'pptx';
  // Another OOXML main part — a spreadsheet, a macro-enabled or template
  // variant — is a DIFFERENT format; no main part at all is a malformed one.
  const otherMain = [...declared].some((type) => type.endsWith('.main+xml'));
  throw new ExtractionFailedError(otherMain ? 'ooxml_type_mismatch' : 'ooxml_main_part_missing');
}

/**
 * The OOXML kind a package declares — the bounded upload check (Phase 2C-4).
 * Throws `ExtractionFailedError` for a hostile, malformed or undeclared package.
 */
export function declaredOoxmlKind(bytes: Uint8Array, limits: ExtractionLimits): OoxmlKind {
  const parts = readParts(bytes, (name) => name === CONTENT_TYPES_PART, limits);
  return kindFromContentTypes(parts.find((part) => part.name === CONTENT_TYPES_PART));
}

function requireKind(bytes: Uint8Array, limits: ExtractionLimits, wanted: OoxmlKind): void {
  if (declaredOoxmlKind(bytes, limits) !== wanted) {
    throw new ExtractionFailedError('ooxml_type_mismatch');
  }
}

/**
 * Decode the five predefined XML entities and bounded numeric references.
 *
 * Numeric references are capped at the Unicode range and anything outside it is
 * left as written rather than guessed at, so a malformed reference cannot turn
 * into a control character.
 */
function decodeXmlText(raw: string): string {
  return raw.replace(/&(#x?[0-9A-Fa-f]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const hex = entity.startsWith('#x') || entity.startsWith('#X');
        const digits = entity.slice(hex ? 2 : 1);
        const code = Number.parseInt(digits, hex ? 16 : 10);
        if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return match;
        return String.fromCodePoint(code);
      }
    }
  });
}

/**
 * Every occurrence of one element's text content, in document order.
 *
 * A scan rather than a parse, and deliberately so — see the header. It matches
 * the element with or without a namespace prefix and ignores its attributes,
 * which is all OOXML needs: the text of a Word run is always in `w:t`, and the
 * text of a PowerPoint run is always in `a:t`.
 */
function textOfElements(xml: string, localName: string, paragraphEnd: string): string {
  const pattern = new RegExp(
    `<(?:[A-Za-z0-9._-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9._-]+:)?${localName}>` +
      `|</(?:[A-Za-z0-9._-]+:)?${paragraphEnd}>`,
    'g',
  );

  const out: string[] = [];
  for (const match of xml.matchAll(pattern)) {
    const captured = match[1];
    // A paragraph close with no capture: end the line rather than the run.
    if (captured === undefined) {
      if (out.length > 0 && out[out.length - 1] !== '\n') out.push('\n');
      continue;
    }
    out.push(decodeXmlText(captured));
  }
  return out.join('');
}

interface ArchivePart {
  readonly name: string;
  readonly xml: string;
}

/**
 * Inflate exactly the parts a reader needs, refusing a hostile archive first.
 *
 * `fflate`'s filter runs on the central directory entry BEFORE the entry is
 * inflated, which is the only place a size or ratio check is worth anything.
 */
function readParts(
  bytes: Uint8Array,
  wanted: (name: string) => boolean,
  limits: ExtractionLimits,
): ArchivePart[] {
  let entriesSeen = 0;
  let bytesAccepted = 0;

  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes, {
      filter: (file: UnzipFileInfo): boolean => {
        entriesSeen += 1;
        if (entriesSeen > limits.maxArchiveEntries) {
          throw new ExtractionFailedError('archive_too_many_entries');
        }
        if (!entryIsSafe(file.name)) {
          throw new ExtractionFailedError('archive_unsafe_entry');
        }
        /*
         * `size` is fflate's name for the COMPRESSED size and `originalSize`
         * for the uncompressed one — the opposite of what the names suggest at
         * a glance, and worth stating, because reading them the other way round
         * turns this guard into its own inverse and admits exactly the archives
         * it exists to refuse.
         */
        if (file.originalSize > limits.maxArchiveBytes) {
          throw new ExtractionFailedError('archive_entry_too_large');
        }
        // A stored (uncompressed) entry has a ratio of 1 and a tiny entry has
        // no meaningful ratio at all, so the guard only applies above a size
        // where an attack could matter.
        if (
          file.size > 0 &&
          file.originalSize > 64 * 1024 &&
          file.originalSize / file.size > limits.maxCompressionRatio
        ) {
          throw new ExtractionFailedError('archive_compression_ratio');
        }
        if (!wanted(file.name)) return false;
        bytesAccepted += file.originalSize;
        if (bytesAccepted > limits.maxArchiveBytes) {
          throw new ExtractionFailedError('archive_too_large');
        }
        return true;
      },
    });
  } catch (error: unknown) {
    if (error instanceof ExtractionFailedError) throw error;
    // fflate's own errors describe offsets and internal state. They are an
    // operator's diagnostic, never a customer's message.
    throw new ExtractionFailedError('archive_unreadable', error);
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  return (
    Object.entries(archive)
      .map(([name, content]) => ({ name, xml: decoder.decode(content) }))
      // Sorted, so the same file always yields the same order: `unzipSync`
      // returns an object, and object key order is not a guarantee worth relying
      // on when a citation has to be reproducible (D-65).
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))
  );
}

export class DocxExtractor implements TextExtractor {
  readonly #limits: ExtractionLimits;

  constructor(limits: ExtractionLimits) {
    this.#limits = limits;
  }

  supports(mimeType: string): boolean {
    return mimeType === DOCX_TYPE;
  }

  validate(bytes: Uint8Array): void {
    requireKind(bytes, this.#limits, 'docx');
  }

  async extract(input: ExtractionInput): Promise<ExtractedText> {
    const parts = readParts(
      input.bytes,
      (name) => name === 'word/document.xml' || name === CONTENT_TYPES_PART,
      this.#limits,
    );
    if (kindFromContentTypes(parts.find((part) => part.name === CONTENT_TYPES_PART)) !== 'docx') {
      throw new ExtractionFailedError('ooxml_type_mismatch');
    }
    const document = parts.find((part) => part.name === 'word/document.xml');
    if (!document) throw new ExtractionFailedError('document_part_missing');

    const text = textOfElements(document.xml, 't', 'p')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text.length === 0) throw new ExtractionFailedError('no_text_found');

    const truncated = text.slice(0, this.#limits.maxTextChars);
    return {
      text: truncated,
      // A `.docx` has no fixed pagination — the page a paragraph lands on
      // depends on the renderer — so claiming a page number would be inventing
      // a citation the customer cannot check (D-65).
      pageCount: null,
      boundaries: sectionBoundaries(truncated),
    };
  }
}

export class PptxExtractor implements TextExtractor {
  readonly #limits: ExtractionLimits;

  constructor(limits: ExtractionLimits) {
    this.#limits = limits;
  }

  supports(mimeType: string): boolean {
    return mimeType === PPTX_TYPE;
  }

  validate(bytes: Uint8Array): void {
    requireKind(bytes, this.#limits, 'pptx');
  }

  async extract(input: ExtractionInput): Promise<ExtractedText> {
    /*
     * PHASE 2C-4 — `extraction.maxPages` BOUNDS SLIDES as it bounds PDF pages:
     * the slides past it are not read, and not inflated either — the filter
     * declines them before fflate touches their bytes. No separate setting.
     */
    const all = readParts(
      input.bytes,
      (name) =>
        name === CONTENT_TYPES_PART ||
        (/^ppt\/slides\/slide\d+\.xml$/.test(name) && slideNumber(name) <= this.#limits.maxPages),
      this.#limits,
    );
    if (kindFromContentTypes(all.find((part) => part.name === CONTENT_TYPES_PART)) !== 'pptx') {
      throw new ExtractionFailedError('ooxml_type_mismatch');
    }
    const parts = all.filter((part) => part.name !== CONTENT_TYPES_PART);
    if (parts.length === 0) throw new ExtractionFailedError('document_part_missing');

    // Numeric slide order, not lexicographic: `slide10` follows `slide9`.
    const ordered = [...parts].sort((a, b) => slideNumber(a.name) - slideNumber(b.name));

    const boundaries: { label: string; startOffset: number }[] = [];
    let text = '';
    for (const part of ordered) {
      if (text.length >= this.#limits.maxTextChars) break;
      const slide = textOfElements(part.xml, 't', 'p').trim();
      boundaries.push({ label: `slide ${slideNumber(part.name)}`, startOffset: text.length });
      text += `${slide}\n\n`;
    }

    const trimmed = text.slice(0, this.#limits.maxTextChars).trim();
    if (trimmed.length === 0) throw new ExtractionFailedError('no_text_found');

    return {
      text: trimmed,
      pageCount: ordered.length,
      boundaries: boundaries.filter((boundary) => boundary.startOffset <= trimmed.length),
    };
  }
}

function slideNumber(name: string): number {
  return Number.parseInt(/slide(\d+)\.xml$/.exec(name)?.[1] ?? '0', 10);
}

/** Blank-line sections, so a citation says something better than an offset. */
export function sectionBoundaries(text: string): { label: string; startOffset: number }[] {
  const boundaries: { label: string; startOffset: number }[] = [];
  let offset = 0;
  let section = 1;
  for (const block of text.split(/\n{2,}/)) {
    boundaries.push({ label: `section ${section}`, startOffset: offset });
    offset += block.length + 2;
    section += 1;
  }
  return boundaries;
}
