// Minimal PDF 1.4 writer. Pages are described in points with a top-left origin
// (y grows downward, like the DOM); the writer flips coordinates into PDF space.
// Text uses the standard 14 fonts with WinAnsi encoding, so nothing is embedded.

export type StandardFont =
  | "Helvetica"
  | "Helvetica-Bold"
  | "Helvetica-Oblique"
  | "Helvetica-BoldOblique"
  | "Times-Roman"
  | "Times-Bold"
  | "Times-Italic"
  | "Times-BoldItalic"
  | "Courier"
  | "Courier-Bold"
  | "Courier-Oblique"
  | "Courier-BoldOblique";

export type RGB = [number, number, number];

export type PdfText = { kind: "text"; x: number; y: number; text: string; font: StandardFont; size: number; color: RGB };
export type PdfRect = { kind: "rect"; x: number; y: number; width: number; height: number; fill: RGB };
export type PdfLine = { kind: "line"; x1: number; y1: number; x2: number; y2: number; width: number; color: RGB };
export type PdfImage = {
  kind: "image";
  x: number;
  y: number;
  width: number;
  height: number;
  jpeg: Uint8Array;
  pixelWidth: number;
  pixelHeight: number;
  /** Black-on-white ink rendered as a picture (an equation), not a photo. */
  ink?: boolean;
};
export type PdfLink = { kind: "link"; x: number; y: number; width: number; height: number; uri: string };
export type PdfItem = PdfText | PdfRect | PdfLine | PdfImage | PdfLink;

export type PdfPage = { width: number; height: number; items: PdfItem[] };
export type PdfDocumentModel = { title: string; pages: PdfPage[] };

const WIN_ANSI_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

const FALLBACKS: Record<string, string> = {
  "\u2009": " ", "\u202f": " ", "\u2212": "-", "\u2010": "-", "\u2011": "-",
  "\u25e6": "o", "\u25aa": "\u2022", "\u25cf": "\u2022", "\u2192": "->", "\u2190": "<-", "\u2032": "'", "\u2033": "\"",
};

/** Encodes text as WinAnsi bytes; characters outside it degrade to a close ASCII form or "?". */
export function winAnsiBytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      bytes.push(code);
    } else if (WIN_ANSI_HIGH[code]) {
      bytes.push(WIN_ANSI_HIGH[code]);
    } else if (FALLBACKS[char]) {
      bytes.push(...winAnsiBytes(FALLBACKS[char]));
    } else {
      const stripped = char.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
      if (stripped && stripped !== char && [...stripped].every((c) => c.codePointAt(0)! < 0x100)) bytes.push(...winAnsiBytes(stripped));
      else if (code >= 0x20) bytes.push(0x3f);
    }
  }
  return bytes;
}

function pdfString(text: string) {
  let out = "(";
  for (const byte of winAnsiBytes(text)) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 0x20 || byte > 0x7e) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

/** UTF-16BE hex string, used for metadata such as the document title. */
function pdfTextString(text: string) {
  let hex = "FEFF";
  for (let i = 0; i < text.length; i += 1) hex += text.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `<${hex}>`;
}

function num(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function color(rgb: RGB) {
  return rgb.map((channel) => num(Math.min(1, Math.max(0, channel)))).join(" ");
}

type PdfObject = { id: number; parts: Array<string | Uint8Array> };

export function buildPdf(model: PdfDocumentModel): Uint8Array<ArrayBuffer> {
  const objects: PdfObject[] = [];
  let nextId = 1;
  const reserve = () => nextId++;
  const define = (id: number, ...parts: Array<string | Uint8Array>) => objects.push({ id, parts });

  const catalogId = reserve();
  const pagesId = reserve();
  const infoId = reserve();

  const fontIds = new Map<StandardFont, { id: number; name: string }>();
  const fontRef = (font: StandardFont) => {
    let entry = fontIds.get(font);
    if (!entry) {
      entry = { id: reserve(), name: `F${fontIds.size + 1}` };
      fontIds.set(font, entry);
      define(entry.id, `<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`);
    }
    return entry.name;
  };

  const pageIds: number[] = [];
  model.pages.forEach((page) => {
    const pageId = reserve();
    const contentId = reserve();
    pageIds.push(pageId);
    const ops: string[] = [];
    const images: string[] = [];
    const annots: number[] = [];
    const flip = (y: number) => page.height - y;

    for (const item of page.items) {
      if (item.kind === "rect") {
        ops.push(`${color(item.fill)} rg ${num(item.x)} ${num(flip(item.y + item.height))} ${num(item.width)} ${num(item.height)} re f`);
      } else if (item.kind === "line") {
        ops.push(`${color(item.color)} RG ${num(item.width)} w ${num(item.x1)} ${num(flip(item.y1))} m ${num(item.x2)} ${num(flip(item.y2))} l S`);
      } else if (item.kind === "text") {
        if (!item.text) continue;
        const name = fontRef(item.font);
        ops.push(`BT /${name} ${num(item.size)} Tf ${color(item.color)} rg 1 0 0 1 ${num(item.x)} ${num(flip(item.y))} Tm ${pdfString(item.text)} Tj ET`);
      } else if (item.kind === "image") {
        const imageId = reserve();
        const name = `Im${imageId}`;
        images.push(`/${name} ${imageId} 0 R`);
        define(
          imageId,
          `<< /Type /XObject /Subtype /Image /Width ${item.pixelWidth} /Height ${item.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${item.jpeg.length} >>\nstream\n`,
          item.jpeg,
          "\nendstream",
        );
        ops.push(`q ${num(item.width)} 0 0 ${num(item.height)} ${num(item.x)} ${num(flip(item.y + item.height))} cm /${name} Do Q`);
      } else if (item.kind === "link") {
        const annotId = reserve();
        annots.push(annotId);
        const rect = [item.x, flip(item.y + item.height), item.x + item.width, flip(item.y)].map(num).join(" ");
        define(annotId, `<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(item.uri)} >> >>`);
      }
    }

    const content = ops.join("\n");
    define(contentId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const fonts = [...fontIds.values()].map((font) => `/${font.name} ${font.id} 0 R`).join(" ");
    define(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Contents ${contentId} 0 R` +
        ` /Resources << /Font << ${fonts} >>${images.length ? ` /XObject << ${images.join(" ")} >>` : ""} >>` +
        `${annots.length ? ` /Annots [${annots.map((id) => `${id} 0 R`).join(" ")}]` : ""} >>`,
    );
  });

  define(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  define(pagesId, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  define(infoId, `<< /Title ${pdfTextString(model.title)} /Producer (Inline) /Creator (Inline) >>`);

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (part: string | Uint8Array) => {
    // Content is ASCII apart from image data, so string length equals byte length.
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes);
    offset += bytes.length;
  };

  push("%PDF-1.4\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const offsets = new Array<number>(nextId).fill(0);
  objects.sort((a, b) => a.id - b.id);
  for (const object of objects) {
    offsets[object.id] = offset;
    push(`${object.id} 0 obj\n`);
    object.parts.forEach(push);
    push("\nendobj\n");
  }
  const xrefOffset = offset;
  push(`xref\n0 ${nextId}\n0000000000 65535 f \n`);
  for (let id = 1; id < nextId; id += 1) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${nextId} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const result = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    result.set(chunk, at);
    at += chunk.length;
  }
  return result;
}
