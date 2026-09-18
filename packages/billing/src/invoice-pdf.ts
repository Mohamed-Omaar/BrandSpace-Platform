import {
  documentLines,
  invoiceFilename,
  type DocumentLocale,
  type InvoiceDocument,
  type InvoiceDocumentRenderer,
  type RenderedDocument,
} from './invoice-document';

/**
 * A DETERMINISTIC PDF RENDERER — Phase 10 §23.
 *
 * WHAT IT ACTUALLY IS. A complete, dependency-free PDF 1.7 writer: it emits a
 * real file with a real cross-reference table that a real reader opens. It uses
 * Helvetica, one of the fourteen fonts every PDF reader is required to provide,
 * which is why it needs no font file and embeds nothing.
 *
 * AND WHAT IT THEREFORE CANNOT DO. The base fourteen are WinAnsi-encoded: they
 * contain no Arabic glyphs at all. `supportedLocales` says `['en']` and
 * `renderRefusal` turns an Arabic request into a sentence explaining what to do
 * instead, because a PDF full of blank boxes is worse than an honest refusal —
 * it looks like a document until somebody opens it.
 *
 * WHY THIS IS THE RIGHT THING TO SHIP RATHER THAN A VENDOR. Setting Arabic in a
 * PDF needs a LICENSED font to embed and a SHAPING engine to place the glyphs
 * (Arabic is cursive and contextual; letters change shape by neighbour, and
 * bidirectional text is reordered before it is drawn). The first is a cost
 * decision that belongs to the owner, and the second is not something to
 * hand-roll for an accounting document. D-216 records exactly what is needed.
 *
 * MEANWHILE ARABIC IS NOT MISSING. The invoice document route sets both
 * languages correctly and prints to PDF from the browser, which has both a font
 * and a shaping engine — that path is complete, and it is the same document
 * from the same data.
 */
export class DeterministicPdfRenderer implements InvoiceDocumentRenderer {
  readonly key = 'deterministic-pdf';
  /*
   * ENGLISH ONLY, DECLARED RATHER THAN DISCOVERED. A renderer that claimed
   * `['ar', 'en']` and drew boxes would pass every test that checks a PDF was
   * produced.
   */
  readonly supportedLocales: readonly DocumentLocale[] = ['en'];

  async render(document: InvoiceDocument, locale: DocumentLocale): Promise<RenderedDocument> {
    if (!this.supportedLocales.includes(locale)) {
      throw new Error(
        `The deterministic PDF renderer has no Arabic font and will not draw boxes instead. ` +
          'Print the invoice document page, which sets both scripts correctly.',
      );
    }
    const body = writePdf(documentLines(document, locale));
    return {
      body,
      contentType: 'application/pdf',
      filename: invoiceFilename(document, 'pdf'),
    };
  }
}

/* A4 at 72 dpi, which is the unit a PDF content stream works in. */
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const LINE_HEIGHT = 16;
const FONT_SIZE = 11;

/**
 * Escape a string for a PDF literal.
 *
 * THREE CHARACTERS AND NOTHING ELSE MATTERS: a backslash, and the two
 * parentheses that delimit the literal. An unescaped `)` ends the string early
 * and corrupts every byte offset after it — which is exactly the class of bug
 * that makes a generated PDF open on one reader and not another.
 */
function escapeLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Drop anything Helvetica cannot draw.
 *
 * WinAnsi covers Latin-1. A character outside it would be written as a byte the
 * font maps to something else entirely, so it is replaced rather than silently
 * mis-drawn. In practice this only fires on a defensive path: the renderer
 * refuses Arabic before reaching here.
 */
function toWinAnsi(value: string): string {
  return [...value]
    .map((character) => (character.charCodeAt(0) <= 0xff ? character : '?'))
    .join('');
}

/**
 * Write the file.
 *
 * A PDF IS ITS CROSS-REFERENCE TABLE. Every object's byte offset is recorded in
 * `xref`, so the offsets are measured as the body is assembled rather than
 * guessed — which is why this builds the body first and the table second.
 */
function writePdf(lines: readonly string[]): Uint8Array {
  const content = buildContentStream(lines);
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];

  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  /*
   * `latin1`, not `utf8`. Every byte offset in the table above was measured in
   * JavaScript string length, and those two agree only when one character is
   * one byte. Encoding as UTF-8 would shift every offset past the first
   * non-ASCII character and produce a file that opens as a blank page.
   */
  return new Uint8Array(Buffer.from(body + xref + trailer, 'latin1'));
}

function buildContentStream(lines: readonly string[]): string {
  const parts = [
    'BT',
    `/F1 ${FONT_SIZE} Tf`,
    `${LINE_HEIGHT} TL`,
    `1 0 0 1 ${MARGIN} ${PAGE_HEIGHT - MARGIN} Tm`,
  ];
  for (const line of lines) {
    parts.push(`(${escapeLiteral(toWinAnsi(line))}) Tj`, 'T*');
  }
  parts.push('ET');
  return parts.join('\n');
}
