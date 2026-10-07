import { createZip, type ZipEntry } from "@/lib/doc/zip";

/**
 * Word files written the way Google Docs (and so Google Takeout) writes them:
 * Google's own styles and numbering, Arial 11 at 1.15 with no space after
 * paragraphs, every paragraph and run spelling out its properties (nil
 * borders, rtl off, Arial set on each run), tabs as titled sections, comments
 * on the same text for replies, and horizontal lines as VML rules. The markup
 * (styles, numbering, properties) follows Google's own output so tests of the
 * importer see what it sees in practice; every word of text is a placeholder.
 */

const NS =
  'xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';

/** Google's styles.xml, as Takeout writes it. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:cs="Arial" w:eastAsia="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="table" w:styleId="TableNormal" w:default="1"><w:name w:val="TableNormal"/><w:tblPr><w:tblCellMar><w:top w:w="100.0" w:type="dxa"/><w:left w:w="100.0" w:type="dxa"/><w:bottom w:w="100.0" w:type="dxa"/><w:right w:w="100.0" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext w:val="1"/><w:keepLines w:val="1"/><w:pageBreakBefore w:val="0"/><w:spacing w:after="120" w:before="400" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext w:val="1"/><w:keepLines w:val="1"/><w:pageBreakBefore w:val="0"/><w:spacing w:after="120" w:before="360" w:lineRule="auto"/></w:pPr><w:rPr><w:b w:val="0"/><w:bCs w:val="0"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext w:val="1"/><w:keepLines w:val="1"/><w:pageBreakBefore w:val="0"/><w:spacing w:after="80" w:before="320" w:lineRule="auto"/></w:pPr><w:rPr><w:b w:val="0"/><w:bCs w:val="0"/><w:color w:val="434343"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext w:val="1"/><w:keepLines w:val="1"/><w:pageBreakBefore w:val="0"/><w:spacing w:after="80" w:before="280" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="666666"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext w:val="1"/><w:keepLines w:val="1"/><w:pageBreakBefore w:val="0"/><w:spacing w:after="80" w:before="240" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="666666"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext w:val="1"/><w:keepLines w:val="1"/><w:pageBreakBefore w:val="0"/><w:spacing w:after="80" w:before="240" w:lineRule="auto"/></w:pPr><w:rPr><w:i w:val="1"/><w:iCs w:val="1"/><w:color w:val="666666"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext w:val="1"/><w:keepLines w:val="1"/><w:pageBreakBefore w:val="0"/><w:spacing w:after="60" w:before="0" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext w:val="1"/><w:keepLines w:val="1"/><w:pageBreakBefore w:val="0"/><w:spacing w:after="320" w:before="0" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:cs="Arial" w:eastAsia="Arial" w:hAnsi="Arial"/><w:i w:val="0"/><w:iCs w:val="0"/><w:color w:val="666666"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style><w:style w:type="table" w:styleId="Table1"><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblStyleRowBandSize w:val="1"/><w:tblStyleColBandSize w:val="1"/></w:tblPr></w:style></w:styles>`;

/** Google's three list kinds: bullets (●○■), numbers, and capital letters. */
const LIST_FORMATS = { bullet: ["bullet", "●", "○", "■"], decimal: ["decimal"], upperLetter: ["upperLetter"], lowerRoman: ["lowerRoman"], upperRoman: ["upperRoman"], lowerLetter: ["lowerLetter"] } as const;
export const LIST = { bullet: 1, decimal: 2, upperLetter: 3, lowerRoman: 4, upperRoman: 5, lowerLetter: 6 } as const;

function numberingXml() {
  const lvl = (format: string, glyphs: readonly string[], level: number) => {
    const fmt = format === "bullet" ? "bullet" : level === 0 ? format : ["lowerLetter", "lowerRoman", "decimal"][(level - 1) % 3]!;
    const text = format === "bullet" ? glyphs[1 + (level % 3)]! : `%${level + 1}.`;
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr><w:rPr><w:u w:val="none"/></w:rPr></w:lvl>`;
  };
  const abstracts = Object.entries(LIST_FORMATS)
    .map(([name, glyphs], index) => `<w:abstractNum w:abstractNumId="${index + 1}">${Array.from({ length: 9 }, (_, level) => lvl(name, glyphs, level)).join("")}</w:abstractNum>`)
    .join("");
  const nums = Object.values(LIST).map((id) => `<w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}>${abstracts}${nums}</w:numbering>`;
}

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The properties Google repeats on every run. */
const RUN_NOISE = '<w:rtl w:val="0"/>';
/** ...and on every paragraph. */
const PARA_NOISE = '<w:keepNext w:val="0"/><w:keepLines w:val="0"/><w:pageBreakBefore w:val="0"/><w:widowControl w:val="1"/><w:pBdr><w:top w:space="0" w:sz="0" w:val="nil"/><w:left w:space="0" w:sz="0" w:val="nil"/><w:bottom w:space="0" w:sz="0" w:val="nil"/><w:right w:space="0" w:sz="0" w:val="nil"/><w:between w:space="0" w:sz="0" w:val="nil"/></w:pBdr><w:shd w:fill="auto" w:val="clear"/>';

let paraId = 0;

/** A run of text; `props` is raw rPr content such as `<w:b w:val="1"/>`. */
export function run(text: string, props = "") {
  // Google names the font on every run: Arial unless the run says otherwise.
  const font = props.includes("<w:rFonts") ? "" : '<w:rFonts w:ascii="Arial" w:cs="Arial" w:eastAsia="Arial" w:hAnsi="Arial"/>';
  return `<w:r w:rsidDel="00000000" w:rsidR="00000000" w:rsidRPr="00000000"><w:rPr>${font}${props}${props.includes("<w:rtl") ? "" : RUN_NOISE}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/** Arabic (or other right-to-left) text, as Google marks it. */
export function rtlRun(text: string) {
  return run(text, '<w:rtl w:val="1"/>');
}

/** A hyperlink in Google's link look (blue, underlined). */
export function link(text: string, rel: string) {
  return `<w:hyperlink r:id="${rel}">${run(text, '<w:color w:val="1155cc"/><w:u w:val="single"/>')}</w:hyperlink>`;
}

export type ParaOptions = {
  style?: "Title" | "Subtitle" | `Heading${1 | 2 | 3 | 4 | 5 | 6}`;
  align?: "center" | "right" | "both";
  /** Raw w:spacing attributes, e.g. `w:line="480" w:lineRule="auto"`. */
  spacing?: string;
  /** Raw w:ind attributes. */
  ind?: string;
  list?: { id: number; level?: number };
  /** Raw pPr content placed last, e.g. a sectPr. */
  extra?: string;
  /** A right-to-left paragraph. */
  rtl?: boolean;
  /** A line under the paragraph, or a box round it. */
  border?: "bottom" | "box";
};

/** A paragraph of runs (plain strings become plain runs), with Google's repeated properties. */
export function para(content: string | string[], options: ParaOptions = {}) {
  const runs = (Array.isArray(content) ? content : [content]).map((item) => (item.startsWith("<") ? item : run(item))).join("");
  const props = [
    options.style ? `<w:pStyle w:val="${options.style}"/>` : "",
    options.list ? `<w:numPr><w:ilvl w:val="${options.list.level ?? 0}"/><w:numId w:val="${options.list.id}"/></w:numPr>` : "",
    options.style || options.list ? PARA_NOISE : "",
    options.border ? `<w:pBdr>${(options.border === "box" ? ["top", "left", "bottom", "right"] : ["bottom"]).map((side) => `<w:${side} w:color="000000" w:space="1" w:sz="8" w:val="single"/>`).join("")}</w:pBdr>` : "",
    options.rtl ? '<w:bidi w:val="1"/>' : "",
    options.spacing ? `<w:spacing ${options.spacing}/>` : "",
    options.ind ? `<w:ind ${options.ind}/>` : "",
    options.align ? `<w:jc w:val="${options.align}"/>` : "",
    options.extra ?? "",
  ].join("");
  paraId += 1;
  return `<w:p w:rsidR="00000000" w:rsidDel="00000000" w:rsidP="00000000" w:rsidRDefault="00000000" w:rsidRPr="00000000" w14:paraId="${paraId.toString(16).padStart(8, "0")}"><w:pPr>${props}<w:rPr/></w:pPr>${runs}</w:p>`;
}

/** Google's horizontal line. */
export const horizontalRule = () => para(['<w:r><w:pict><v:rect style="width:0.0pt;height:1.5pt" o:hr="t" o:hrstd="t" o:hralign="center" fillcolor="#A0A0A0" stroked="f"/></w:pict></w:r>']);

/** Google's page break: a paragraph holding only the break. */
export const pageBreak = () => para(['<w:r><w:br w:type="page"/></w:r>']);

/** An inline picture, as Google embeds one. */
export function image(rel: string, widthPx: number, alt: string) {
  const cx = widthPx * 9525;
  return `<w:r><w:drawing><wp:inline distB="114300" distT="114300" distL="114300" distR="114300"><wp:extent cx="${cx}" cy="${cx}"/><wp:effectExtent b="0" l="0" r="0" t="0"/><wp:docPr id="1" name="image1.png" descr="${esc(alt)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr preferRelativeResize="0"/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:srcRect b="0" l="0" r="0" t="0"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cx}"/></a:xfrm><a:prstGeom prst="rect"/><a:ln/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

export type Cell = { text: string; fill?: string; span?: number; merge?: "restart" | "continue" };

/** A table as Google writes one: every row says it's not a header row. */
export function table(rows: Cell[][]) {
  const cells = (row: Cell[]) =>
    row
      .map((cell) => {
        const props = `${cell.span ? `<w:gridSpan w:val="${cell.span}"/>` : ""}${cell.merge ? `<w:vMerge${cell.merge === "restart" ? ' w:val="restart"' : ""}/>` : ""}${cell.fill ? `<w:shd w:fill="${cell.fill}" w:val="clear"/>` : ""}`;
        return `<w:tc><w:tcPr>${props}</w:tcPr>${para(cell.text ? [cell.text] : [], { spacing: 'w:after="0" w:line="240" w:lineRule="auto"' })}</w:tc>`;
      })
      .join("");
  const columns = Math.max(...rows.map((row) => row.reduce((sum, cell) => sum + (cell.span ?? 1), 0)));
  return `<w:tbl><w:tblPr><w:tblStyle w:val="Table1"/><w:tblW w:w="9360.0" w:type="dxa"/><w:jc w:val="left"/><w:tblLayout w:type="fixed"/><w:tblLook w:val="0600"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="3120"/>'.repeat(columns)}</w:tblGrid>${rows.map((row) => `<w:tr><w:trPr><w:cantSplit w:val="0"/><w:tblHeader w:val="0"/></w:trPr>${cells(row)}</w:tr>`).join("")}</w:tbl>`;
}

export const commentStart = (id: number) => `<w:commentRangeStart w:id="${id}"/>`;
export const commentEnd = (id: number) => `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`;

export type GoogleComment = { id: number; author: string; date: string; text: string };

/** A tab's name, as Google opens each tab: a Title paragraph that ends a section of its own. */
export function tabTitle(name: string) {
  return para(name, { style: "Title", extra: '<w:sectPr><w:pgSz w:h="15840" w:w="12240" w:orient="portrait"/><w:pgMar w:bottom="1440" w:top="1440" w:left="1440" w:right="1440" w:header="720" w:footer="720"/><w:pgNumType w:start="1"/></w:sectPr>' });
}

/** The last paragraph of a tab, which ends its section. */
export function tabEnd(content: string | string[]) {
  return para(content, { extra: '<w:sectPr><w:pgSz w:h="15840" w:w="12240" w:orient="portrait"/><w:pgMar w:bottom="1440" w:top="1440" w:left="1440" w:right="1440" w:header="720" w:footer="720"/><w:pgNumType w:start="1"/></w:sectPr>' });
}

export type GoogleDocOptions = {
  /** Hyperlink targets by relationship id. */
  links?: Record<string, string>;
  /** Images by relationship id. */
  images?: Record<string, Uint8Array>;
  comments?: GoogleComment[];
  /** Header text; "{page}" becomes a PAGE field. */
  header?: { text: string; align?: "left" | "center" | "right" };
  /** Page margins in twips. */
  margins?: { top: number; right: number; bottom: number; left: number };
};

/** A Google Docs .docx (a zipped package) holding `body`, the paragraphs and tables above. */
export function googleDocx(body: string[], options: GoogleDocOptions = {}): Uint8Array {
  const m = options.margins ?? { top: 1440, right: 1440, bottom: 1440, left: 1440 };
  const rels: string[] = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
  ];
  const entries: ZipEntry[] = [];
  for (const [id, target] of Object.entries(options.links ?? {})) rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(target)}" TargetMode="External"/>`);
  for (const [id, data] of Object.entries(options.images ?? {})) {
    rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${id}.png"/>`);
    entries.push({ name: `word/media/${id}.png`, data });
  }
  if (options.comments?.length) {
    rels.push('<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>');
    entries.push({
      name: "word/comments.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${NS}>${options.comments.map((c) => `<w:comment w:author="${esc(c.author)}" w:id="${c.id}" w:date="${c.date}">${para(c.text)}</w:comment>`).join("")}</w:comments>`,
    });
  }
  let headerRef = "";
  if (options.header) {
    rels.push('<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>');
    headerRef = '<w:headerReference w:type="default" r:id="rId4"/>';
    const runs = options.header.text
      .split(/(\{page\})/)
      .filter(Boolean)
      .map((part) => (part === "{page}" ? '<w:r><w:fldChar w:fldCharType="begin" w:dirty="0"/></w:r><w:r><w:instrText xml:space="preserve">PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate" w:dirty="0"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end" w:dirty="0"/></w:r>' : run(part)))
      .join("");
    entries.push({ name: "word/header1.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}><w:p><w:pPr><w:jc w:val="${options.header.align ?? "left"}"/></w:pPr>${runs}</w:p></w:hdr>` });
  }
  const sectPr = `<w:sectPr>${headerRef}<w:pgSz w:h="15840" w:w="12240" w:orient="portrait"/><w:pgMar w:bottom="${m.bottom}" w:top="${m.top}" w:left="${m.left}" w:right="${m.right}" w:header="720" w:footer="720"/><w:pgNumType w:start="1"/></w:sectPr>`;
  return createZip([
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: "word/document.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:background w:color="FFFFFF"/><w:body>${body.join("")}${sectPr}</w:body></w:document>` },
    { name: "word/styles.xml", data: STYLES },
    { name: "word/numbering.xml", data: numberingXml() },
    { name: "word/_rels/document.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>` },
    ...entries,
  ]);
}

/** A tiny real PNG (w × h pixels), so image sizes can be read. */
export function png(width: number, height: number) {
  const data = new Uint8Array(33);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(data.buffer).setUint32(16, width);
  new DataView(data.buffer).setUint32(20, height);
  return data;
}

/**
 * A document as plain JSON for comparing two reads of it: block ids dropped,
 * and comment ids replaced by their order of appearance.
 */
export function comparable(doc: { toJSON(): unknown }, commentOrder: string[] = []) {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "attrs" && value && typeof value === "object") {
        const { id, ...rest } = value as Record<string, unknown>;
        out.attrs = (node as { type?: string }).type === "comment" ? { id: `comment-${indexOf(commentOrder, String(id))}` } : rest;
        void id;
      } else out[key] = walk(value);
    }
    return out;
  };
  return walk(doc.toJSON());
}

function indexOf(order: string[], id: string) {
  if (!order.includes(id)) order.push(id);
  return order.indexOf(id);
}
