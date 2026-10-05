import { inflateRawSync } from "node:zlib";

/**
 * Minimal ZIP reader (stored and deflated entries) for reading .docx
 * packages. Reads the central directory, so entries written with data
 * descriptors are handled too.
 */

export class ZipError extends Error {}

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export function readZip(data: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // The end-of-central-directory record sits in the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("Not a ZIP file.");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > data.length || view.getUint32(offset, true) !== 0x02014b50) throw new ZipError("Damaged ZIP directory.");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (size > MAX_ENTRY_BYTES) throw new ZipError("A file inside the ZIP is too large.");
    if (localOffset + 30 > data.length || view.getUint32(localOffset, true) !== 0x04034b50) throw new ZipError("Damaged ZIP entry.");
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const raw = data.subarray(start, start + compressedSize);
    if (method === 0) entries.set(name, raw);
    else if (method === 8) entries.set(name, new Uint8Array(inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES })));
    else throw new ZipError(`Unsupported ZIP compression (${method}).`);
  }
  return entries;
}
