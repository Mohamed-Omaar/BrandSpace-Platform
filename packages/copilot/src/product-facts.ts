import type { IngestionPolicy, ExtractionLimits } from '@brandspace/brand-brain';

/**
 * PR U — WHAT BRANDSPACE CAN ACTUALLY DO, TOLD TO THE COPILOT.
 *
 * On staging the Copilot told a customer it reads Excel and "any file". It had
 * never been told what Brand Brain accepts, so it guessed. These lines are
 * built at each turn from the ACTIVATED `brand-brain` configuration (CLAUDE.md
 * §2.2): change the accepted types or limits in the Control Center and the
 * next turn says so. Nothing here is a policy value; only the human NAME of a
 * media type is written down, and a type with no name is listed as itself.
 *
 * Platform text, never customer text, so it is not fenced. The prompt tells
 * the model to answer product questions from these lines only.
 */
export interface ProductFacts {
  readonly upload: Pick<
    IngestionPolicy,
    'allowedMimeTypes' | 'maxFileBytes' | 'maxDocumentsPerBrand'
  >;
  readonly extraction: Pick<ExtractionLimits, 'maxPages'>;
}

const TYPE_NAMES: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF (.pdf) with selectable text',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word (.docx)',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint (.pptx)',
  'text/plain': 'plain text (.txt)',
  'text/csv': 'CSV (.csv)',
  'text/markdown': 'Markdown (.md)',
};

/** A media type's name, or the type itself when it has none. */
export function typeName(mimeType: string): string {
  return TYPE_NAMES[mimeType] ?? mimeType;
}

/** A size as a person reads it: whole MB, one decimal, or KB under 1 MB (never "0.0 MB"). */
export function readableSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return kb >= 1 ? `${Math.floor(kb)} KB` : `${bytes} bytes`;
}

/**
 * The PRODUCT FACTS block. `null` (the configuration could not be read) says
 * so, and the model is then told to say it is not sure rather than guess.
 */
export function productFactsLines(facts: ProductFacts | null): readonly string[] {
  const lines = [
    'PRODUCT FACTS (the only source for what Brandspace can do):',
    '- A file attached here is offered as a card: "Add" sends it to Brand Brain, which reads it and proposes facts for the person to approve. Nothing is stored before Add.',
  ];
  if (facts) {
    lines.push(
      `- Brand Brain reads ONLY these file types: ${facts.upload.allowedMimeTypes.map(typeName).join(', ')}. Every other type is not accepted.`,
      `- Each file may be up to ${readableSize(facts.upload.maxFileBytes)}; at most the first ${facts.extraction.maxPages} pages are read; a brand may hold up to ${facts.upload.maxDocumentsPerBrand} files.`,
      '- Scanned PDFs (pictures of pages without selectable text) cannot be read.',
    );
  } else {
    lines.push(
      '- The accepted file types and limits could not be loaded just now: if asked, say you are not sure and suggest checking Brand Brain → Sources.',
    );
  }
  lines.push(
    '- Reading a web page or link is not available.',
    '- In this conversation the person can start a New topic, search the conversation, clear it, and stop a reply.',
  );
  return lines;
}
