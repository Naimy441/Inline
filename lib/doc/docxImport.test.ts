import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { describe, it } from "node:test";

import { documentToDocx } from "./docx";
import { docxTitle, docxToDoc, DocxImportError } from "./docxImport";
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

  it("hands embedded images to saveImage and places them after their paragraph", async () => {
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
    const image = doc.child(1);
    assert.equal(image.type.name, "image");
    assert.equal(image.attrs.src, "/api/uploads/abc.png");
    assert.equal(image.attrs.alt, "Company logo");
    assert.equal(image.attrs.width, "100px");
  });

  it("rejects files that aren't Word documents", async () => {
    assert.throws(() => readZip(new TextEncoder().encode("not a zip at all, just text")), ZipError);
    await assert.rejects(docxToDoc(readZip(deflatedZip({ "hello.txt": "hi" }))), DocxImportError);
  });
});
