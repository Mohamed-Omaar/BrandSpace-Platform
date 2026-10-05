import { deflateSync } from 'node:zlib';

/**
 * A GRADIENT PICTURE, as PNG bytes — the parity fixture's post covers.
 *
 * The prototype's "photos" are CSS gradients (`Main.dc.html` line 2288:
 * `linear-gradient(160deg, #6b4128 0%, #b8794a 45%, #e9c79a 100%)` and its
 * siblings). The comparison workspace gives its posts real image files drawn
 * from the same stops, so a card's cover is a real asset served the real way
 * and the pair compares the card, not a text post against a picture.
 *
 * Test fixtures only: written by `seed-parity.ts`, never by the product.
 */
export interface GradientStop {
  readonly at: number;
  readonly hex: string;
}

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), Buffer.from(data)]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, tail]);
}

/** CSS `linear-gradient(<angle>deg, …)` over a `width` × `height` picture. */
export function gradientPng(
  width: number,
  height: number,
  angleDeg: number,
  stops: readonly GradientStop[],
): Buffer {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  // The CSS gradient line's length, so 0% and 100% land on the corners.
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  const colours = stops.map((stop) => ({ at: stop.at, c: rgb(stop.hex) }));
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const t = Math.min(
        1,
        Math.max(0, ((x - width / 2) * dx + (y - height / 2) * dy + half) / (2 * half)),
      );
      let index = 1;
      while (index < colours.length - 1 && (colours[index]?.at ?? 1) < t) index += 1;
      const from = colours[index - 1];
      const to = colours[index] ?? from;
      const span = to && from ? to.at - from.at : 0;
      const f = span > 0 && from ? (t - from.at) / span : 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const a = from?.c[channel] ?? 0;
        const b = to?.c[channel] ?? a;
        raw[offset] = Math.round(a + (b - a) * Math.min(1, Math.max(0, f)));
        offset += 1;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}
