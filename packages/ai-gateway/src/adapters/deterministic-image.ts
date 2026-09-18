import { deflateSync } from 'node:zlib';

/**
 * A DETERMINISTIC PNG, DRAWN FROM A FINGERPRINT.
 *
 * WHY THIS EXISTS. The Creative Studio must prove the whole path — request,
 * metering, an asset in the library, that asset used in a post, a failure, a
 * retry — and it must do so with no real image provider, which is Phase 10
 * (D-13). A mock that returned a url would prove nothing: nothing could be
 * stored, nothing could be attached, and the half of the product that matters
 * would be untested until a vendor was chosen.
 *
 * SO THE MOCK RETURNS REAL BYTES. Not a photograph and never pretending to be
 * one: a small abstract composition in the brand palette, derived entirely from
 * the request's own fingerprint, so the same prompt at the same size always
 * produces the same file. That determinism is what makes a screenshot, a
 * checksum and a duplicate-upload test mean the same thing twice.
 *
 * NO DEPENDENCY. PNG is a container around zlib, and Node ships zlib. Adding an
 * image library to the gateway to draw four rectangles would put a decoder in
 * the package whose whole point is that it contains no provider code.
 *
 * WHAT IT IS NOT. It is not an image model, it is not a renderer for customer
 * artwork, and nothing outside a development or test environment should ever
 * serve one of these to a customer as though a model had made it. The Creative
 * Studio records `AssetSource.AI_GENERATED` and the provider that produced it,
 * so a file from this function is always identifiable as what it is.
 */

/** The approved palette. Purple leads; yellow is an accent (CLAUDE.md §4). */
const PALETTE: readonly (readonly [number, number, number])[] = [
  [0x79, 0x35, 0xfe],
  [0x53, 0x12, 0xc4],
  [0xff, 0xdd, 0x15],
  [0xf0, 0xe9, 0xff],
  [0x17, 0x15, 0x28],
  [0xb0, 0x8c, 0xff],
];

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A 32-bit mixer, so one fingerprint yields many independent choices.
 *
 * Not cryptography and not trying to be: it turns a hex digest into a stable
 * stream of small numbers. The only property that matters is that it is the
 * same stream every time.
 */
function* stream(seed: string): Generator<number, never, void> {
  let state = 0x811c9dc5;
  for (const char of seed) {
    state = Math.imul(state ^ char.charCodeAt(0), 0x01000193) >>> 0;
  }
  for (;;) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    yield state;
  }
}

export interface DeterministicImage {
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/png';
  readonly width: number;
  readonly height: number;
}

/**
 * Draw one.
 *
 * `size` is `<width>x<height>`, the same string the gateway's image input
 * carries. An unparseable or absurd size falls back to a square rather than
 * throwing: the mock is a test double, and failing to draw would turn a size
 * typo into an AI failure the customer has to read.
 */
export function deterministicPng(seed: string, size: string): DeterministicImage {
  const [width, height] = parseSize(size);
  const random = stream(seed);

  const base = PALETTE[next(random, PALETTE.length)] as readonly [number, number, number];
  const accent = PALETTE[next(random, PALETTE.length)] as readonly [number, number, number];
  // Two soft bands and one accent block: enough composition to read as
  // deliberate artwork at any size, cheap enough to draw a hundred times.
  const bandAt = next(random, height);
  const blockX = next(random, Math.max(1, width - width / 3));
  const blockY = next(random, Math.max(1, height - height / 3));
  const blockW = Math.max(1, Math.floor(width / 3));
  const blockH = Math.max(1, Math.floor(height / 3));

  // Raw scanlines: one filter byte (0 = None) then RGB triples.
  const raw = new Uint8Array(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const gradient = (x / Math.max(1, width - 1)) * 0.55 + (y / Math.max(1, height - 1)) * 0.25;
      const inBand = Math.abs(y - bandAt) < Math.max(2, height / 24);
      const inBlock = x >= blockX && x < blockX + blockW && y >= blockY && y < blockY + blockH;
      const source = inBlock || inBand ? accent : base;
      const lift = inBlock ? 0 : gradient;
      raw[offset] = mix(source[0], lift);
      raw[offset + 1] = mix(source[1], lift);
      raw[offset + 2] = mix(source[2], lift);
      offset += 3;
    }
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    // Level 9 so the output is byte-identical across runs and machines.
    chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw), { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }

  return { bytes, mimeType: 'image/png', width, height };
}

function mix(channel: number, lift: number): number {
  // Toward white, never past it.
  return Math.max(0, Math.min(255, Math.round(channel + (255 - channel) * lift)));
}

function next(random: Generator<number, never, void>, bound: number): number {
  const value = random.next().value;
  return Math.floor((value / 0x100000000) * Math.max(1, Math.floor(bound)));
}

/** `<width>x<height>`, clamped to something a test double should ever draw. */
function parseSize(size: string): readonly [number, number] {
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(size.trim());
  if (!match) return [512, 512];
  const width = clamp(Number(match[1]));
  const height = clamp(Number(match[2]));
  return [width, height];
}

function clamp(value: number): number {
  if (!Number.isFinite(value) || value < 16) return 512;
  // 2048 is generous for a mock and keeps one call from allocating 100 MB.
  return Math.min(2_048, Math.floor(value));
}
