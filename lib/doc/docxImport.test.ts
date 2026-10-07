import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { describe, it } from "node:test";

import { documentToDocx } from "./docx";
import { docxTitle, docxToDoc, DocxImportError, readDocx } from "./docxImport";
import { docToMarkdown, markdownToDoc } from "./markdown";
import { DEFAULT_SETTINGS, type DocumentMeta } from "./settings";
import { readZip, ZipError } from "@/lib/server/unzip";

const meta: DocumentMeta = { id: "d1", title: "Plan", createdAt: 0, updatedAt: 0, lastOpenedAt: 0, trashedAt: null, settings: DEFAULT_SETTINGS, wordCount: 0, preview: "" };

/** A ZIP with deflated entries, as Word writes them (Inline's own writer only stores). */
function deflatedZip(files: Record<string, string>) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, "utf8");
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function wordDocument(body: string, extra: Record<string, string> = {}) {
  return readZip(
    deflatedZip({
      "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
      "word/styles.xml": `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="MyHeading"><w:name w:val="My heading"/><w:basedOn w:val="Heading2"/></w:style></w:styles>`,
      "word/numbering.xml": `<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
      "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="hyperlink" Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"/><Relationship Id="rId10" Type="hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>`,
      "docProps/core.xml": `<cp:coreProperties xmlns:cp="x" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quarterly &amp; plan</dc:title></cp:coreProperties>`,
      ...extra,
    }),
  );
}

const p = (text: string, props = "", runProps = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}<w:r>${runProps ? `<w:rPr>${runProps}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

describe("reading Word documents", () => {
  it("round-trips a document Inline exported", async () => {
    const source = "# Plan {.title}\n\n## Goals\n\nIntro with **bold**, *italic*, ~~gone~~ and a [link](https://example.com).\n\n- one\n- two\n\n1. first\n2. second\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nCentered {align=center}";
    const docx = await documentToDocx(markdownToDoc(source), meta, async () => null);
    const doc = await docxToDoc(readZip(docx));
    const markdown = docToMarkdown(doc);
    for (const piece of ["# Plan {.title}", "## Goals", "**bold**", "*italic*", "~~gone~~", "[link](https://example.com)", "- one", "- two", "1. first", "2. second", "| A | B |", "| 1 | 2 |", "Centered {align=center}"]) {
      assert.ok(markdown.includes(piece), `${piece} in:\n${markdown}`);
    }
  });

  it("reads Word's styles, inherited heading styles, numbering, links and breaks from a deflated package", async () => {
    const parts = wordDocument(
      [
        p("Report", '<w:pStyle w:val="Title"/>'),
        p("Background", '<w:pStyle w:val="Heading1"/>'),
        p("Detail", '<w:pStyle w:val="MyHeading"/>'),
        p("Apple", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
        p("Seed", '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>'),
        p("Pear", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
        p("Third", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
        `<w:p><w:r><w:t>See </w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>the site</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:hyperlink r:id="rId10"><w:r><w:t>this</w:t></w:r></w:hyperlink><w:r><w:br/><w:t>next line</w:t></w:r></w:p>`,
        `<w:p><w:r><w:rPr><w:b/><w:u w:val="single"/><w:vertAlign w:val="superscript"/></w:rPr><w:t>up</w:t></w:r><w:r><w:rPr><w:highlight w:val="yellow"/><w:color w:val="C5221F"/></w:rPr><w:t>&lt;marked&gt;</w:t></w:r></w:p>`,
        `<w:p><w:r><w:br w:type="page"/></w:r><w:r><w:t>After the break</w:t></w:r></w:p>`,
        `<w:p><w:r><w:t>kept</w:t></w:r><w:del><w:r><w:delText>deleted</w:delText></w:r></w:del><w:ins><w:r><w:t> inserted</w:t></w:r></w:ins></w:p>`,
        "<w:p/>",
      ].join(""),
    );
    assert.equal(docxTitle(parts), "Quarterly & plan");
    const markdown = docToMarkdown(await docxToDoc(parts));
    assert.match(markdown, /^# Report \{\.title\}/);
    assert.match(markdown, /\n# Background\n/);
    assert.match(markdown, /\n## Detail\n/, "a custom style based on Heading 2 is a heading 2");
    assert.match(markdown, /- Apple\n {2}- Seed\n- Pear/);
    assert.match(markdown, /3\. Third/);
    assert.match(markdown, /\[the site\]\(https:\/\/example\.com\/a\?b=1&c=2\)/);
    assert.doesNotMatch(markdown, /javascript:/, "unsafe link targets are dropped, text kept");
    assert.match(markdown, / and this<br>next line/);
    assert.match(markdown, /<sup><u>\*\*up\*\*<\/u><\/sup>|\*\*<u><sup>up<\/sup><\/u>\*\*|up/);
    assert.match(markdown, /\\pagebreak\n\nAfter the break/);
    assert.match(markdown, /kept inserted/);
    assert.doesNotMatch(markdown, /deleted/);
    assert.doesNotMatch(markdown.trimEnd(), /&nbsp;$/, "Word's trailing empty paragraph is dropped");
  });

  it("hands embedded images to saveImage and keeps a picture set in a line of text in the line", async () => {
    const drawing = `<w:p><w:r><w:t>Logo:</w:t></w:r><w:r><w:drawing><wp:inline xmlns:wp="wp"><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="Picture" descr="Company logo"/><a:graphic xmlns:a="a"><a:graphicData><pic:pic xmlns:pic="pic"><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const parts = wordDocument(drawing, {
      "word/_rels/document.xml.rels": `<Relationships xmlns="x"><Relationship Id="rId5" Type="image" Target="media/image1.png"/></Relationships>`,
      "word/media/image1.png": "PNGDATA",
    });
    const saved: Array<[string, string]> = [];
    const doc = await docxToDoc(parts, {
      saveImage: async (data, mime) => {
        saved.push([Buffer.from(data).toString(), mime]);
        return "/api/uploads/abc.png";
      },
    });
    assert.deepEqual(saved, [["PNGDATA", "image/png"]]);
    assert.equal(doc.childCount, 1);
    const image = doc.child(0).child(1);
    assert.equal(image.type.name, "inline_image", "it follows the text, as Word shows it");
    assert.equal(image.attrs.src, "/api/uploads/abc.png");
    assert.equal(image.attrs.alt, "Company logo");
    assert.deepEqual([image.attrs.width, image.attrs.height], [100, 50]);
  });

  it("places a picture that is all its paragraph holds as a picture of its own", async () => {
    const drawing = `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline xmlns:wp="wp"><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="Picture" descr="Company logo"/><a:graphic xmlns:a="a"><a:graphicData><pic:pic xmlns:pic="pic"><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const parts = wordDocument(drawing, {
      "word/_rels/document.xml.rels": `<Relationships xmlns="x"><Relationship Id="rId5" Type="image" Target="media/image1.png"/></Relationships>`,
      "word/media/image1.png": "PNGDATA",
    });
    const doc = await docxToDoc(parts, { saveImage: async () => "/api/uploads/abc.png" });
    const image = doc.child(0);
    assert.equal(image.type.name, "image");
    assert.deepEqual([image.attrs.width, image.attrs.align], ["100px", "center"]);
  });

  it("reads Google Docs' page setup, body font, spacing and header into the settings", async () => {
    const sect = '<w:sectPr><w:headerReference w:type="default" r:id="rId20"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="1080" w:bottom="720" w:left="1080"/></w:sectPr>';
    const parts = readZip(
      deflatedZip({
        "word/document.xml": `<w:document ${W}><w:body>${p("Body")}${sect}</w:body></w:document>`,
        "word/styles.xml": `<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="480" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="normal"/></w:style></w:styles>`,
        "word/_rels/document.xml.rels": `<Relationships xmlns="x"><Relationship Id="rId20" Type="header" Target="header1.xml"/></Relationships>`,
        "word/header1.xml": `<w:hdr ${W}><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t xml:space="preserve">Smith </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:hdr>`,
      }),
    );
    const { settings, tabs } = await readDocx(parts);
    assert.equal(settings.fontFamily, '"Times New Roman", Times, serif');
    assert.equal(settings.fontSize, 12);
    assert.equal(settings.lineSpacing, 2);
    assert.equal(settings.paragraphSpacing, 0, "Word's default is no space after paragraphs");
    assert.deepEqual(settings.pageSetup.margins, { top: 0.5, right: 0.75, bottom: 0.5, left: 0.75 });
    assert.equal(settings.headerFooter.header, "Smith {page}");
    assert.equal(settings.headerFooter.headerAlign, "right");
    // The body font and size are the document's, so the text needs no marks for them.
    assert.deepEqual(tabs[0]!.doc.firstChild!.firstChild!.marks, []);
  });

  it("formats text the way Word's styles show it, and lays out paragraphs with their spacing and indents", async () => {
    const styles = `<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:color w:val="00AB44"/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:sz w:val="32"/></w:rPr></w:style></w:styles>`;
    const parts = readZip(
      deflatedZip({
        "word/document.xml": `<w:document ${W}><w:body>${[
          p("Green", '<w:pStyle w:val="Heading1"/>'),
          p("Plain heading", '<w:pStyle w:val="Heading2"/>'),
          p("Indented", '<w:spacing w:before="240" w:after="0"/><w:ind w:firstLine="720"/>'),
          p("Works cited", '<w:ind w:left="720" w:hanging="720"/>'),
          p("Calibri", "", '<w:rFonts w:ascii="Calibri"/><w:highlight w:val="yellow"/>'),
          p("Shaded", "", '<w:shd w:val="clear" w:fill="D9EAD3"/>'),
          `<w:p><w:r><w:pict><v:rect xmlns:v="v" xmlns:o="o" style="width:0;height:1.5pt" o:hr="t"/></w:pict></w:r></w:p>`,
        ].join("")}<w:sectPr/></w:body></w:document>`,
        "word/styles.xml": styles,
      }),
    );
    const doc = (await readDocx(parts)).tabs[0]!.doc;
    const marks = (index: number) => Object.fromEntries(doc.child(index).firstChild!.marks.map((mark) => [mark.type.name, mark.attrs.color ?? mark.attrs.size ?? mark.attrs.family ?? true]));
    assert.deepEqual(marks(0), { text_color: "#00ab44", font_size: "14pt" }, "a heading style's own size and color");
    assert.deepEqual(marks(1), {}, "Heading 2 at its usual 16pt needs no marks");
    assert.equal(doc.child(2).attrs.spaceBefore, 12);
    assert.equal(doc.child(2).attrs.textIndent, 0.5);
    assert.equal(doc.child(3).attrs.indent, 0);
    assert.equal(doc.child(3).attrs.textIndent, -0.5, "a hanging indent");
    assert.deepEqual(marks(4), { font_family: "Calibri, sans-serif", highlight: "#ffff00" });
    assert.deepEqual(marks(5), { highlight: "#d9ead3" }, "shading behind text is a highlight");
    assert.equal(doc.child(6).type.name, "horizontal_rule");
  });

  it("carries numbering on across an interruption and reads merged and shaded table cells", async () => {
    const cell = (text: string, props = "") => `<w:tc>${props ? `<w:tcPr>${props}</w:tcPr>` : ""}${p(text)}</w:tc>`;
    const parts = wordDocument(
      [
        p("Third", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
        p("A note between items"),
        p("Fourth", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
        `<w:tbl><w:tr>${cell("Tall", '<w:vMerge w:val="restart"/><w:shd w:fill="FCE5CD"/>')}${cell("B1")}</w:tr><w:tr>${cell("", "<w:vMerge/>")}${cell("B2")}</w:tr></w:tbl>`,
        p("After"),
      ].join(""),
    );
    const doc = await docxToDoc(parts);
    assert.equal(doc.child(0).attrs.order, 3);
    assert.equal(doc.child(2).attrs.order, 4, "the list goes on from 3 to 4");
    const table = doc.child(3);
    assert.equal(table.childCount, 2);
    assert.equal(table.child(0).child(0).attrs.rowspan, 2);
    assert.equal(table.child(0).child(0).attrs.background, "#fce5cd");
    assert.equal(table.child(1).childCount, 1, "the merged cell isn't repeated in the second row");
    // Word gets the merge back, and no empty paragraph is added between the table and the next one.
    const exported = new TextDecoder().decode(readZip(await documentToDocx(doc, meta, async () => null)).get("word/document.xml")!);
    assert.match(exported, /<w:vMerge w:val="restart"\/>/);
    assert.match(exported, /<w:vMerge\/><\/w:tcPr><w:p\/><\/w:tc>/);
    assert.match(exported, /<\/w:tbl><w:p><w:r><w:t xml:space="preserve">After/);
  });

  it("brings comments along, with replies in their thread", async () => {
    const comment = (id: string, author: string, date: string, text: string) => `<w:comment w:id="${id}" w:author="${author}" w:date="${date}"><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:comment>`;
    const parts = wordDocument(
      `<w:p><w:r><w:t xml:space="preserve">This is </w:t></w:r><w:commentRangeStart w:id="0"/><w:commentRangeStart w:id="1"/><w:r><w:t>difficult</w:t></w:r><w:commentRangeEnd w:id="0"/><w:commentRangeEnd w:id="1"/><w:r><w:t> to say.</w:t></w:r></w:p>`,
      { "word/comments.xml": `<w:comments ${W}>${comment("0", "Sam", "2023-10-30T02:15:27Z", "Rephrase?")}${comment("1", "Writer", "2023-10-31T09:00:00Z", "Done")}</w:comments>` },
    );
    const { tabs } = await readDocx(parts);
    const [thread] = tabs[0]!.comments;
    assert.equal(tabs[0]!.comments.length, 1);
    assert.equal(thread!.body, "Sam: Rephrase?");
    assert.equal(thread!.quote, "difficult");
    assert.deepEqual(thread!.replies.map((reply) => reply.body), ["Writer: Done"]);
    const marked = tabs[0]!.doc.firstChild!.child(1);
    assert.equal(marked.text, "difficult");
    assert.equal(marked.marks.find((mark) => mark.type.name === "comment")?.attrs.id, thread!.id);
  });

  it("splits a Google Doc's tabs, which Google writes as titled sections", async () => {
    const tabTitle = (text: string) => `<w:p><w:pPr><w:pStyle w:val="Title"/><w:sectPr/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const sectionEnd = (text: string) => `<w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const parts = wordDocument([tabTitle("Outline"), p("First tab"), sectionEnd("End of one"), tabTitle("Draft"), p("Second tab")].join(""));
    const { tabs } = await readDocx(parts);
    assert.deepEqual(tabs.map((tab) => tab.title), ["Outline", "Draft"]);
    assert.equal(docToMarkdown(tabs[0]!.doc).trim(), "First tab\n\nEnd of one");
    assert.equal(docToMarkdown(tabs[1]!.doc).trim(), "Second tab");
    // A document read as one keeps everything in order.
    assert.match(docToMarkdown(await docxToDoc(parts)), /Outline[\s\S]*First tab[\s\S]*Draft[\s\S]*Second tab/);
  });

  it("rejects files that aren't Word documents", async () => {
    assert.throws(() => readZip(new TextEncoder().encode("not a zip at all, just text")), ZipError);
    await assert.rejects(docxToDoc(readZip(deflatedZip({ "hello.txt": "hi" }))), DocxImportError);
  });
});
