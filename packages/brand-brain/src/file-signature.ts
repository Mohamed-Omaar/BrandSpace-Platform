/**
 * What a file ACTUALLY is, decided from its bytes.
 *
 * THE DECLARED MEDIA TYPE IS THE CALLER'S OPINION. A browser derives it from
 * the file extension, and a scripted upload can say anything at all: the
 * `Content-Type` on a multipart part is a string the client chose. Trusting it
 * means a `.txt` rename gets a PDF into the plain-text path, and a file called
 * `brand.docx` that is really a PDF reaches the ZIP reader — both of which are
 * "feed the wrong parser attacker-controlled bytes", the oldest shape of
 * file-upload bug there is.
 *
 * So the declared type is used for ONE thing — deciding whether the workspace
 * is allowed to upload that KIND of file — and the bytes decide which parser
 * runs. When the two disagree, the upload is refused; a file whose name and
 * content disagree is either a mistake worth telling the customer about or an
 * attempt worth refusing.
 *
 * The signatures below are the format authorities' own, and each is checked at
 * offset zero. Some readers tolerate leading junk before `%PDF-`; this does
 * not, deliberately — a prefix before the header is a polyglot technique, and
 * a legitimate document never has one.
 */

export type DetectedFormat = 'pdf' | 'ooxml' | 'text' | 'png' | 'jpeg' | 'unknown';

const SIGNATURES: ReadonlyArray<{
  readonly format: Exclude<DetectedFormat, 'text' | 'unknown'>;
  readonly magic: readonly number[];
}> = [
  // "%PDF-" — ISO 32000-1 §7.5.2.
  { format: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // "PK\x03\x04" — the local file header of a ZIP, which every OOXML file is.
  { format: 'ooxml', magic: [0x50, 0x4b, 0x03, 0x04] },
  { format: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // JPEG: SOI followed by any marker.
  { format: 'jpeg', magic: [0xff, 0xd8, 0xff] },
];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

/**
 * Whether the bytes are plausible UTF-8 text.
 *
 * There is no magic number for a text file, so this is a NEGATIVE test: a file
 * is text if it decodes as UTF-8 without replacement characters and contains no
 * NUL. Both conditions matter. Strict decoding alone accepts a binary that
 * happens to be valid UTF-8; the NUL check catches most of those, because a
 * text document does not contain one and almost every binary format does.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  // A sample, not the whole file: this runs on every upload and a 25 MB scan
  // buys nothing a 64 KB one does not. The window starts at zero because that
  // is where a format signature would be.
  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    // A truncated multi-byte sequence at the sample boundary is not a binary
    // file. Retry one byte short up to three times, which is the longest a
    // UTF-8 sequence can straddle the cut.
    for (let back = 1; back <= 3 && sample.length > back; back += 1) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, sample.length - back));
        return true;
      } catch {
        // Keep trying a shorter window.
      }
    }
    return false;
  }
}

export function detectFormat(bytes: Uint8Array): DetectedFormat {
  for (const { format, magic } of SIGNATURES) {
    if (startsWith(bytes, magic)) return format;
  }
  return looksLikeText(bytes) ? 'text' : 'unknown';
}

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

export interface SignatureCheck {
  readonly ok: boolean;
  readonly detected: DetectedFormat;
  readonly expected: DetectedFormat | null;
}

/**
 * Does the content match what the caller said it was?
 *
 * An empty file is never accepted: there is nothing to check and nothing to
 * extract, and "processed, 0 facts found" is the outcome that teaches a
 * customer the feature does not work.
 */
export function checkSignature(declaredMimeType: string, bytes: Uint8Array): SignatureCheck {
  const expected = EXPECTED_FORMAT[declaredMimeType] ?? null;
  const detected = detectFormat(bytes);
  if (bytes.length === 0) return { ok: false, detected: 'unknown', expected };
  // An unknown declared type is refused by the allow-list before this runs;
  // reaching here with one is a configuration mistake, and refusing is right.
  if (expected === null) return { ok: false, detected, expected };
  return { ok: detected === expected, detected, expected };
}
