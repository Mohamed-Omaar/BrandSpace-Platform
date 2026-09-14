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
 * is allowed to upload that KIND of file — and the bytes decide what it is.
 * When the two disagree the upload is refused; a file whose name and content
 * disagree is either a mistake worth telling the customer about or an attempt
 * worth refusing.
 *
 * WHY THIS LIVES IN `shared` RATHER THAN IN THE FEATURE THAT FIRST NEEDED IT.
 * It was born in `packages/brand-brain`, which was its only consumer. The Asset
 * Library is the second, and it needs a WIDER table — images, video, audio and
 * fonts as well as documents. The two ways to get there were a second copy of
 * the magic numbers, or one table both read. A second copy of a security check
 * is the worse option every time: the day one of them learns about a new
 * polyglot technique and the other does not is invisible until it is exploited.
 *
 * What each feature keeps for itself is the EXPECTATION MAP — which media types
 * it admits and what each must actually be. That is policy, it changes for
 * different reasons in each feature, and sharing it would couple two allow-lists
 * that have nothing to do with each other.
 *
 * The signatures below are the format authorities' own, and each is checked at
 * offset zero unless noted. Some readers tolerate leading junk before `%PDF-`;
 * this does not, deliberately — a prefix before the header is a polyglot
 * technique, and a legitimate document never has one.
 */

export type DetectedFormat =
  | 'pdf'
  | 'ooxml'
  | 'text'
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'gif'
  | 'mp4'
  | 'webm'
  | 'mp3'
  | 'wav'
  | 'woff2'
  | 'ttf'
  | 'unknown';

/**
 * A signature that is not at offset zero.
 *
 * Three of the formats below are container formats whose magic sits after a
 * length or a chunk header. Each is checked at ITS OWN fixed offset rather than
 * by scanning, because scanning for a marker anywhere in the file is how a
 * polyglot passes: any format can be made to contain any four bytes.
 */
interface Signature {
  readonly format: Exclude<DetectedFormat, 'text' | 'unknown'>;
  readonly magic: readonly number[];
  readonly offset?: number;
  /** A second fixed run of bytes that must also match, for container formats. */
  readonly also?: { readonly magic: readonly number[]; readonly offset: number };
}

const SIGNATURES: readonly Signature[] = [
  // "%PDF-" — ISO 32000-1 §7.5.2.
  { format: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // "PK\x03\x04" — the local file header of a ZIP, which every OOXML file is.
  { format: 'ooxml', magic: [0x50, 0x4b, 0x03, 0x04] },
  { format: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // JPEG: SOI followed by any marker.
  { format: 'jpeg', magic: [0xff, 0xd8, 0xff] },
  // "RIFF" .... "WEBP" — the four size bytes between are not constrained.
  {
    format: 'webp',
    magic: [0x52, 0x49, 0x46, 0x46],
    also: { magic: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  },
  // "RIFF" .... "WAVE".
  {
    format: 'wav',
    magic: [0x52, 0x49, 0x46, 0x46],
    also: { magic: [0x57, 0x41, 0x56, 0x45], offset: 8 },
  },
  // "GIF8" — covers both 87a and 89a.
  { format: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },
  // ISO base media: a box length, then "ftyp" at offset 4 (ISO/IEC 14496-12).
  { format: 'mp4', magic: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  // EBML header — Matroska and WebM share it.
  { format: 'webm', magic: [0x1a, 0x45, 0xdf, 0xa3] },
  // "ID3" — an MP3 carrying a tag.
  { format: 'mp3', magic: [0x49, 0x44, 0x33] },
  // A bare MPEG audio frame sync, for an MP3 with no tag.
  { format: 'mp3', magic: [0xff, 0xfb] },
  { format: 'mp3', magic: [0xff, 0xf3] },
  { format: 'mp3', magic: [0xff, 0xf2] },
  // "wOF2".
  { format: 'woff2', magic: [0x77, 0x4f, 0x46, 0x32] },
  // TrueType: the 0x00010000 version tag, or "true".
  { format: 'ttf', magic: [0x00, 0x01, 0x00, 0x00] },
  { format: 'ttf', magic: [0x74, 0x72, 0x75, 0x65] },
];

function matchesAt(bytes: Uint8Array, magic: readonly number[], offset: number): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((byte, index) => bytes[offset + index] === byte);
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
  for (const signature of SIGNATURES) {
    if (!matchesAt(bytes, signature.magic, signature.offset ?? 0)) continue;
    if (signature.also && !matchesAt(bytes, signature.also.magic, signature.also.offset)) continue;
    return signature.format;
  }
  return looksLikeText(bytes) ? 'text' : 'unknown';
}

export interface SignatureCheck {
  readonly ok: boolean;
  readonly detected: DetectedFormat;
  readonly expected: DetectedFormat | readonly DetectedFormat[] | null;
}

/**
 * Does the content match what the caller said it was, according to one
 * feature's expectation map?
 *
 * An empty file is never accepted: there is nothing to check, and a zero-byte
 * asset is a failed upload the customer will report as a bug.
 *
 * A media type the map does not mention is REFUSED rather than admitted. The
 * allow-list should have caught it first, so reaching here with one means a
 * configuration and a table disagree — and admitting a file nobody can classify
 * is the wrong way to resolve that.
 */
export function checkSignature(
  expectations: Readonly<Record<string, DetectedFormat | readonly DetectedFormat[]>>,
  declaredMimeType: string,
  bytes: Uint8Array,
): SignatureCheck {
  const expected = expectations[declaredMimeType] ?? null;
  const detected = detectFormat(bytes);
  if (bytes.length === 0) return { ok: false, detected: 'unknown', expected };
  if (expected === null) return { ok: false, detected, expected };
  const permitted = Array.isArray(expected) ? expected : [expected as DetectedFormat];
  return { ok: permitted.includes(detected), detected, expected };
}
