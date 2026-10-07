import { parseTrueType, type TrueTypeFont } from "@/lib/pdf/truetype";

// Minimal PDF writer. Pages are described in points with a top-left origin
// (y grows downward, like the DOM); the writer flips coordinates into PDF space.
// Text uses the standard 14 fonts with WinAnsi encoding, or a font the
// document carries (an imported document's own), embedded as a subset with
// a map back to Unicode so the text can still be searched and copied.

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

/**
 * `embedded` names one of the document's `fonts` to draw the text in (`font`
 * stands in where it lacks a character); `width` is how wide the page set the
 * text, which it is fitted to (the page kerns and joins ligatures).
 */
export type PdfText = { kind: "text"; x: number; y: number; text: string; font: StandardFont; size: number; color: RGB; embedded?: string; width?: number };
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
/** `fonts` holds TrueType or OpenType data by the names text items use. */
export type PdfDocumentModel = { title: string; pages: PdfPage[]; fonts?: Record<string, Uint8Array> };

/** Characters that draw nothing (zero-width spaces and joiners, direction marks, soft hyphens). */
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/gu;

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

  // The document's own fonts: which glyphs each draws (and what text they are), so each is subset once.
  type Embedded = { id: number; name: string; font: TrueTypeFont; glyphs: Map<number, string> };
  const embedded = new Map<string, Embedded | null>();
  const embeddedFont = (key: string): Embedded | null => {
    if (embedded.has(key)) return embedded.get(key)!;
    const data = model.fonts?.[key];
    const font = data ? parseTrueType(data) : null;
    const entry = font ? { id: reserve(), name: `E${embedded.size + 1}`, font, glyphs: new Map<number, string>() } : null;
    embedded.set(key, entry);
    return entry;
  };
  /** Glyph ids for the text in an embedded font, or null when it lacks a character (the standard font draws it then). */
  const shape = (entry: Embedded, text: string) => {
    const glyphs: Array<{ glyph: number; text: string }> = [];
    for (const char of text.replace(INVISIBLE, "")) {
      const glyph = entry.font.glyphFor(char.codePointAt(0)!);
      if (!glyph) return null;
      glyphs.push({ glyph, text: char });
    }
    return glyphs;
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
        const entry = item.embedded ? embeddedFont(item.embedded) : null;
        const glyphs = entry ? shape(entry, item.text) : null;
        if (entry && glyphs) {
          if (!glyphs.length) continue;
          for (const { glyph, text } of glyphs) if (!entry.glyphs.has(glyph)) entry.glyphs.set(glyph, text);
          const hex = glyphs.map(({ glyph }) => glyph.toString(16).padStart(4, "0")).join("");
          // Spread the difference from the page's width over the gaps between letters (its kerning and ligatures).
          const natural = glyphs.reduce((sum, { glyph }) => sum + entry.font.advance(glyph), 0) * (item.size / entry.font.unitsPerEm);
          const gap = item.width && glyphs.length > 1 && Math.abs(item.width - natural) < natural * 0.25 ? (item.width - natural) / (glyphs.length - 1) : 0;
          // Character spacing outlives the text object, so it is kept inside a saved state.
          ops.push(gap ? `q BT /${entry.name} ${num(item.size)} Tf ${color(item.color)} rg ${gap.toFixed(4)} Tc 1 0 0 1 ${num(item.x)} ${num(flip(item.y))} Tm <${hex}> Tj ET Q` : `BT /${entry.name} ${num(item.size)} Tf ${color(item.color)} rg 1 0 0 1 ${num(item.x)} ${num(flip(item.y))} Tm <${hex}> Tj ET`);
          continue;
        }
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
    const fonts = [...fontIds.values(), ...[...embedded.values()].filter((entry): entry is Embedded => Boolean(entry))].map((font) => `/${font.name} ${font.id} 0 R`).join(" ");
    define(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Contents ${contentId} 0 R` +
        ` /Resources << /Font << ${fonts} >>${images.length ? ` /XObject << ${images.join(" ")} >>` : ""} >>` +
        `${annots.length ? ` /Annots [${annots.map((id) => `${id} 0 R`).join(" ")}]` : ""} >>`,
    );
  });

  let tag = 0;
  for (const entry of embedded.values()) {
    if (!entry) continue;
    defineEmbeddedFont(entry, reserve, define, tag++);
  }

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

  push(embedded.size ? "%PDF-1.6\n" : "%PDF-1.4\n");
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

/**
 * A font the document carries, as a PDF composite font: glyphs by id
 * (Identity-H), their widths, the subset itself, and a ToUnicode map.
 */
function defineEmbeddedFont(
  entry: { id: number; font: TrueTypeFont; glyphs: Map<number, string> },
  reserve: () => number,
  define: (id: number, ...parts: Array<string | Uint8Array>) => void,
  index: number,
) {
  const { font, glyphs } = entry;
  const scale = 1000 / font.unitsPerEm;
  const used = [...glyphs.keys()].sort((a, b) => a - b);
  const prefix = Array.from({ length: 6 }, (_, i) => String.fromCharCode(65 + ((index * 7 + i * 3) % 26))).join("");
  const baseName = `${prefix}+${font.postScriptName}`;
  const program = font.subset(used);
  const fileId = reserve();
  const descriptorId = reserve();
  const cidId = reserve();
  const unicodeId = reserve();
  define(fileId, font.cff ? `<< /Subtype /OpenType /Length ${program.length} >>\nstream\n` : `<< /Length ${program.length} /Length1 ${program.length} >>\nstream\n`, program, "\nendstream");
  const flags = 32 + (font.italicAngle ? 64 : 0);
  define(
    descriptorId,
    `<< /Type /FontDescriptor /FontName /${baseName} /Flags ${flags} /FontBBox [${font.bbox.map((v) => Math.round(v * scale)).join(" ")}] /ItalicAngle ${num(font.italicAngle)}` +
      ` /Ascent ${Math.round(font.ascent * scale)} /Descent ${Math.round(font.descent * scale)} /CapHeight ${Math.round(font.capHeight * scale)} /StemV ${font.bold ? 120 : 80} /${font.cff ? "FontFile3" : "FontFile2"} ${fileId} 0 R >>`,
  );
  const widths = used.map((glyph) => `${glyph} [${Math.round(font.advance(glyph) * scale)}]`).join(" ");
  define(
    cidId,
    `<< /Type /Font /Subtype /${font.cff ? "CIDFontType0" : "CIDFontType2"} /BaseFont /${baseName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>` +
      ` /FontDescriptor ${descriptorId} 0 R /DW 1000 /W [${widths}]${font.cff ? "" : " /CIDToGIDMap /Identity"} >>`,
  );
  const utf16 = (text: string) => {
    let hex = "";
    for (let i = 0; i < text.length; i += 1) hex += text.charCodeAt(i).toString(16).padStart(4, "0");
    return hex;
  };
  const lines: string[] = [];
  for (let i = 0; i < used.length; i += 100) {
    const chunk = used.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`, ...chunk.map((glyph) => `<${glyph.toString(16).padStart(4, "0")}> <${utf16(glyphs.get(glyph)!)}>`), "endbfchar");
  }
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${lines.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  define(unicodeId, `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
  define(entry.id, `<< /Type /Font /Subtype /Type0 /BaseFont /${baseName} /Encoding /Identity-H /DescendantFonts [${cidId} 0 R] /ToUnicode ${unicodeId} 0 R >>`);
}
