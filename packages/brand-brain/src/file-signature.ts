import {
  checkSignature as checkAgainst,
  detectFormat,
  type DetectedFormat,
  type SignatureCheck,
} from '@brandspace/shared';

/**
 * What Brand Brain requires a source document to actually BE.
 *
 * THE DETECTOR MOVED TO `@brandspace/shared`, and only the detector. The magic
 * numbers are the same knowledge wherever they are used, and a second copy of a
 * security check is how one of them learns about a polyglot technique and the
 * other does not. The Asset Library needs a wider table — images, video, audio
 * and fonts — so the table is shared and the EXPECTATION MAP below is not.
 *
 * The map is policy: which media types THIS feature admits, and what each must
 * turn out to be. It changes when Brand Brain's extractors change, which has
 * nothing to do with what a customer may store in their library. Sharing it
 * would couple two allow-lists that move for unrelated reasons.
 *
 * Behaviour is unchanged: the same six types, the same expectations, the same
 * refusal of an empty file and of a type the map does not name.
 */

export type { DetectedFormat, SignatureCheck };
export { detectFormat };

/** The format each accepted media type must actually be. */
const EXPECTED_FORMAT: Readonly<Record<string, DetectedFormat>> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'ooxml',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'ooxml',
  'text/plain': 'text',
  'text/markdown': 'text',
  'text/csv': 'text',
  'image/png': 'png',
  'image/jpeg': 'jpeg',
};

/**
 * Does the content match what the caller said it was?
 *
 * An empty file is never accepted: there is nothing to check and nothing to
 * extract, and "processed, 0 facts found" is the outcome that teaches a
 * customer the feature does not work.
 */
export function checkSignature(declaredMimeType: string, bytes: Uint8Array): SignatureCheck {
  return checkAgainst(EXPECTED_FORMAT, declaredMimeType, bytes);
}
