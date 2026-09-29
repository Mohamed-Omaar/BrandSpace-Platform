/**
 * Text extraction and chunking.
 *
 * EXTRACTION IS AN INTERFACE WITH REAL IMPLEMENTATIONS BEHIND IT. Phase 5A
 * shipped the interface and one built-in extractor for the formats that need no
 * library, and refused PDF, Word and PowerPoint at upload — which was honest,
 * and which meant the three formats customers actually have could not be
 * ingested at all (F-70).
 *
 * The implementations now live next to this file, one per family, and each
 * carries the reasoning for its dependency and its refusals:
 *
 *   - `PlainTextExtractor`  — text, Markdown, CSV. No dependency.
 *   - `DocxExtractor`, `PptxExtractor` — `extract-ooxml.ts`. A bounded ZIP read
 *     and a scan for one element, rather than a document-conversion library.
 *   - `PdfExtractor` — `extract-pdf.ts`. Mozilla's pdf.js, configured so it
 *     cannot compile, cannot fetch, and cannot exceed its budget.
 *
 * IMAGES ARE NOT SUPPORTED, deliberately (D-93). See the `allowedMimeTypes`
 * comment in the `brand-brain` configuration schema for the reasoning.
 *
 * A format with no extractor produces an honest FAILED document with a
 * customer-safe message — never a silently empty one, which would present as
 * "processed, 0 facts found" and teach the customer that Brand Brain does not
 * work.
 *
 * EVERY FAILURE REACHES THE CUSTOMER AS A CODE, NEVER AS A LIBRARY'S WORDS. A
 * parser's error text names offsets, object numbers and internal state; it is
 * an operator's diagnostic and it is exactly the kind of detail CLAUDE.md §2.3
 * and docs/SECURITY.md keep off a customer's screen. `ExtractionFailedError`
 * carries a stable reason key that the dashboard translates, and keeps the
 * original as a non-enumerable cause for the log.
 */

import type { BrandKnowledgeArea } from '@brandspace/database';

export interface ExtractionInput {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly fileName: string;
}

export interface ExtractedText {
  readonly text: string;
  /** Null for formats with no page concept. */
  readonly pageCount: number | null;
  /**
   * Page or section boundaries as character offsets into `text`, so a chunk
   * can be told which page it came from. A citation the customer cannot check
   * is not evidence (D-65).
   */
  readonly boundaries: readonly { readonly label: string; readonly startOffset: number }[];
}

export interface TextExtractor {
  supports(mimeType: string): boolean;
  /**
   * PHASE 2C-4 — IS THIS FILE REALLY WHAT THIS EXTRACTOR READS? Cheap, bounded
   * checks on the actual bytes, run at upload before anything is stored and
   * again by the worker on the stored bytes. Throws `ExtractionFailedError`
   * with a stable reason; parses nothing it does not have to.
   */
  validate?(bytes: Uint8Array): void;
  extract(input: ExtractionInput): Promise<ExtractedText>;
}

/** Raised when no extractor claims the format. Carries a customer-safe message. */
export class ExtractionUnsupportedError extends Error {
  constructor(public readonly mimeType: string) {
    super(`No text extractor is available for ${mimeType}.`);
    this.name = 'ExtractionUnsupportedError';
  }
}

/**
 * Why one document could not be read.
 *
 * `reason` is a STABLE KEY, not a message: the dashboard has a translation for
 * each one in both languages, so a customer reads "this file looks damaged"
 * rather than a byte offset. The underlying error is kept as `cause` for the
 * operator log and is never rendered.
 */
export type ExtractionFailureReason =
  | 'archive_unreadable'
  | 'archive_unsafe_entry'
  | 'archive_too_many_entries'
  | 'archive_entry_too_large'
  | 'archive_too_large'
  | 'archive_compression_ratio'
  | 'document_part_missing'
  | 'no_text_found'
  | 'pdf_unreadable'
  | 'pdf_has_no_text_layer'
  | 'extraction_timed_out'
  | 'content_does_not_match_type'
  // Phase 2C-4 — what upload validation refuses on the bytes themselves.
  | 'ooxml_content_types_missing'
  | 'ooxml_main_part_missing'
  | 'ooxml_type_mismatch'
  | 'text_not_utf8'
  | 'text_contains_nul';

export class ExtractionFailedError extends Error {
  constructor(
    public readonly reason: ExtractionFailureReason,
    cause?: unknown,
  ) {
    // The MESSAGE is the key. Nothing derived from the file or from a library
    // goes into it, because an Error's message is the thing most likely to be
    // logged, serialised or — the failure this prevents — shown.
    super(reason);
    this.name = 'ExtractionFailedError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * How much work one document may cost.
 *
 * Read from the `brand-brain` configuration domain (CLAUDE.md §2.2); there is
 * no default written here, because a ceiling depends on the hardware the
 * workers run on, which is an operator's fact.
 */
export interface ExtractionLimits {
  readonly maxPages: number;
  readonly maxTextChars: number;
  readonly maxArchiveEntries: number;
  readonly maxArchiveBytes: number;
  readonly maxCompressionRatio: number;
  readonly timeoutMs: number;
}

const PLAIN_TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv']);

/**
 * The formats that need no third-party parser.
 *
 * CSV is flattened row-by-row rather than parsed into columns: Brand Brain
 * wants prose it can ground on, and a naive column parse of an arbitrary
 * customer spreadsheet invents structure that is not there.
 */
export class PlainTextExtractor implements TextExtractor {
  supports(mimeType: string): boolean {
    return PLAIN_TEXT_TYPES.has(mimeType);
  }

  readonly #limits: ExtractionLimits;

  constructor(limits: ExtractionLimits) {
    this.#limits = limits;
  }

  validate(bytes: Uint8Array): void {
    strictUtf8(bytes);
  }

  async extract(input: ExtractionInput): Promise<ExtractedText> {
    // The WHOLE file, strictly: a text source is UTF-8 or it is not text.
    const decoded = strictUtf8(input.bytes);
    // Bounded like every other format. A 25 MB text file is admissible by the
    // upload policy and would otherwise be chunked in full.
    const text = decoded.slice(0, this.#limits.maxTextChars);
    if (text.trim().length === 0) throw new ExtractionFailedError('no_text_found');

    const boundaries: { label: string; startOffset: number }[] = [];
    // Sections from blank-line separation, so a locator says something more
    // useful than a character offset.
    let offset = 0;
    let section = 1;
    for (const block of text.split(/\n{2,}/)) {
      boundaries.push({ label: `section ${section}`, startOffset: offset });
      offset += block.length + 2;
      section += 1;
    }
    return { text, pageCount: null, boundaries };
  }
}

/**
 * The registry. Ordered: the first extractor that claims the type wins.
 */
export class ExtractorRegistry {
  readonly #extractors: TextExtractor[];
  readonly #timeoutMs: number | null;

  /**
   * `timeoutMs` — PHASE 2C-4: `extraction.timeoutMs` as a wall-clock bound on
   * the WHOLE extraction of one document (validation and parsing, every
   * format), not only between PDF pages. Omitted, there is no registry-level
   * bound (the unit suites that exercise one extractor at a time).
   */
  constructor(extractors: readonly TextExtractor[], options: { readonly timeoutMs?: number } = {}) {
    this.#extractors = [...extractors];
    this.#timeoutMs = options.timeoutMs ?? null;
  }

  register(extractor: TextExtractor): void {
    this.#extractors.push(extractor);
  }

  supports(mimeType: string): boolean {
    return this.#extractors.some((e) => e.supports(mimeType));
  }

  /**
   * Upload validation: the extractor that will read this type checks that the
   * bytes really are that type (Phase 2C-4). Throws `ExtractionUnsupportedError`
   * for a type nothing reads and `ExtractionFailedError` with a stable reason
   * otherwise.
   */
  validate(input: { readonly bytes: Uint8Array; readonly mimeType: string }): void {
    const extractor = this.#extractors.find((e) => e.supports(input.mimeType));
    if (!extractor) throw new ExtractionUnsupportedError(input.mimeType);
    extractor.validate?.(input.bytes);
  }

  async extract(input: ExtractionInput): Promise<ExtractedText> {
    const extractor = this.#extractors.find((e) => e.supports(input.mimeType));
    if (!extractor) throw new ExtractionUnsupportedError(input.mimeType);
    // The worker re-checks the STORED bytes: what was validated at upload is
    // what is parsed, and a row written by an older release is checked too.
    const run = async (): Promise<ExtractedText> => {
      extractor.validate?.(input.bytes);
      return extractor.extract(input);
    };
    const limit = this.#timeoutMs;
    if (limit === null) return run();

    /*
     * ONE DEADLINE FOR THE WHOLE DOCUMENT. The race ends the wait when the
     * budget is spent. Synchronous work — an archive read, a UTF-8 decode —
     * cannot be pre-empted inside one process, so it is bounded by the archive
     * and size limits instead, and a result that arrives after the deadline is
     * still refused: the budget is a promise about wall-clock time, and a late
     * answer breaks it the same way a missing one does.
     */
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ExtractionFailedError('extraction_timed_out')), limit);
    });
    try {
      const result = await Promise.race([run(), deadline]);
      if (Date.now() - started > limit) throw new ExtractionFailedError('extraction_timed_out');
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A text source, decoded strictly (Phase 2C-4).
 *
 * TEXT HAS NO MAGIC NUMBER. A PDF or an Office file announces itself in its
 * first bytes; a text file only IS text if every byte of it decodes. So the
 * ENTIRE file is decoded with a fatal decoder — the signature check's 64 KB
 * sample is not enough to call a file text — a NUL byte is refused (no text
 * format carries one, and it is how a binary file passes a lenient decode),
 * and an optional UTF-8 byte-order mark is stripped (the decoder's default).
 */
export function strictUtf8(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new ExtractionFailedError('text_contains_nul');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new ExtractionFailedError('text_not_utf8', error);
  }
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export interface Chunk {
  readonly index: number;
  readonly text: string;
  readonly locator: string;
}

export interface ChunkOptions {
  readonly targetChars: number;
  readonly overlapChars: number;
  readonly maxChunks: number;
}

/**
 * Split text into overlapping chunks on paragraph boundaries where possible.
 *
 * DETERMINISTIC BY CONSTRUCTION. The same document must produce the same chunks
 * every time, or a citation recorded last month points at different text today
 * and D-65 reproducibility is lost. No randomness, no locale-dependent
 * collation, no time.
 *
 * The overlap exists so a fact split across a boundary survives in at least one
 * chunk whole.
 */
export function chunkText(
  text: string,
  boundaries: readonly { readonly label: string; readonly startOffset: number }[],
  options: ChunkOptions,
): Chunk[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) return [];

  const chunks: Chunk[] = [];
  const step = Math.max(1, options.targetChars - options.overlapChars);

  for (let start = 0; start < normalized.length; start += step) {
    if (chunks.length >= options.maxChunks) break;

    const hardEnd = Math.min(normalized.length, start + options.targetChars);
    // Prefer to end on a paragraph or sentence boundary, but never search back
    // past the halfway point: a document with no punctuation would otherwise
    // collapse to one-character chunks.
    let end = hardEnd;
    if (hardEnd < normalized.length) {
      const window = normalized.slice(start, hardEnd);
      const paragraph = window.lastIndexOf('\n\n');
      const sentence = window.lastIndexOf('. ');
      const candidate = Math.max(paragraph, sentence);
      if (candidate > options.targetChars / 2) end = start + candidate + 1;
    }

    const slice = normalized.slice(start, end).trim();
    if (slice.length > 0) {
      chunks.push({
        index: chunks.length,
        text: slice,
        locator: locatorFor(start, boundaries),
      });
    }
    if (end >= normalized.length) break;
  }

  return chunks;
}

function locatorFor(
  offset: number,
  boundaries: readonly { readonly label: string; readonly startOffset: number }[],
): string {
  let label = 'start of document';
  for (const boundary of boundaries) {
    if (boundary.startOffset <= offset) label = boundary.label;
    else break;
  }
  return label;
}

// ---------------------------------------------------------------------------
// Candidate facts
// ---------------------------------------------------------------------------

export interface CandidateFact {
  readonly area: BrandKnowledgeArea;
  readonly itemKey: string;
  readonly title: { readonly en?: string; readonly ar?: string };
  readonly body: { readonly en?: string; readonly ar?: string };
  readonly confidenceMilli: number;
  readonly evidence: readonly {
    readonly chunkIndex: number;
    readonly locator: string;
    readonly quote: string;
    /**
     * WHY THE CONFIDENCE IS WHAT IT IS (Phase 2C, D4), recorded when the
     * candidate is made so the review inbox explains it from stored facts
     * rather than reverse-engineering a number: how the area was matched, how
     * many of its keywords the sentence holds, and whether it is the area the
     * uploader aimed the document at.
     */
    readonly method?: 'keyword';
    readonly keywordHits?: number;
    readonly aimedArea?: boolean;
  }[];
}

export interface FactExtractor {
  /**
   * Propose candidate facts from chunks.
   *
   * NEVER writes knowledge. The return value is a PROPOSAL: the ingestion
   * service stores it as a candidate and a human decides. That separation is
   * D-65's approval state, and it is why this interface cannot reach a
   * database at all.
   */
  extract(input: {
    readonly chunks: readonly Chunk[];
    readonly targetArea: BrandKnowledgeArea | null;
    readonly minimumConfidenceMilli: number;
  }): Promise<readonly CandidateFact[]>;
}

/**
 * Deterministic fact extraction, with NO model call.
 *
 * D-13 approved the provider ARCHITECTURE and deferred the vendors. Until one
 * is chosen this has to work without one, and a mock that invented plausible
 * brand facts would be worse than useless — a customer would review fiction and
 * approve it into their own knowledge base.
 *
 * So it does something narrow and honest instead: it surfaces the document's
 * own sentences as candidates, verbatim, each carrying the chunk and locator it
 * came from. Every proposal is checkable against the source because it IS the
 * source. Confidence reflects how strongly the sentence matches the area's
 * keywords, and nothing is invented.
 */
export class KeywordFactExtractor implements FactExtractor {
  async extract(input: {
    readonly chunks: readonly Chunk[];
    readonly targetArea: BrandKnowledgeArea | null;
    readonly minimumConfidenceMilli: number;
  }): Promise<readonly CandidateFact[]> {
    const facts: CandidateFact[] = [];
    const seen = new Set<string>();

    for (const chunk of input.chunks) {
      for (const sentence of splitSentences(chunk.text)) {
        const scored = scoreSentence(sentence, input.targetArea);
        if (!scored) continue;
        if (scored.confidenceMilli < input.minimumConfidenceMilli) continue;

        const itemKey = deriveItemKey(scored.area, sentence);
        // One candidate per key per document. A repeated sentence is one fact.
        if (seen.has(itemKey)) continue;
        seen.add(itemKey);

        facts.push({
          area: scored.area,
          itemKey,
          title: { en: truncate(sentence, 80) },
          body: { en: sentence },
          confidenceMilli: scored.confidenceMilli,
          evidence: [
            {
              chunkIndex: chunk.index,
              locator: chunk.locator,
              quote: truncate(sentence, 300),
              method: 'keyword',
              keywordHits: scored.keywordHits,
              aimedArea: scored.area === input.targetArea,
            },
          ],
        });
      }
    }

    return facts;
  }
}

/** Area keywords. English and Arabic, because both are first-class. */
const AREA_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  IDENTITY: ['mission', 'vision', 'positioning', 'we are', 'our brand', 'رؤية', 'رسالة'],
  AUDIENCE: ['audience', 'customer', 'segment', 'persona', 'جمهور', 'عميل'],
  TONE_OF_VOICE: ['tone', 'voice', 'we speak', 'language', 'نبرة', 'أسلوب'],
  OFFERS: ['offer', 'service', 'product', 'package', 'pricing', 'خدمة', 'منتج'],
  PROOF_POINTS: ['award', 'certified', 'years of', 'clients', 'proven', 'جائزة', 'خبرة'],
  DO_DONT: ['never', 'always', 'avoid', 'must not', 'do not', 'يجب', 'تجنب'],
  COMPETITORS: ['competitor', 'unlike', 'compared to', 'منافس'],
  GLOSSARY: ['means', 'refers to', 'defined as', 'تعني', 'يقصد'],
};

function scoreSentence(
  sentence: string,
  targetArea: BrandKnowledgeArea | null,
): { area: BrandKnowledgeArea; confidenceMilli: number; keywordHits: number } | null {
  const lower = sentence.toLowerCase();
  let best: { area: BrandKnowledgeArea; hits: number } | null = null;

  for (const [area, keywords] of Object.entries(AREA_KEYWORDS)) {
    const hits = keywords.filter((k) => lower.includes(k)).length;
    if (hits === 0) continue;
    if (!best || hits > best.hits) best = { area: area as BrandKnowledgeArea, hits };
  }

  // A sentence that matched nothing still belongs to the area the uploader
  // aimed at, if they aimed at one — a file dropped on "Offers" is about
  // offers. It gets a LOW confidence, because that is what a guess deserves.
  if (!best) {
    if (!targetArea) return null;
    return { area: targetArea, confidenceMilli: 400, keywordHits: 0 };
  }

  // Keyword hits map to confidence in fixed steps, so the number is
  // reproducible rather than a tuned curve nobody can explain to a customer.
  const confidenceMilli = Math.min(900, 500 + best.hits * 150);
  // The uploader's stated area is corroboration, not an override: a document
  // dropped on "Offers" whose sentence is plainly about audience stays an
  // audience fact, and the human reviewing it can move it.
  return {
    area: best.area,
    confidenceMilli:
      targetArea === best.area ? Math.min(950, confidenceMilli + 50) : confidenceMilli,
    keywordHits: best.hits,
  };
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?۔])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25 && s.length <= 600);
}

/**
 * A stable key derived from the sentence.
 *
 * Deterministic: the same sentence in the same area always produces the same
 * key, so re-ingesting a document proposes an EDIT to the existing item rather
 * than a duplicate.
 */
function deriveItemKey(area: BrandKnowledgeArea, sentence: string): string {
  const slug = sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-')
    .slice(0, 60);
  const stem = area.toLowerCase().replace(/_/g, '-');
  // A sentence of only non-Latin characters slugs to nothing. Fall back to a
  // stable digest of the sentence rather than emitting an invalid key.
  return slug.length > 0 ? `${stem}.${slug}` : `${stem}.${stableDigest(sentence)}`;
}

function stableDigest(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * The registry every caller should use.
 *
 * One place that decides which formats exist, so the upload allow-list, the
 * signature check and the extractor set cannot drift apart. Adding a format
 * means adding an extractor here AND a media type in configuration; doing only
 * the second produces an honest refusal rather than a stuck document.
 */
export async function defaultExtractors(limits: ExtractionLimits): Promise<TextExtractor[]> {
  const { DocxExtractor, PptxExtractor } = await import('./extract-ooxml');
  const { PdfExtractor } = await import('./extract-pdf');
  return [
    new PlainTextExtractor(limits),
    new DocxExtractor(limits),
    new PptxExtractor(limits),
    new PdfExtractor(limits),
  ];
}

/**
 * The registry the product uses: the default extractors, with the configured
 * `extraction.timeoutMs` bounding each document's whole extraction (Phase
 * 2C-4). The dashboard (upload validation) and the worker (parsing) build the
 * same one, from the same activated configuration.
 */
export async function extractorRegistryFor(limits: ExtractionLimits): Promise<ExtractorRegistry> {
  return new ExtractorRegistry(await defaultExtractors(limits), { timeoutMs: limits.timeoutMs });
}
