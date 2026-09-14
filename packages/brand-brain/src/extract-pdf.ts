import type { ExtractedText, ExtractionInput, TextExtractor } from './extraction';
import { ExtractionFailedError, type ExtractionLimits } from './extraction';

/**
 * PDF text, through Mozilla's pdf.js.
 *
 * THE DEPENDENCY REVIEW, written down rather than assumed:
 *
 *   - `pdfjs-dist`, Apache-2.0 — a permissive licence with an explicit patent
 *     grant, compatible with a closed-source product.
 *   - Maintained by Mozilla as the PDF engine that ships in Firefox, which
 *     means it is the JavaScript PDF reader with by far the largest hostile-input
 *     exposure and the most active security response. That is the property that
 *     matters for a parser that runs on files strangers upload.
 *   - Pure JavaScript and WebAssembly: no native build step, no postinstall
 *     script, and nothing to compile in a container.
 *
 * HOW IT IS CONFIGURED, AND WHY EACH OPTION.
 *
 *   - `isEvalSupported: false`. pdf.js can compile font programs with `eval`
 *     for speed. Text extraction does not need it, and a parser running
 *     attacker-supplied data should not be compiling anything.
 *   - `useWorkerFetch: false`, `standardFontDataUrl` unset, `disableFontFace`,
 *     `useSystemFonts: false`. Every one of these removes a way for the library
 *     to go and FETCH something while parsing. A PDF names its own resources,
 *     so a reader that fetches is a reader a customer can aim.
 *   - `password` is never supplied and never prompted for: an encrypted PDF is
 *     refused rather than attacked.
 *   - `stopAtErrors: false`. A damaged page yields what it can rather than
 *     failing the whole document, which is the behaviour a customer wants from
 *     a scanned contract with one bad object in it.
 *
 * AND WHAT THE LIBRARY DOES NOT DECIDE: how much work it may do. The page
 * ceiling, the character ceiling and the wall-clock deadline are enforced here,
 * from configuration, because "the document said fifty thousand pages" is not a
 * reason to read fifty thousand pages.
 */

/** The shape this file uses. Declared locally so the import stays type-only. */
interface PdfTextItem {
  readonly str?: string;
  readonly hasEOL?: boolean;
}

interface PdfPage {
  getTextContent(): Promise<{ items: readonly unknown[] }>;
  cleanup(): void;
}

interface PdfDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

export class PdfExtractor implements TextExtractor {
  readonly #limits: ExtractionLimits;

  constructor(limits: ExtractionLimits) {
    this.#limits = limits;
  }

  supports(mimeType: string): boolean {
    return mimeType === 'application/pdf';
  }

  async extract(input: ExtractionInput): Promise<ExtractedText> {
    /*
     * Imported HERE rather than at module load.
     *
     * pdf.js is several megabytes and initialises a worker; a dashboard render
     * that never touches a PDF should not pay for it, and a process that never
     * ingests one should not hold it in memory.
     */
    const { getDocument } = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
      getDocument: (options: Record<string, unknown>) => PdfLoadingTask;
    };

    const task = getDocument({
      // A COPY. pdf.js transfers ownership of the buffer it is given and
      // detaches it; handing it the caller's array would leave the ingestion
      // service holding an empty one, which surfaces much later as a checksum
      // that no longer matches its own bytes.
      data: new Uint8Array(input.bytes),
      isEvalSupported: false,
      useWorkerFetch: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
    });

    let document: PdfDocument;
    try {
      document = await task.promise;
    } catch (error: unknown) {
      await task.destroy().catch(() => undefined);
      // Encrypted, truncated, or not a PDF after all. All three are the
      // customer's file rather than our failure, and none of pdf.js's own
      // wording reaches them.
      throw new ExtractionFailedError('pdf_unreadable', error);
    }

    try {
      const pageCount = Math.min(document.numPages, this.#limits.maxPages);
      const boundaries: { label: string; startOffset: number }[] = [];
      const deadline = Date.now() + this.#limits.timeoutMs;
      let text = '';

      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        if (Date.now() > deadline) throw new ExtractionFailedError('extraction_timed_out');
        if (text.length >= this.#limits.maxTextChars) break;

        const page = await document.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          boundaries.push({ label: `page ${pageNumber}`, startOffset: text.length });
          text += `${joinItems(content.items)}\n\n`;
        } finally {
          // Released per page: holding every page's operator list is how a
          // 300-page document becomes a memory incident.
          page.cleanup();
        }
      }

      const trimmed = text.slice(0, this.#limits.maxTextChars).trim();
      if (trimmed.length === 0) {
        /*
         * A PDF WITH NO TEXT LAYER — a scan. Not an error in the file and not a
         * failure of this code: there are no characters in it, only pixels.
         * Reading it would need OCR, which D-93 declines for reasons that apply
         * here too. Saying so plainly is better than recording an empty
         * document that reads as "processed, nothing found".
         */
        throw new ExtractionFailedError('pdf_has_no_text_layer');
      }

      return {
        text: trimmed,
        pageCount,
        boundaries: boundaries.filter((boundary) => boundary.startOffset <= trimmed.length),
      };
    } finally {
      await task.destroy().catch(() => undefined);
    }
  }
}

/**
 * One page's items, joined the way the page reads.
 *
 * pdf.js returns positioned runs, not lines. `hasEOL` is its own signal that a
 * run ended a line; without honouring it every page collapses into one
 * unbroken string, and the chunker then has no paragraph boundary to split on.
 */
function joinItems(items: readonly unknown[]): string {
  let out = '';
  for (const raw of items) {
    const item = raw as PdfTextItem;
    if (typeof item.str !== 'string') continue;
    out += item.str;
    if (item.hasEOL) out += '\n';
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}
