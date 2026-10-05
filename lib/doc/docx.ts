import type { Mark, Node as PMNode } from "prosemirror-model";
import { cssSizeToPt } from "@/lib/doc/schema";
import { pageSize, type DocumentMeta } from "@/lib/doc/settings";
import { createZip, type ZipEntry } from "@/lib/doc/zip";

/**
 * Word (.docx) export. Produces a real WordprocessingML package with styles,
 * numbering, hyperlinks, tables, images, page setup and header/footer with
 * live page-number fields.
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
  numbering: Array<{ numId: number; abstract: number; start: number }>;
  nextDrawingId: number;
  contentWidthPx: number;
  loadImage: ImageLoader;
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
      case "bold":
        props.push("<w:b/>");
        break;
      case "italic":
        props.push("<w:i/>");
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
        props.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>');
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
        if (pt) props.push(`<w:sz w:val="${Math.round(pt * 2)}"/>`);
        break;
      }
      case "link":
        props.push('<w:rStyle w:val="Hyperlink"/>');
        break;
    }
  }
  // Word requires a fixed child order in rPr; sort by the schema order it expects.
  const order = ["rStyle", "rFonts", "b", "i", "strike", "color", "sz", "u", "shd", "vertAlign"];
  props.sort((a, b) => order.indexOf(a.match(/<w:(\w+)/)![1]!) - order.indexOf(b.match(/<w:(\w+)/)![1]!));
  const all = props.join("") + extra;
  return all ? `<w:rPr>${all}</w:rPr>` : "";
}

function textRun(text: string, marks: readonly Mark[]) {
  const parts = text.split("\t");
  const body = parts.map((part, i) => `${i > 0 ? "<w:tab/>" : ""}${part ? `<w:t xml:space="preserve">${xml(part)}</w:t>` : ""}`).join("");
  return `<w:r>${runProps(marks)}${body}</w:r>`;
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
    let run = "";
    if (child.isText) run = textRun(child.text ?? "", child.marks);
    else if (child.type.name === "hard_break") run = "<w:r><w:br/></w:r>";
    if (href && /^(https?:|mailto:)/i.test(href)) {
      if (!link) link = { href, runs: "" };
      link.runs += run;
    } else {
      out += run;
    }
  });
  flush();
  return out;
}

function paragraphProps(node: PMNode, options: { style?: string; numbering?: { numId: number; level: number }; indentTwips?: number; extra?: string } = {}) {
  const props: string[] = [];
  if (options.style) props.push(`<w:pStyle w:val="${options.style}"/>`);
  if (options.numbering) props.push(`<w:numPr><w:ilvl w:val="${options.numbering.level}"/><w:numId w:val="${options.numbering.numId}"/></w:numPr>`);
  if (options.extra) props.push(options.extra);
  const spacing: string[] = [];
  if (node.attrs.spaceBefore != null) spacing.push(`w:before="${Math.round(Number(node.attrs.spaceBefore) * 20)}"`);
  if (node.attrs.spaceAfter != null) spacing.push(`w:after="${Math.round(Number(node.attrs.spaceAfter) * 20)}"`);
  if (node.attrs.lineHeight) spacing.push(`w:line="${Math.round(Number(node.attrs.lineHeight) * 240)}" w:lineRule="auto"`);
  if (spacing.length) props.push(`<w:spacing ${spacing.join(" ")}/>`);
  const indent = (Number(node.attrs.indent) || 0) * 720 + (options.indentTwips ?? 0);
  if (indent) props.push(`<w:ind w:left="${indent}"/>`);
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

async function blockXml(node: PMNode, ctx: Context, list?: { numId: number; level: number }, indentTwips = 0): Promise<string> {
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
        ctx.numbering.push({ numId, abstract: node.type.name === "bullet_list" ? 1 : 2, start: Number(node.attrs.order) || 1 });
      }
      let out = "";
      for (let i = 0; i < node.childCount; i += 1) {
        const item = node.child(i);
        const checkbox = item.attrs.checked == null ? "" : item.attrs.checked ? "☑ " : "☐ ";
        for (let j = 0; j < item.childCount; j += 1) {
          const child = item.child(j);
          if (j === 0 && child.type.name === "paragraph") {
            out += `<w:p>${paragraphProps(child, { numbering: { numId, level } })}${await inlineContent(child, ctx, checkbox)}</w:p>`;
          } else if (child.type.name === "bullet_list" || child.type.name === "ordered_list") {
            out += await blockXml(child, ctx, { numId, level });
          } else {
            out += await blockXml(child, ctx, undefined, (level + 1) * 720);
          }
        }
      }
      return out;
    }
    case "table": {
      const columns = Math.max(1, ...Array.from({ length: node.childCount }, (_, r) => {
        let count = 0;
        node.child(r).forEach((cell) => {
          count += Number(cell.attrs.colspan) || 1;
        });
        return count;
      }));
      const gridWidth = Math.floor((ctx.contentWidthPx * 15) / columns);
      let out = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join("")}</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${gridWidth}"/>`).join("")}</w:tblGrid>`;
      for (let r = 0; r < node.childCount; r += 1) {
        const row = node.child(r);
        out += "<w:tr>";
        for (let c = 0; c < row.childCount; c += 1) {
          const cell = row.child(c);
          const span = Number(cell.attrs.colspan) || 1;
          const fill = cell.attrs.background ? colorHex(String(cell.attrs.background)) : cell.type.name === "table_header" ? "F3F4F6" : null;
          out += `<w:tc><w:tcPr><w:tcW w:w="${gridWidth * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ""}</w:tcPr>`;
          let inner = "";
          for (let k = 0; k < cell.childCount; k += 1) inner += await blockXml(cell.child(k), ctx);
          out += (inner || "<w:p/>") + "</w:tc>";
        }
        out += "</w:tr>";
      }
      return `${out}</w:tbl><w:p/>`;
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
  const heading = (level: number, pt: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${level <= 2 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${pt * 2}"/></w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:eastAsia="${font}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="${after}" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:sz w:val="52"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="5F6368"/><w:sz w:val="30"/></w:rPr></w:style>${heading(1, 20)}${heading(2, 16)}${heading(3, 14)}${heading(4, 12)}${heading(5, 11)}${heading(6, 11)}<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D0D7DE"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:color w:val="444444"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="19"/></w:rPr></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1A73E8"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:pPr><w:spacing w:after="0"/></w:pPr></w:style></w:styles>`;
}

function numberingXml(numbering: Context["numbering"]) {
  const levels = (format: "bullet" | "decimal") =>
    Array.from({ length: 9 }, (_, level) => {
      const bullets = ["•", "◦", "▪"];
      const text = format === "bullet" ? bullets[level % 3] : `%${level + 1}.`;
      const fmt = format === "bullet" ? "bullet" : ["decimal", "lowerLetter", "lowerRoman"][level % 3];
      return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
    }).join("");
  const nums = numbering
    .map((n) => `<w:num w:numId="${n.numId}"><w:abstractNumId w:val="${n.abstract}"/>${n.abstract === 2 ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${n.start}"/></w:lvlOverride>` : ""}</w:num>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels("bullet")}</w:abstractNum><w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="hybridMultilevel"/>${levels("decimal")}</w:abstractNum>${nums}</w:numbering>`;
}

export async function documentToDocx(doc: PMNode, meta: DocumentMeta, loadImage: ImageLoader): Promise<Uint8Array> {
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
  };
  let body = "";
  for (let i = 0; i < doc.childCount; i += 1) body += await blockXml(doc.child(i), ctx);

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

  const sectPr = `<w:sectPr><w:headerReference w:type="default" r:id="${headerRel}"/><w:footerReference w:type="default" r:id="${footerRel}"/>${firstHeaderRel ? `<w:headerReference w:type="first" r:id="${firstHeaderRel}"/>` : ""}${firstFooterRel ? `<w:footerReference w:type="first" r:id="${firstFooterRel}"/>` : ""}<w:pgSz w:w="${Math.round(size.width * TWIP)}" w:h="${Math.round(size.height * TWIP)}"${settings.pageSetup.orientation === "landscape" ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${Math.round(m.top * TWIP)}" w:right="${Math.round(m.right * TWIP)}" w:bottom="${Math.round(m.bottom * TWIP)}" w:left="${Math.round(m.left * TWIP)}" w:header="708" w:footer="708" w:gutter="0"/>${firstPage ? "<w:titlePg/>" : ""}</w:sectPr>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}${sectPr}</w:body></w:document>`;

  const rels = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
    ...ctx.rels.map((rel) => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${xml(rel.target)}"${rel.external ? ' TargetMode="External"' : ""}/>`),
  ].join("");

  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>${firstPage ? '<Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ""}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    },
    { name: "word/_rels/document.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>` },
    { name: "word/document.xml", data: documentXml },
    { name: "word/styles.xml", data: stylesXml(meta) },
    { name: "word/numbering.xml", data: numberingXml(ctx.numbering) },
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
