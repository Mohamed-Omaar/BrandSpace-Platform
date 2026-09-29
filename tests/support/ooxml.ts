import { strToU8, zipSync } from 'fflate';

/**
 * OOXML packages built in the test, with a REAL `[Content_Types].xml`.
 *
 * Phase 2C-4 made the declared main part part of what makes a package a Word
 * document or a presentation (ECMA-376 Part 2), so a fixture with an empty
 * `<Types/>` is now — correctly — a malformed package. These builders declare
 * the main part the way Word and PowerPoint do; `contentTypesFor` also builds
 * the WRONG declarations the refusal tests need (a spreadsheet, nothing).
 */

export const MAIN_PART = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
} as const;

const MAIN_PART_NAME = {
  docx: '/word/document.xml',
  pptx: '/ppt/presentation.xml',
  xlsx: '/xl/workbook.xml',
} as const;

/** A `[Content_Types].xml` declaring the given main part, or none. */
export function contentTypesFor(kind: keyof typeof MAIN_PART | 'none'): Uint8Array {
  const override =
    kind === 'none'
      ? ''
      : `<Override PartName="${MAIN_PART_NAME[kind]}" ContentType="${MAIN_PART[kind]}"/>`;
  return strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      override +
      '</Types>',
  );
}

export function docxPackage(
  paragraphs: readonly string[],
  extraEntries: Record<string, Uint8Array> = {},
): Uint8Array {
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  return zipSync({
    '[Content_Types].xml': contentTypesFor('docx'),
    'word/document.xml': strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
    ),
    ...extraEntries,
  });
}

export function pptxPackage(
  slides: readonly (readonly string[])[],
  extraEntries: Record<string, Uint8Array> = {},
): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    '[Content_Types].xml': contentTypesFor('pptx'),
  };
  slides.forEach((runs, index) => {
    const body = runs.map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join('');
    entries[`ppt/slides/slide${index + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><p:sld xmlns:a="x" xmlns:p="y"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`,
    );
  });
  return zipSync({ ...entries, ...extraEntries });
}
