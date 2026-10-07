import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { documentToDocx } from "@/lib/doc/docx";
import { readDocx, type EmbeddedFont } from "@/lib/doc/docxImport";
import { docToMarkdown, markdownToDoc } from "@/lib/doc/markdown";
import { replaceTopLevelBlocks } from "@/lib/doc/merge";
import type { DocumentMeta, DocumentSettings } from "@/lib/doc/settings";
import { buildPdf } from "@/lib/pdf/pdfWriter";
import { readZip } from "@/lib/server/unzip";
import { Transform } from "prosemirror-transform";
import { comparable, googleDocx, para, png, run } from "./support/googleDocx";

/**
 * A résumé laid out the way Google Docs lays one out: a font the file
 * carries, tight line spacing, tab stops, lines under headings, empty
 * spacer paragraphs, icons in a line of text and bullets with their own
 * indents. It reads in as Google shows it and comes back the same from
 * Inline's Word copy.
 */

const crimson = (props = "") => `<w:rFonts w:ascii="Crimson Text" w:cs="Crimson Text" w:eastAsia="Crimson Text" w:hAnsi="Crimson Text"/><w:sz w:val="17"/>${props}`;
const spacing = 'w:before="0" w:line="237.6" w:lineRule="auto"';
const fontData = new Uint8Array(96).map((_, i) => (i < 4 ? [0, 1, 0, 0][i]! : i));
const icon = `<w:r><w:drawing><wp:inline distB="114300" distT="114300" distL="114300" distR="114300"><wp:extent cx="64008" cy="64008"/><wp:docPr id="1" name="i"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId20"><a:alphaModFix amt="60000"/></a:blip></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1980" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Noto Sans Symbols" w:hAnsi="Noto Sans Symbols"/><w:b w:val="1"/><w:sz w:val="22"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;

function resume() {
  return googleDocx(
    [
      para([icon, run("Durham, NC", crimson())], { spacing, align: "center" }),
      para([], { spacing, mark: '<w:sz w:val="4"/>' }),
      para([run("EDUCATION", crimson('<w:b w:val="1"/><w:sz w:val="22"/>')), '<w:r><w:rPr><w:rFonts w:ascii="Crimson Text" w:hAnsi="Crimson Text"/><w:sz w:val="24"/></w:rPr><w:tab/></w:r>'], {
        spacing,
        extra: '<w:pBdr><w:bottom w:color="000000" w:space="1" w:sz="6" w:val="single"/></w:pBdr>',
      }),
      para([run("DUKE UNIVERSITY", crimson('<w:b w:val="1"/>')), `<w:r><w:rPr>${crimson()}</w:rPr><w:tab/></w:r>`, run("Aug 2024", crimson('<w:i w:val="1"/>'))], {
        spacing,
        tabs: '<w:tab w:val="left" w:pos="1134"/><w:tab w:val="right" w:pos="11343.000000000002"/>',
      }),
      para([run("Built a CPU emulator with a test suite for validation.", crimson())], { spacing, align: "both", list: { id: 1 }, ind: 'w:left="284" w:hanging="270"' }),
      para([run("Shipped two mobile apps used by thousands of students.", crimson())], { spacing, align: "both", list: { id: 1 }, ind: 'w:left="284" w:hanging="270"' }),
    ],
    { images: { rId20: png(16, 16) }, fonts: [{ family: "Crimson Text", data: fontData, key: "4A1B2C3D-5E6F-7081-92A3-B4C5D6E7F809" }], numbering: NUMBERING, margins: { top: 144, right: 720, bottom: 144, left: 720 } },
  );
}

const saveImage = async () => "/api/uploads/icon.png";
const loadImage = async () => ({ data: png(16, 16), mime: "image/png" });
const meta = (settings: DocumentSettings): DocumentMeta => ({ id: "d", title: "Resume", createdAt: 0, updatedAt: 0, lastOpenedAt: 0, trashedAt: null, settings, wordCount: 0, preview: "" });

describe("a Google Docs résumé", () => {
  test("its normal text is what the text uses, laid out as Google lays it out", async () => {
    const { settings } = await readDocx(readZip(resume()), { saveImage });
    assert.equal(settings.fontFamily, '"Crimson Text", serif', "not Google's unused Calibri default");
    assert.equal(settings.fontSize, 8.5);
    assert.equal(settings.lineSpacing, 0.99);
    assert.equal(settings.lineModel, "font");
  });

  test("icons stay in their line, lines under headings and tab stops are kept, empty lines keep their size", async () => {
    const doc = (await readDocx(readZip(resume()), { saveImage })).tabs[0]!.doc;
    const icon = doc.child(0).firstChild!;
    assert.equal(icon.type.name, "inline_image");
    assert.deepEqual([icon.attrs.width, icon.attrs.height, icon.attrs.opacity, icon.attrs.dist], [7, 7, 0.6, [2, 2, 2, 2]], "Google draws 2px round it, whatever the file says");
    assert.equal(doc.child(1).attrs.fontSize, 2);
    assert.deepEqual(doc.child(2).attrs.borders, { bottom: { style: "solid", width: 0.75, space: 1, color: null } });
    assert.deepEqual(doc.child(3).attrs.tabs, [{ pos: 56.7, align: "left" }, { pos: 567.15, align: "right" }]);
    const list = doc.child(4);
    assert.deepEqual([list.attrs.indent, list.attrs.hanging, list.attrs.marker], [14.2, 13.5, { text: "•", bold: true }], "Google draws the bullet in the item's font and size");
  });

  test("the fonts the file carries are handed over, unobfuscated", async () => {
    const fonts: EmbeddedFont[] = [];
    await readDocx(readZip(resume()), { saveImage, saveFont: async (font) => void fonts.push(font) });
    assert.equal(fonts.length, 1);
    assert.equal(fonts[0]!.family, "Crimson Text");
    assert.deepEqual([...fonts[0]!.data], [...fontData]);
  });

  test("Inline's Word copy reads back as the same document, carrying its font", async () => {
    const imported = await readDocx(readZip(resume()), { saveImage });
    const doc = imported.tabs[0]!.doc;
    const file = await documentToDocx(doc, meta(imported.settings), loadImage, [], async () => [{ family: "Crimson Text", bold: false, italic: false, data: fontData }]);
    const parts = readZip(file);
    const xml = new TextDecoder().decode(parts.get("word/document.xml")!);
    assert.match(xml, /<w:tabs><w:tab w:val="left" w:pos="1134"\/><w:tab w:val="right" w:pos="11343"\/><\/w:tabs>/);
    assert.match(xml, /<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"\/><\/w:pBdr>/);
    assert.match(xml, /<a:alphaModFix amt="60000"\/>/);
    const fonts: EmbeddedFont[] = [];
    const again = await readDocx(parts, { saveImage, saveFont: async (font) => void fonts.push(font) });
    assert.deepEqual(again.settings, imported.settings);
    assert.deepEqual(comparable(again.tabs[0]!.doc), comparable(doc));
    assert.deepEqual([...fonts[0]!.data], [...fontData], "obfuscated in the file, the same once read");
  });

  test("Claude's edits through Markdown keep icons, tabs at a line's end and list indents", async () => {
    const doc = (await readDocx(readZip(resume()), { saveImage })).tabs[0]!.doc;
    const markdown = docToMarkdown(doc);
    assert.match(markdown, /!\[\]\(\/api\/uploads\/icon\.png\)Durham, NC/);
    assert.match(markdown, /\*\*EDUCATION\*\*&#9;/);
    const edited = markdownToDoc(markdown.replace("Durham, NC", "Durham, North Carolina"));
    const tr = new Transform(doc);
    replaceTopLevelBlocks(tr, 0, doc.childCount, Array.from({ length: edited.childCount }, (_, i) => edited.child(i)));
    assert.deepEqual(tr.doc.child(0).firstChild!.attrs, doc.child(0).firstChild!.attrs, "the icon keeps its size and fade");
    assert.equal(tr.doc.child(2).textContent, "EDUCATION\t");
    assert.deepEqual(tr.doc.child(4).attrs.marker, doc.child(4).attrs.marker);
  });

  test("Markdown writes bold or italic that * can't open as HTML", () => {
    const doc = markdownToDoc("**HackDuke<em>: 1st Place,</em> Odyssey**");
    const again = docToMarkdown(doc);
    assert.equal(again, "**HackDuke<em>: 1st Place,</em> Odyssey**");
    assert.equal(markdownToDoc(again).textContent, "HackDuke: 1st Place, Odyssey");
  });
});

describe("PDFs carry the document's own fonts", () => {
  test("text in an embedded font is a subset font with its text mapped back to Unicode", () => {
    const font = new Uint8Array(readFileSync("node_modules/katex/dist/fonts/KaTeX_Main-Regular.ttf"));
    const pdf = Buffer.from(
      buildPdf({
        title: "Fonts",
        fonts: { main: font },
        pages: [{ width: 612, height: 792, items: [{ kind: "text", x: 72, y: 72, text: "Hi​there", font: "Times-Roman", size: 10, color: [0, 0, 0], embedded: "main", width: 30 }] }],
      }),
    ).toString("latin1");
    assert.match(pdf, /\/Subtype \/Type0 \/BaseFont \/[A-Z]{6}\+KaTeX_Main-Regular \/Encoding \/Identity-H/);
    assert.match(pdf, /\/FontFile2 \d+ 0 R/);
    assert.match(pdf, /beginbfchar/);
    assert.match(pdf, /Tc 1 0 0 1 72 720 Tm <[0-9a-f]{28}> Tj ET Q/, "seven letters (the zero-width space draws nothing), fitted to the page's width");
    assert.ok(pdf.length < font.length, "only the glyphs used are kept");
  });
});
