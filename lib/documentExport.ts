import { getPlainText } from "@/lib/pagination";
import { buildPdf } from "@/lib/pdf/pdfWriter";
import { snapshotPages } from "@/lib/pdf/pageSnapshot";

export type DocumentExportFormat = "txt" | "md" | "html" | "docx" | "pdf";

export function downloadDocument(editor: HTMLElement, title: string, format: DocumentExportFormat) {
  if (format === "pdf") {
    // PDF is drawn from the live paginated layout (papers, header/footer chrome), not a clone.
    const pages = editor.closest<HTMLElement>(".document") ?? editor;
    downloadBlob(`${fileName(title)}.pdf`, buildPdf(snapshotPages(pages, title)), "application/pdf");
    return;
  }
  const clone = editor.cloneNode(true) as HTMLElement;
  cleanReviewMarkup(clone);
  const baseName = fileName(title);
  if (format === "docx") {
    downloadBlob(`${baseName}.docx`, createDocx(clone, title), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    return;
  }
  const content = format === "html" ? htmlDocument(clone, title) : format === "md" ? toMarkdown(clone) : getPlainText(clone, true);
  const mime = format === "html" ? "text/html;charset=utf-8" : "text/plain;charset=utf-8";
  const extension = format === "html" ? "html" : format;
  downloadBlob(`${baseName}.${extension}`, content, mime);
}

function downloadBlob(name: string, content: BlobPart | BlobPart[], mime: string) {
  const blob = new Blob(Array.isArray(content) ? content : [content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function createDocx(root: HTMLElement, title: string) {
  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    },
    {
      name: "word/_rels/document.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
    },
    { name: "word/document.xml", data: wordDocument(root) },
    {
      name: "word/numbering.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
    },
    {
      name: "docProps/core.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title><dc:creator>Inline</dc:creator></cp:coreProperties>`,
    },
    {
      name: "docProps/app.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Inline</Application></Properties>`,
    },
  ];
  return makeZip(files.map((file) => ({ name: file.name, data: new TextEncoder().encode(file.data) })));
}

function wordDocument(root: HTMLElement) {
  const body = [...root.childNodes].map((node) => wordBlock(node)).join("") || paragraph("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
}

function wordBlock(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return paragraph(runs(node));
  if (!(node instanceof HTMLElement)) return [...node.childNodes].map(wordBlock).join("");
  if (node.tagName === "UL" || node.tagName === "OL") {
    const numId = node.tagName === "OL" ? 2 : 1;
    return [...node.children].map((item) => paragraph(runs(item), numId)).join("");
  }
  if (node.tagName === "TABLE") return wordTable(node);
  if (["DIV", "P", "H1", "H2", "H3", "LI"].includes(node.tagName)) {
    const style = node.tagName.startsWith("H") ? `Heading${node.tagName.slice(1)}` : "";
    return paragraph(runs(node), undefined, style);
  }
  return paragraph(runs(node));
}

function paragraph(content: string, numId?: number, style?: string) {
  const props = [
    style ? `<w:pStyle w:val="${style}"/>` : "",
    numId ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>` : "",
  ].join("");
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${content || "<w:r><w:t></w:t></w:r>"}</w:p>`;
}

function runs(node: Node, marks: { bold?: boolean; italic?: boolean; underline?: boolean } = {}): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (!text) return "";
    const props = `${marks.bold ? "<w:b/>" : ""}${marks.italic ? "<w:i/>" : ""}${marks.underline ? "<w:u w:val=\"single\"/>" : ""}`;
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
  }
  if (!(node instanceof HTMLElement)) return [...node.childNodes].map((child) => runs(child, marks)).join("");
  const next = {
    bold: marks.bold || node.tagName === "B" || node.tagName === "STRONG",
    italic: marks.italic || node.tagName === "I" || node.tagName === "EM",
    underline: marks.underline || node.tagName === "U",
  };
  return [...node.childNodes].map((child) => runs(child, next)).join("");
}

function wordTable(table: HTMLElement) {
  const rows = [...table.querySelectorAll("tr")].map((row) => `<w:tr>${[...row.children].map((cell) => `<w:tc>${paragraph(runs(cell))}</w:tc>`).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr>${rows}</w:tbl>`;
}

function xml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function makeZip(entries: Array<{ name: string; data: Uint8Array }>) {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length + entry.data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.data.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    chunks.push(local);

    const record = new Uint8Array(46 + name.length);
    const centralView = new DataView(record.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x800, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);
    offset += local.length;
  }
  const centralOffset = offset;
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  return concat([...chunks, ...central, end]);
}

function concat(parts: Uint8Array[]) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function cleanReviewMarkup(root: HTMLElement) {
  root.querySelectorAll("[data-page-break], [data-page-push], [data-caret-mark], .img-handle").forEach((node) => node.remove());
  root.querySelectorAll(".suggestion-del").forEach((node) => node.remove());
  root.querySelectorAll(".suggestion-add, .agent-edit, .comment-mark, .grammar-flash").forEach((node) => {
    node.replaceWith(...node.childNodes);
  });
}

function htmlDocument(root: HTMLElement, title: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:Arial,sans-serif;line-height:1.15;max-width:7in;margin:1in auto}h1{font-size:26pt}h2{font-size:16pt}h3{font-size:14pt}table{border-collapse:collapse;width:100%}td{border:1px solid #bbb;padding:6px 8px}</style></head><body>${root.innerHTML}</body></html>`;
}

function toMarkdown(root: HTMLElement) {
  const render = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return [...node.childNodes].map(render).join("");
    const content = [...node.childNodes].map(render).join("");
    switch (node.tagName) {
      case "H1": return `# ${content.trim()}\n\n`;
      case "H2": return `## ${content.trim()}\n\n`;
      case "H3": return `### ${content.trim()}\n\n`;
      case "STRONG":
      case "B": return `**${content}**`;
      case "EM":
      case "I": return `*${content}*`;
      case "U": return `<u>${content}</u>`;
      case "A": return `[${content}](${node.getAttribute("href") ?? ""})`;
      case "LI": return `- ${content.trim()}\n`;
      case "UL":
      case "OL": return `${content}\n`;
      case "BR": return "\n";
      case "P":
      case "DIV": return `${content.trim()}\n\n`;
      default: return content;
    }
  };
  return render(root).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function fileName(value: string) {
  const clean = value.replace(/[^a-z0-9-_ ]/gi, "").trim().replace(/\s+/g, "-");
  return clean || "untitled-document";
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
