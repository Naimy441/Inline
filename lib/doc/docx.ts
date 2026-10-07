import type { Mark, Node as PMNode } from "prosemirror-model";
import { cssSizeToPt, defaultListNumbering, MATH_LANGUAGE, schema, type ListNumbering } from "@/lib/doc/schema";
import { latexToOmml, OMML_NAMESPACE } from "@/lib/doc/omml";
import { pageSize, type DocComment, type DocumentMeta } from "@/lib/doc/settings";
import { createZip, type ZipEntry } from "@/lib/doc/zip";

/**
 * Word (.docx) export. Produces a real WordprocessingML package with styles,
 * numbering, hyperlinks, tables, images, page setup, header/footer with live
 * page-number fields and comments. A document with tabs is written the way
 * Google Docs writes one: each tab a section that starts with its name in the
 * Title style, so reading the file back (lib/doc/docxImport.ts) gives the
 * tabs again.
 */

export type ImageLoader = (src: string) => Promise<{ data: Uint8Array; mime: string } | null>;

const TWIP = 1440;
const EMU_PER_PX = 9525;

function xml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colorHex(value: string): string | null {
  const v = value.trim().toLowerCase();
  const hex = v.match(/^#([\da-f]{3}|[\da-f]{6})$/);
  if (hex) {
    const h = hex[1]!;
    return (h.length === 3 ? h.split("").map((c) => c + c).join("") : h).toUpperCase();
  }
  const rgb = v.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgb) return [rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase();
  const named: Record<string, string> = { red: "FF0000", blue: "0000FF", green: "008000", black: "000000", white: "FFFFFF", yellow: "FFFF00", orange: "FFA500", purple: "800080", gray: "808080", grey: "808080" };
  return named[v] ?? null;
}

function firstFont(family: string) {
  return family.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
}

type Context = {
  rels: Array<{ id: string; type: string; target: string; external?: boolean }>;
  media: ZipEntry[];
  images: Map<string, { rel: string; width: number; height: number }>;
  numbering: Array<{ numId: number; abstract: number; start: number; level: number; format?: ListNumbering }>;
  nextDrawingId: number;
  contentWidthPx: number;
  loadImage: ImageLoader;
  /** Inline comment id → the Word comment ids marked with it (the thread's first comment, then its replies). */
  commentIds: Map<string, number[]>;
  /** Comments whose range is open, in the order they opened. */
  openComments: string[];
};

function addRel(ctx: Context, type: string, target: string, external = false) {
  const id = `rId${ctx.rels.length + 10}`;
  ctx.rels.push({ id, type, target, external });
  return id;
}

function runProps(marks: readonly Mark[], extra = "") {
  const props: string[] = [];
  for (const mark of marks) {
    switch (mark.type.name) {
      // Word formats Arabic and other complex scripts from the *Cs twins, so each is set for both.
      case "bold":
        props.push("<w:b/>", "<w:bCs/>");
        break;
      case "italic":
        props.push("<w:i/>", "<w:iCs/>");
        break;
      case "underline":
        props.push('<w:u w:val="single"/>');
        break;
      case "strike":
        props.push("<w:strike/>");
        break;
      case "superscript":
        props.push('<w:vertAlign w:val="superscript"/>');
        break;
      case "subscript":
        props.push('<w:vertAlign w:val="subscript"/>');
        break;
      case "code":
        props.push('<w:rStyle w:val="InlineCode"/>');
        break;
      case "text_color": {
        const hex = colorHex(String(mark.attrs.color));
        if (hex) props.push(`<w:color w:val="${hex}"/>`);
        break;
      }
      case "highlight": {
        const hex = colorHex(String(mark.attrs.color)) ?? "FFF2A8";
        props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${hex}"/>`);
        break;
      }
      case "font_family": {
        const font = xml(firstFont(String(mark.attrs.family)));
        props.push(`<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>`);
        break;
      }
      case "font_size": {
        const pt = cssSizeToPt(String(mark.attrs.size));
        if (pt) props.push(`<w:sz w:val="${Math.round(pt * 2)}"/>`, `<w:szCs w:val="${Math.round(pt * 2)}"/>`);
        break;
      }
      case "link":
        props.push('<w:rStyle w:val="Hyperlink"/>');
        break;
    }
  }
  // Word requires a fixed child order in rPr; sort by the schema order it expects.
  const order = ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "strike", "color", "sz", "szCs", "u", "shd", "vertAlign"];
  props.sort((a, b) => order.indexOf(a.match(/<w:(\w+)/)![1]!) - order.indexOf(b.match(/<w:(\w+)/)![1]!));
  const all = props.join("") + extra;
  return all ? `<w:rPr>${all}</w:rPr>` : "";
}

/** Hebrew, Arabic, Syriac, Thaana and their presentation forms. */
const RTL_TEXT = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;

function textRun(text: string, marks: readonly Mark[]) {
  const parts = text.split("\t");
  const body = parts.map((part, i) => `${i > 0 ? "<w:tab/>" : ""}${part ? `<w:t xml:space="preserve">${xml(part)}</w:t>` : ""}`).join("");
  // Right-to-left script reads right to left in Word too.
  return `<w:r>${runProps(marks, RTL_TEXT.test(text) ? "<w:rtl/>" : "")}${body}</w:r>`;
}

/** Close the comment ranges that end before `marks` (all of them when it's null), and open the ones that start there. */
function commentMarkers(ctx: Context, marks: readonly Mark[] | null) {
  const here = new Set(marks ? marks.filter((mark) => mark.type.name === "comment" && ctx.commentIds.has(String(mark.attrs.id))).map((mark) => String(mark.attrs.id)) : []);
  let out = "";
  for (const id of [...ctx.openComments]) {
    if (here.has(id)) continue;
    for (const wordId of ctx.commentIds.get(id)!) out += `<w:commentRangeEnd w:id="${wordId}"/><w:r><w:commentReference w:id="${wordId}"/></w:r>`;
    ctx.openComments.splice(ctx.openComments.indexOf(id), 1);
  }
  for (const id of here) {
    if (ctx.openComments.includes(id)) continue;
    for (const wordId of ctx.commentIds.get(id)!) out += `<w:commentRangeStart w:id="${wordId}"/>`;
    ctx.openComments.push(id);
  }
  return out;
}

async function inlineContent(node: PMNode, ctx: Context, prefix = "") {
  let out = prefix ? `<w:r><w:t xml:space="preserve">${xml(prefix)}</w:t></w:r>` : "";
  let link: { href: string; runs: string } | null = null;
  const flush = () => {
    if (!link) return;
    const rel = addRel(ctx, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", link.href, true);
    out += `<w:hyperlink r:id="${rel}">${link.runs}</w:hyperlink>`;
    link = null;
  };
  node.forEach((child) => {
    const linkMark = child.marks.find((mark) => mark.type.name === "link");
    const href = linkMark ? String(linkMark.attrs.href) : null;
    if (link && link.href !== href) flush();
    // Comment ranges change only at text; a line break inside a comment doesn't end it.
    let run = child.isText ? commentMarkers(ctx, child.marks) : "";
    // An inline equation becomes a Word equation among the runs.
    if (child.isText && child.marks.some((mark) => mark.type.name === "math")) run += latexToOmml(child.text ?? "", false);
    else if (child.isText) run += textRun(child.text ?? "", child.marks);
    else if (child.type.name === "hard_break") run += "<w:r><w:br/></w:r>";
    if (href && /^(https?:|mailto:|tel:)/i.test(href)) {
      if (!link) link = { href, runs: "" };
      link.runs += run;
    } else {
      out += run;
    }
  });
  flush();
  return out;
}

function paragraphProps(node: PMNode, options: { style?: string; numbering?: { numId: number; level: number }; indentTwips?: number; extra?: string; spaceAfter?: number } = {}) {
  // As in Word, a right-to-left paragraph's "left" and "right" (alignment, indents) are its start and end.
  const props: string[] = [];
  if (options.style) props.push(`<w:pStyle w:val="${options.style}"/>`);
  if (options.numbering) props.push(`<w:numPr><w:ilvl w:val="${options.numbering.level}"/><w:numId w:val="${options.numbering.numId}"/></w:numPr>`);
  if (node.attrs.dir === "rtl") props.push("<w:bidi/>");
  if (options.extra) props.push(options.extra);
  const spacing: string[] = [];
  if (node.attrs.spaceBefore != null) spacing.push(`w:before="${Math.round(Number(node.attrs.spaceBefore) * 20)}"`);
  const after = node.attrs.spaceAfter ?? options.spaceAfter;
  if (after != null) spacing.push(`w:after="${Math.round(Number(after) * 20)}"`);
  if (node.attrs.lineHeight) spacing.push(`w:line="${Math.round(Number(node.attrs.lineHeight) * 240)}" w:lineRule="auto"`);
  if (spacing.length) props.push(`<w:spacing ${spacing.join(" ")}/>`);
  const textIndent = Number(node.attrs.textIndent) || 0;
  const indent = (Number(node.attrs.indent) || 0) * 720 + (options.indentTwips ?? 0) + (textIndent < 0 ? Math.round(-textIndent * 1440) : 0);
  const first = textIndent > 0 ? ` w:firstLine="${Math.round(textIndent * 1440)}"` : textIndent < 0 ? ` w:hanging="${Math.round(-textIndent * 1440)}"` : "";
  if (indent || first) props.push(`<w:ind w:left="${indent}"${first}/>`);
  const align = node.attrs.align as string | undefined;
  if (align && align !== "left") props.push(`<w:jc w:val="${align === "justify" ? "both" : align}"/>`);
  return props.length ? `<w:pPr>${props.join("")}</w:pPr>` : "";
}

async function imageParagraph(node: PMNode, ctx: Context) {
  const src = String(node.attrs.src || "");
  let entry = ctx.images.get(src);
  if (!entry) {
    const loaded = await ctx.loadImage(src).catch(() => null);
    if (!loaded) return `<w:p><w:r><w:t xml:space="preserve">${xml(`[Image: ${node.attrs.alt || src}]`)}</w:t></w:r></w:p>`;
    const size = imageSize(loaded.data) ?? { width: 400, height: 300 };
    const ext = loaded.mime.includes("png") ? "png" : loaded.mime.includes("gif") ? "gif" : "jpeg";
    const name = `media/image${ctx.media.length + 1}.${ext}`;
    ctx.media.push({ name: `word/${name}`, data: loaded.data });
    const rel = addRel(ctx, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", name);
    entry = { rel, width: size.width, height: size.height };
    ctx.images.set(src, entry);
  }
  let width = entry.width;
  const requested = String(node.attrs.width ?? "");
  if (requested.endsWith("%")) width = (ctx.contentWidthPx * Number.parseFloat(requested)) / 100;
  else if (requested.endsWith("px")) width = Number.parseFloat(requested);
  width = Math.min(width, ctx.contentWidthPx);
  const height = (entry.height / entry.width) * width;
  const cx = Math.round(width * EMU_PER_PX);
  const cy = Math.round(height * EMU_PER_PX);
  const id = ctx.nextDrawingId++;
  const align = node.attrs.align === "left" ? "left" : node.attrs.align === "right" ? "right" : "center";
  return `<w:p><w:pPr><w:jc w:val="${align}"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${xml(String(node.attrs.alt || ""))}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${entry.rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/**
 * `next` is the block after this one in its container (null when it's the
 * last), so a table is followed by the empty paragraph Word needs only when
 * nothing else separates it from the next table or the end of a cell.
 */
/** `list` is the list this block sits in; `depth` counts its numbered lists, which decides their marker style as on the page. */
async function blockXml(node: PMNode, ctx: Context, list?: { numId: number; level: number; depth: number }, indentTwips = 0, next?: PMNode | null): Promise<string> {
  switch (node.type.name) {
    case "paragraph":
      return `<w:p>${paragraphProps(node, { numbering: list, indentTwips })}${await inlineContent(node, ctx)}</w:p>`;
    case "title":
      return `<w:p>${paragraphProps(node, { style: "Title" })}${await inlineContent(node, ctx)}</w:p>`;
    case "subtitle":
      return `<w:p>${paragraphProps(node, { style: "Subtitle" })}${await inlineContent(node, ctx)}</w:p>`;
    case "heading":
      return `<w:p>${paragraphProps(node, { style: `Heading${node.attrs.level}`, indentTwips })}${await inlineContent(node, ctx)}</w:p>`;
    case "blockquote": {
      let out = "";
      for (let i = 0; i < node.childCount; i += 1) {
        const child = node.child(i);
        if (child.isTextblock) {
          out += `<w:p>${paragraphProps(child, { style: "Quote", indentTwips: indentTwips })}${await inlineContent(child, ctx)}</w:p>`;
        } else {
          out += await blockXml(child, ctx, undefined, indentTwips + 720);
        }
      }
      return out;
    }
    case "code_block":
      if (node.attrs.language === MATH_LANGUAGE) return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${latexToOmml(node.textContent, true)}</w:p>`;
      return node.textContent
        .split("\n")
        .map((line) => `<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr>${textRun(line, [])}</w:p>`)
        .join("");
    case "horizontal_rule":
      return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>';
    case "page_break":
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    case "image":
      return imageParagraph(node, ctx);
    case "bullet_list":
    case "ordered_list": {
      const level = list ? Math.min(8, list.level + 1) : 0;
      let numId: number;
      if (list && level > 0 && node.type.name === "bullet_list" && ctx.numbering.find((n) => n.numId === list.numId)?.abstract === 1) {
        numId = list.numId;
      } else {
        numId = ctx.numbering.length + 1;
        const ordered = node.type.name === "ordered_list";
        ctx.numbering.push({ numId, abstract: ordered ? 2 : 1, start: Number(node.attrs.order) || 1, level, ...(ordered ? { format: (node.attrs.numbering as ListNumbering | null) ?? defaultListNumbering(list?.depth ?? 0) } : {}) });
      }
      let out = "";
      for (let i = 0; i < node.childCount; i += 1) {
        const item = node.child(i);
        const checkbox = item.attrs.checked == null ? "" : item.attrs.checked ? "☑ " : "☐ ";
        for (let j = 0; j < item.childCount; j += 1) {
          const child = item.child(j);
          if (j === 0 && child.type.name === "paragraph") {
            // The page gives list items 2pt after them (li > p), whatever the document's paragraph spacing.
            out += `<w:p>${paragraphProps(child, { numbering: { numId, level }, spaceAfter: 2 })}${await inlineContent(child, ctx, checkbox)}</w:p>`;
          } else if (child.type.name === "bullet_list" || child.type.name === "ordered_list") {
            out += await blockXml(child, ctx, { numId, level, depth: (list?.depth ?? 0) + (node.type.name === "ordered_list" ? 1 : 0) });
          } else {
            out += await blockXml(child, ctx, undefined, (level + 1) * 720);
          }
        }
      }
      return out;
    }
    case "table": {
      // Cells merged down from rows above take up columns too (Word writes them as vMerge continuations).
      const below = new Map<string, { span: number }>();
      const occupied = Array.from({ length: node.childCount }, () => 0);
      node.forEach((row, _offset, r) => {
        row.forEach((cell) => {
          const span = Number(cell.attrs.colspan) || 1;
          const rows = Math.min(Number(cell.attrs.rowspan) || 1, node.childCount - r);
          for (let k = 0; k < rows; k += 1) occupied[r + k]! += span;
        });
      });
      const columns = Math.max(1, ...occupied);
      const gridWidth = Math.floor((ctx.contentWidthPx * 15) / columns);
      let out = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join("")}</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${gridWidth}"/>`).join("")}</w:tblGrid>`;
      const continuation = (span: number) => `<w:tc><w:tcPr><w:tcW w:w="${gridWidth * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}<w:vMerge/></w:tcPr><w:p/></w:tc>`;
      for (let r = 0; r < node.childCount; r += 1) {
        const row = node.child(r);
        const header = row.childCount > 0 && Array.from({ length: row.childCount }, (_, c) => row.child(c)).every((cell) => cell.type.name === "table_header");
        out += header ? "<w:tr><w:trPr><w:tblHeader/></w:trPr>" : "<w:tr>";
        let col = 0;
        const fillMerged = () => {
          for (let merged = below.get(`${r}:${col}`); merged; merged = below.get(`${r}:${col}`)) {
            out += continuation(merged.span);
            col += merged.span;
          }
        };
        for (let c = 0; c < row.childCount; c += 1) {
          fillMerged();
          const cell = row.child(c);
          const span = Number(cell.attrs.colspan) || 1;
          const rows = Math.min(Number(cell.attrs.rowspan) || 1, node.childCount - r);
          for (let k = 1; k < rows; k += 1) below.set(`${r + k}:${col}`, { span });
          const fill = cell.attrs.background ? colorHex(String(cell.attrs.background)) : cell.type.name === "table_header" ? "F3F4F6" : null;
          out += `<w:tc><w:tcPr><w:tcW w:w="${gridWidth * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}${rows > 1 ? '<w:vMerge w:val="restart"/>' : ""}${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ""}</w:tcPr>`;
          let inner = "";
          for (let k = 0; k < cell.childCount; k += 1) {
            const block = await blockXml(cell.child(k), ctx, undefined, 0, k + 1 < cell.childCount ? cell.child(k + 1) : null);
            // Header cells are bold on the page.
            inner += cell.type.name === "table_header" ? block.replace(/<w:p>(?!<w:pPr><w:pStyle)(<w:pPr>)?/g, (_match, pPr) => (pPr ? '<w:p><w:pPr><w:pStyle w:val="TableHeading"/>' : '<w:p><w:pPr><w:pStyle w:val="TableHeading"/></w:pPr>')) : block;
          }
          out += (inner || "<w:p/>") + "</w:tc>";
          col += span;
        }
        fillMerged();
        out += "</w:tr>";
      }
      return `${out}</w:tbl>${next === undefined || next === null || next.type.name === "table" ? "<w:p/>" : ""}`;
    }
    default:
      return "";
  }
}

function headerFooterXml(kind: "hdr" | "ftr", text: string, align: string, pageNumber: { align: string } | null) {
  const runs: string[] = [];
  const parts = text.split(/(\{page\}|\{pages\})/i);
  for (const part of parts) {
    if (/^\{page\}$/i.test(part)) runs.push('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>');
    else if (/^\{pages\}$/i.test(part)) runs.push('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>');
    else if (part) runs.push(`<w:r><w:t xml:space="preserve">${xml(part)}</w:t></w:r>`);
  }
  let paragraphs = runs.length ? `<w:p><w:pPr><w:jc w:val="${align}"/></w:pPr>${runs.join("")}</w:p>` : "";
  if (pageNumber) {
    paragraphs += `<w:p><w:pPr><w:jc w:val="${pageNumber.align}"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  }
  if (!paragraphs) paragraphs = "<w:p/>";
  const tag = kind === "hdr" ? "w:hdr" : "w:ftr";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${tag} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${paragraphs}</${tag}>`;
}

function stylesXml(meta: DocumentMeta) {
  const s = meta.settings;
  const font = xml(firstFont(s.fontFamily));
  const size = Math.round(s.fontSize * 2);
  const line = Math.round(s.lineSpacing * 240);
  const after = Math.round(s.paragraphSpacing * 20);
  // Headings look as they do on the page (app/styles/document.css): regular weight, Google Docs' sizes, spacing and greys.
  const heading = (level: number, pt: number, before: number, after: number, color?: string) =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${before * 20}" w:after="${after * 20}" w:line="288" w:lineRule="auto"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr>${level === 6 ? "<w:i/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}<w:sz w:val="${pt * 2}"/></w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:eastAsia="${font}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="${after}" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="60" w:line="276" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="52"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="320"/></w:pPr><w:rPr><w:color w:val="666666"/><w:sz w:val="30"/></w:rPr></w:style>${heading(1, 20, 20, 6)}${heading(2, 16, 18, 6)}${heading(3, 14, 16, 4, "434343")}${heading(4, 12, 14, 4, "666666")}${heading(5, 11, 12, 4, "666666")}${heading(6, 11, 12, 4, "666666")}<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D0D7DE"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:color w:val="555555"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="19"/></w:rPr></w:style><w:style w:type="character" w:styleId="InlineCode"><w:name w:val="HTML Code"/><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/></w:rPr></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1A73E8"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableHeading"><w:name w:val="Table Heading"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:pPr><w:spacing w:after="0"/></w:pPr></w:style></w:styles>`;
}

function numberingXml(numbering: Context["numbering"]) {
  const levels = (format: "bullet" | "decimal") =>
    Array.from({ length: 9 }, (_, level) => {
      const bullets = ["•", "◦", "▪"];
      const text = format === "bullet" ? bullets[level % 3] : `%${level + 1}.`;
      const fmt = format === "bullet" ? "bullet" : ["decimal", "lowerLetter", "lowerRoman"][level % 3];
      return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
    }).join("");
  // Each numbered list states its marker style at its level, so Word numbers it as the page does.
  const formats: Record<ListNumbering, string> = { decimal: "decimal", "lower-alpha": "lowerLetter", "upper-alpha": "upperLetter", "lower-roman": "lowerRoman", "upper-roman": "upperRoman" };
  const nums = numbering
    .map((n) => {
      if (n.abstract !== 2) return `<w:num w:numId="${n.numId}"><w:abstractNumId w:val="${n.abstract}"/></w:num>`;
      const lvl = `<w:lvl w:ilvl="${n.level}"><w:start w:val="${n.start}"/><w:numFmt w:val="${formats[n.format ?? "decimal"]}"/><w:lvlText w:val="%${n.level + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (n.level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
      return `<w:num w:numId="${n.numId}"><w:abstractNumId w:val="2"/><w:lvlOverride w:ilvl="${n.level}"><w:startOverride w:val="${n.start}"/>${lvl}</w:lvlOverride></w:num>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels("bullet")}</w:abstractNum><w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="hybridMultilevel"/>${levels("decimal")}</w:abstractNum>${nums}</w:numbering>`;
}

/** One tab of a document, for a file holding all of them. */
export type DocxTab = { title: string; doc: PMNode; comments?: DocComment[] };

const COMMENTS_EXTENDED = "http://schemas.microsoft.com/office/word/2012/wordml";

function commentIdsIn(doc: PMNode) {
  const ids = new Set<string>();
  doc.descendants((node) => {
    for (const mark of node.marks) if (mark.type.name === "comment") ids.add(String(mark.attrs.id));
  });
  return ids;
}

/** Word comments for Inline's threads: each reply is a comment of its own, linked to the first in commentsExtended.xml. */
function commentsXml(threads: DocComment[], ids: Map<string, number[]>) {
  let comments = "";
  let extended = "";
  let paraId = 0;
  for (const thread of threads) {
    const wordIds = ids.get(thread.id)!;
    let parent: string | null = null;
    [thread, ...thread.replies].forEach((comment, index) => {
      const lines = comment.body.split("\n");
      const id = (++paraId).toString(16).toUpperCase().padStart(8, "0");
      // Inline shows everyone's comments as yours; Claude's stay Claude's.
      const author = comment.author === "claude" ? "Claude" : "You";
      comments += `<w:comment w:id="${wordIds[index]}" w:author="${author}" w:initials="${author[0]}" w:date="${new Date(comment.createdAt).toISOString().replace(/\.\d+Z$/, "Z")}">${lines.map((line, n) => `<w:p${n === lines.length - 1 ? ` w14:paraId="${id}"` : ""}><w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`).join("")}</w:comment>`;
      extended += `<w15:commentEx w15:paraId="${id}"${parent ? ` w15:paraIdParent="${parent}"` : ""} w15:done="${thread.resolved ? 1 : 0}"/>`;
      parent ??= id;
    });
  }
  return {
    comments: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">${comments}</w:comments>`,
    extended: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="${COMMENTS_EXTENDED}">${extended}</w15:commentsEx>`,
  };
}

/**
 * A document as a Word file: one document (with its comments), or every tab
 * of one, each tab a section headed by its name.
 */
export async function documentToDocx(content: PMNode | DocxTab[], meta: DocumentMeta, loadImage: ImageLoader, comments: DocComment[] = []): Promise<Uint8Array> {
  const settings = meta.settings;
  const size = pageSize(settings.pageSetup);
  const m = settings.pageSetup.margins;
  const ctx: Context = {
    rels: [],
    media: [],
    images: new Map(),
    numbering: [],
    nextDrawingId: 1,
    contentWidthPx: (size.width - m.left - m.right) * 96,
    loadImage,
    commentIds: new Map(),
    openComments: [],
  };
  const tabs: DocxTab[] = Array.isArray(content) ? content : [{ title: "", doc: content, comments }];
  const split = tabs.length > 1;
  // Only comments whose text is in the file can be shown in Word.
  const threads: DocComment[] = [];
  let nextCommentId = 0;
  for (const tab of tabs) {
    const marked = commentIdsIn(tab.doc);
    for (const thread of tab.comments ?? []) {
      if (!marked.has(thread.id) || ctx.commentIds.has(thread.id)) continue;
      ctx.commentIds.set(thread.id, [thread, ...thread.replies].map(() => nextCommentId++));
      threads.push(thread);
    }
  }
  const geometry = `<w:pgSz w:w="${Math.round(size.width * TWIP)}" w:h="${Math.round(size.height * TWIP)}"${settings.pageSetup.orientation === "landscape" ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${Math.round(m.top * TWIP)}" w:right="${Math.round(m.right * TWIP)}" w:bottom="${Math.round(m.bottom * TWIP)}" w:left="${Math.round(m.left * TWIP)}" w:header="708" w:footer="708" w:gutter="0"/>`;
  let body = "";
  const sectionEnd = schema.nodes.paragraph!.create();
  for (const [t, tab] of tabs.entries()) {
    const last = t === tabs.length - 1;
    // Google Docs' layout for a tab: its name as a section of its own on a new page, then its text running on from there.
    if (split) body += `<w:p><w:pPr><w:pStyle w:val="Title"/><w:sectPr>${geometry}</w:sectPr></w:pPr>${textRun(tab.title, [])}</w:p>`;
    const doc = tab.doc;
    for (let i = 0; i < doc.childCount; i += 1) body += await blockXml(doc.child(i), ctx, undefined, 0, i + 1 < doc.childCount ? doc.child(i + 1) : last ? null : sectionEnd);
    body += commentMarkers(ctx, null).replace(/^(.+)$/, "<w:p>$1</w:p>");
    if (!last) body += `<w:p><w:pPr><w:sectPr><w:type w:val="continuous"/>${geometry}</w:sectPr></w:pPr></w:p>`;
  }

  const hf = settings.headerFooter;
  const pn = settings.pageNumbers;
  const headerRel = addRel(ctx, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header", "header1.xml");
  const footerRel = addRel(ctx, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer", "footer1.xml");
  const firstPage = hf.differentFirstPage || pn.skipFirst;
  const firstHeaderRel = firstPage ? addRel(ctx, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header", "header2.xml") : null;
  const firstFooterRel = firstPage ? addRel(ctx, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer", "footer2.xml") : null;
  const pageNumberIn = (where: "header" | "footer") => (pn.enabled && pn.position === where ? { align: pn.align } : null);
  const title = (text: string) => text.replace(/\{title\}/gi, meta.title).replace(/\{date\}/gi, new Date().toLocaleDateString());
  const firstHeaderText = hf.differentFirstPage ? hf.firstHeader : hf.header;
  const firstFooterText = hf.differentFirstPage ? hf.firstFooter : hf.footer;

  const sectPr = `<w:sectPr><w:headerReference w:type="default" r:id="${headerRel}"/><w:footerReference w:type="default" r:id="${footerRel}"/>${firstHeaderRel ? `<w:headerReference w:type="first" r:id="${firstHeaderRel}"/>` : ""}${firstFooterRel ? `<w:footerReference w:type="first" r:id="${firstFooterRel}"/>` : ""}${split ? '<w:type w:val="continuous"/>' : ""}${geometry}${firstPage ? "<w:titlePg/>" : ""}</w:sectPr>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:m="${OMML_NAMESPACE}"><w:body>${body}${sectPr}</w:body></w:document>`;

  const commentParts = threads.length ? commentsXml(threads, ctx.commentIds) : null;
  const rels = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
    ...(commentParts
      ? [
          '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>',
          '<Relationship Id="rId4" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>',
        ]
      : []),
    ...ctx.rels.map((rel) => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${xml(rel.target)}"${rel.external ? ' TargetMode="External"' : ""}/>`),
  ].join("");

  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>${firstPage ? '<Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ""}${commentParts ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>' : ""}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    },
    { name: "word/_rels/document.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>` },
    { name: "word/document.xml", data: documentXml },
    { name: "word/styles.xml", data: stylesXml(meta) },
    { name: "word/numbering.xml", data: numberingXml(ctx.numbering) },
    ...(commentParts
      ? [
          { name: "word/comments.xml", data: commentParts.comments },
          { name: "word/commentsExtended.xml", data: commentParts.extended },
        ]
      : []),
    { name: "word/header1.xml", data: headerFooterXml("hdr", title(hf.header), hf.headerAlign, pageNumberIn("header")) },
    { name: "word/footer1.xml", data: headerFooterXml("ftr", title(hf.footer), hf.footerAlign, pageNumberIn("footer")) },
    ...(firstPage
      ? [
          { name: "word/header2.xml", data: headerFooterXml("hdr", title(firstHeaderText), hf.headerAlign, pn.skipFirst ? null : pageNumberIn("header")) },
          { name: "word/footer2.xml", data: headerFooterXml("ftr", title(firstFooterText), hf.footerAlign, pn.skipFirst ? null : pageNumberIn("footer")) },
        ]
      : []),
    {
      name: "docProps/core.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(meta.title)}</dc:title><dc:creator>Inline</dc:creator><dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified></cp:coreProperties>`,
    },
    ...ctx.media,
  ];
  return createZip(entries);
}

/** Pixel size of PNG, JPEG or GIF data. */
export function imageSize(data: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length > 24 && data[0] === 0x89 && data[1] === 0x50) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (data.length > 10 && data[0] === 0x47 && data[1] === 0x49) return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) return null;
      const marker = data[offset + 1]!;
      const length = view.getUint16(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}
