import { deflateSync, inflateSync } from "node:zlib";

/**
 * Just enough PNG to cut pictures out of the page pictures a PDF import
 * stores (lib/server/pdfImports.ts): reading 8-bit PNGs (as browsers'
 * canvases write them), cropping, scaling down, and writing RGBA PNGs.
 */

export type Bitmap = { width: number; height: number; data: Uint8Array };

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class PngError extends Error {}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode an 8-bit, non-interlaced PNG (gray, gray+alpha, RGB, RGBA or palette) to RGBA. */
export function decodePng(input: Uint8Array): Bitmap {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new PngError("Not a PNG file.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const chunks: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const kind = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (kind === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
    } else if (kind === "PLTE") palette = body;
    else if (kind === "tRNS") transparency = body;
    else if (kind === "IDAT") chunks.push(body);
    else if (kind === "IEND") break;
  }
  if (!width || !height) throw new PngError("The PNG has no size.");
  if (depth !== 8 || interlace !== 0) throw new PngError("Only 8-bit, non-interlaced PNGs can be read.");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels) throw new PngError("Unknown PNG color type.");
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new PngError("The PNG is cut short.");
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    const previous = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x]!;
      const left = x >= channels ? pixels[row + x - channels]! : 0;
      const up = y > 0 ? pixels[previous + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[previous + x - channels]! : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + left;
          break;
        case 2:
          out = value + up;
          break;
        case 3:
          out = value + ((left + up) >> 1);
          break;
        case 4:
          out = value + paeth(left, up, upLeft);
          break;
        default:
          throw new PngError("Unknown PNG filter.");
      }
      pixels[row + x] = out & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i += 1, j += channels) {
    const o = i * 4;
    if (type === 6) data.set(pixels.subarray(j, j + 4), o);
    else if (type === 2) {
      data[o] = pixels[j]!;
      data[o + 1] = pixels[j + 1]!;
      data[o + 2] = pixels[j + 2]!;
      data[o + 3] = 255;
    } else if (type === 0 || type === 4) {
      data[o] = data[o + 1] = data[o + 2] = pixels[j]!;
      data[o + 3] = type === 4 ? pixels[j + 1]! : 255;
    } else {
      const index = pixels[j]!;
      data[o] = palette?.[index * 3] ?? 0;
      data[o + 1] = palette?.[index * 3 + 1] ?? 0;
      data[o + 2] = palette?.[index * 3 + 2] ?? 0;
      data[o + 3] = transparency && index < transparency.length ? transparency[index]! : 255;
    }
  }
  return { width, height, data };
}

function chunk(kind: string, body: Uint8Array) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(kind, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Encode RGBA pixels as a PNG (RGB when every pixel is opaque). */
export function encodePng(bitmap: Bitmap): Uint8Array {
  const { width, height, data } = bitmap;
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    // The "up" filter: page pictures are mostly runs of the same color down the page.
    raw[row] = y === 0 ? 0 : 2;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      for (let c = 0; c < channels; c += 1) {
        const value = data[source + c]!;
        raw[row + 1 + x * channels + c] = y === 0 ? value : (value - data[source - width * 4 + c]!) & 0xff;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return new Uint8Array(Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0))]));
}

/** The pixels inside a rectangle (clamped to the picture). */
export function cropBitmap(bitmap: Bitmap, x: number, y: number, width: number, height: number): Bitmap {
  const left = Math.max(0, Math.min(bitmap.width - 1, Math.floor(x)));
  const top = Math.max(0, Math.min(bitmap.height - 1, Math.floor(y)));
  const right = Math.max(left + 1, Math.min(bitmap.width, Math.ceil(x + width)));
  const bottom = Math.max(top + 1, Math.min(bitmap.height, Math.ceil(y + height)));
  const out = new Uint8Array((right - left) * (bottom - top) * 4);
  for (let row = top; row < bottom; row += 1) {
    out.set(bitmap.data.subarray((row * bitmap.width + left) * 4, (row * bitmap.width + right) * 4), (row - top) * (right - left) * 4);
  }
  return { width: right - left, height: bottom - top, data: out };
}

/** Scale down by averaging the pixels each new pixel covers. */
export function shrinkBitmap(bitmap: Bitmap, width: number, height: number): Bitmap {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w >= bitmap.width && h >= bitmap.height) return bitmap;
  const out = new Uint8Array(w * h * 4);
  const sx = bitmap.width / w;
  const sy = bitmap.height / h;
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const i = (yy * bitmap.width + xx) * 4;
          const alpha = bitmap.data[i + 3]!;
          r += bitmap.data[i]! * alpha;
          g += bitmap.data[i + 1]! * alpha;
          b += bitmap.data[i + 2]! * alpha;
          a += alpha;
          n += 1;
        }
      }
      const o = (y * w + x) * 4;
      if (a) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, data: out };
}

/** The smallest rectangle holding everything that isn't (nearly) white or transparent, or null for a blank picture. */
export function inkBounds(bitmap: Bitmap, threshold = 245): { x: number; y: number; width: number; height: number } | null {
  let left = bitmap.width;
  let top = bitmap.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      const i = (y * bitmap.width + x) * 4;
      const blank = bitmap.data[i + 3]! < 10 || (bitmap.data[i]! >= threshold && bitmap.data[i + 1]! >= threshold && bitmap.data[i + 2]! >= threshold);
      if (blank) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
