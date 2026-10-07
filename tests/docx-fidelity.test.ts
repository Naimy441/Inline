import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { documentToDocx } from "@/lib/doc/docx";
import { readDocx, type ImportedDocx } from "@/lib/doc/docxImport";
import { markdownToDoc } from "@/lib/doc/markdown";
import { schema } from "@/lib/doc/schema";
import { DEFAULT_SETTINGS, FONT_FAMILIES, type DocComment, type DocumentMeta, type DocumentSettings } from "@/lib/doc/settings";
import { readZip } from "@/lib/server/unzip";
import { comparable, commentEnd, commentStart, googleDocx, horizontalRule, image, link, LIST, pageBreak, para, png, rtlRun, run, table, tabEnd, tabTitle } from "./support/googleDocx";

/**
 * Word files in and out of Inline: a Google Doc (as Google Takeout writes it)
 * reads in looking the way Google showed it, and Inline's Word copy of any
 * document (the mirror and Download as Word) reads back in as the same
 * document, settings, tabs and comments included.
 */

/** Images by content, so the same picture gets the same address on every read. */
const images = new Map<string, Uint8Array>();
const saveImage = async (data: Uint8Array) => {
  const src = `/api/uploads/${createHash("sha256").update(data).digest("hex").slice(0, 16)}.png`;
  images.set(src, data);
  return src;
};
const loadImage = async (src: string) => (images.has(src) ? { data: images.get(src)!, mime: "image/png" } : null);

const meta = (settings: DocumentSettings): DocumentMeta => ({ id: "d", title: "Doc", createdAt: 0, updatedAt: 0, lastOpenedAt: 0, trashedAt: null, settings, wordCount: 0, preview: "" });

/** What the mirror writes for an imported (or any) document, read back in. */
async function throughWord(imported: ImportedDocx) {
  const file =
    imported.tabs.length > 1
      ? await documentToDocx(imported.tabs.map((tab) => ({ title: tab.title ?? "", doc: tab.doc, comments: tab.comments })), meta(imported.settings), loadImage)
      : await documentToDocx(imported.tabs[0]!.doc, meta(imported.settings), loadImage, imported.tabs[0]!.comments);
  return readDocx(readZip(file), { saveImage });
}

/** Comments without their ids and times, which a new read makes fresh. */
const commentShape = (comments: DocComment[]) => comments.map((c) => ({ author: c.author, body: c.body, quote: c.quote, resolved: c.resolved, replies: c.replies.map((r) => ({ author: r.author, body: r.body })) }));

function assertSameDocument(before: ImportedDocx, after: ImportedDocx) {
  assert.deepEqual(after.settings, before.settings, "settings");
  assert.deepEqual(after.tabs.map((tab) => tab.title), before.tabs.map((tab) => tab.title), "tab names");
  before.tabs.forEach((tab, index) => {
    const order: string[] = [];
    const orderAfter: string[] = [];
    assert.deepEqual(comparable(after.tabs[index]!.doc, orderAfter), comparable(tab.doc, order), `content of tab ${index + 1}`);
    assert.deepEqual(commentShape(after.tabs[index]!.comments), commentShape(tab.comments), `comments of tab ${index + 1}`);
  });
}

const marksOf = (node: { marks: readonly { type: { name: string }; attrs: Record<string, unknown> }[] }) =>
  Object.fromEntries(node.marks.map((mark) => [mark.type.name, mark.attrs.color ?? mark.attrs.size ?? mark.attrs.family ?? mark.attrs.href ?? true]));

/** A Google Doc using everything Google Docs users commonly do. */
function everythingGoogle() {
  return googleDocx(
    [
      tabTitle("Draft"),
      para("Document Title", { style: "Title" }),
      para("A subtitle", { style: "Subtitle" }),
      para("Section", { style: "Heading1" }),
      para(run("Custom heading", '<w:color w:val="00ab44"/><w:sz w:val="28"/>'), { style: "Heading2" }),
      para("Detail", { style: "Heading3" }),
      para([
        run("Plain, "),
        run("bold", '<w:b w:val="1"/>'),
        run(", "),
        run("italic", '<w:i w:val="1"/>'),
        run(", "),
        run("underlined", '<w:u w:val="single"/>'),
        run(", "),
        run("struck", '<w:strike w:val="1"/>'),
        run(", x"),
        run("2", '<w:vertAlign w:val="superscript"/>'),
        run(" H"),
        run("2", '<w:vertAlign w:val="subscript"/>'),
        run("O, "),
        run("red", '<w:color w:val="ff0000"/>'),
        run(", "),
        run("highlighted", '<w:highlight w:val="yellow"/>'),
        run(", "),
        run("shaded", '<w:shd w:fill="d9ead3" w:val="clear"/>'),
        run(", "),
        run("Georgia", '<w:rFonts w:ascii="Georgia" w:cs="Georgia" w:eastAsia="Georgia" w:hAnsi="Georgia"/>'),
        run(", "),
        run("big", '<w:sz w:val="36"/><w:szCs w:val="36"/>'),
        run(", black", '<w:color w:val="000000"/>'),
        run(" and "),
        link("a link", "rId10"),
        run("."),
      ]),
      para("Double spaced and centered.", { spacing: 'w:line="480" w:lineRule="auto"', align: "center" }),
      para("A first-line indent, justified.", { ind: 'w:firstLine="720"', align: "both" }),
      para("A works-cited entry with a hanging indent.", { ind: 'w:left="720" w:hanging="720"' }),
      para("Indented a whole inch, with space above.", { ind: 'w:left="1440"', spacing: 'w:before="240" w:after="0"' }),
      para("Right aligned", { align: "right" }),
      para("Apples", { list: { id: LIST.bullet } }),
      para("Seeds", { list: { id: LIST.bullet, level: 1 } }),
      para("Cells", { list: { id: LIST.bullet, level: 2 } }),
      para("Pears", { list: { id: LIST.bullet } }),
      para("First step", { list: { id: LIST.decimal } }),
      para("Second step", { list: { id: LIST.decimal } }),
      para("A note between the steps."),
      para("Third step", { list: { id: LIST.decimal } }),
      para("Choice A", { list: { id: LIST.upperLetter } }),
      table([
        [{ text: "Name", fill: "cfe2f3" }, { text: "Score", fill: "cfe2f3" }],
        [{ text: "Both rows", merge: "restart" }, { text: "10" }],
        [{ text: "", merge: "continue" }, { text: "12" }],
        [{ text: "Across both", span: 2 }],
      ]),
      horizontalRule(),
      para([run("This is "), commentStart(0), commentStart(1), run("difficult"), commentEnd(0), commentEnd(1), run(" to say.")]),
      para([image("rId20", 120, "A chart")], { align: "center" }),
      pageBreak(),
      tabEnd("Last line of the draft."),
      tabTitle("Notes"),
      para("Notes go here."),
    ],
    {
      links: { rId10: "https://example.com/page?a=1&b=2" },
      images: { rId20: png(240, 240) },
      comments: [
        { id: 0, author: "Reviewer", date: "2023-10-30T02:15:27Z", text: "Rephrase?" },
        { id: 1, author: "Writer", date: "2023-10-31T09:00:00Z", text: "Done" },
      ],
      header: { text: "Smith {page}", align: "right" },
      margins: { top: 720, right: 1080, bottom: 720, left: 1080 },
    },
  );
}

describe("a Google Doc reads in the way Google Docs shows it", () => {
  test("settings: page setup, body font and spacing, header", async () => {
    const { settings } = await readDocx(readZip(everythingGoogle()), { saveImage });
    assert.equal(settings.fontFamily, FONT_FAMILIES[0].value, "Google's Arial");
    assert.equal(settings.fontSize, 11);
    assert.equal(settings.lineSpacing, 1.15);
    assert.equal(settings.paragraphSpacing, 0, "Google puts no space after paragraphs");
    assert.deepEqual(settings.pageSetup, { paperSize: "letter", orientation: "portrait", margins: { top: 0.5, right: 0.75, bottom: 0.5, left: 0.75 } });
    assert.equal(settings.headerFooter.header, "Smith {page}");
    assert.equal(settings.headerFooter.headerAlign, "right");
  });

  test("tabs become tabs, named as in Google Docs", async () => {
    const { tabs } = await readDocx(readZip(everythingGoogle()), { saveImage });
    assert.deepEqual(tabs.map((tab) => tab.title), ["Draft", "Notes"]);
    assert.equal(tabs[1]!.doc.textContent, "Notes go here.");
    assert.equal(tabs[0]!.doc.firstChild!.textContent, "Document Title", "the tab's name isn't left in its text");
  });

  test("blocks, styles and character formatting", async () => {
    const doc = (await readDocx(readZip(everythingGoogle()), { saveImage })).tabs[0]!.doc;
    const blocks = Array.from({ length: doc.childCount }, (_, i) => doc.child(i));
    const find = (text: string) => blocks.find((block) => block.textContent.startsWith(text))!;
    assert.equal(blocks[0]!.type.name, "title");
    assert.equal(blocks[1]!.type.name, "subtitle");
    assert.deepEqual([find("Section").attrs.level, find("Custom heading").attrs.level, find("Detail").attrs.level], [1, 2, 3]);
    // Google's heading look is Inline's heading look: only a style's own changes become marks.
    for (const text of ["Document Title", "A subtitle", "Section", "Detail"]) assert.deepEqual(marksOf(find(text).firstChild!), {}, text);
    assert.deepEqual(marksOf(find("Custom heading").firstChild!), { text_color: "#00ab44", font_size: "14pt" });
    assert.equal(find("Section").attrs.spaceBefore, null, "Google's heading spacing is Inline's");

    const formatted = find("Plain, ");
    const piece = (text: string) => {
      let found: ReturnType<typeof formatted.child> | null = null;
      formatted.forEach((child) => {
        if (child.text?.startsWith(text)) found ??= child;
      });
      assert.ok(found, text);
      return marksOf(found!);
    };
    assert.deepEqual(piece("Plain, "), {}, "Arial 11, set on every run by Google, needs no marks");
    assert.deepEqual(piece("bold"), { bold: true });
    assert.deepEqual(piece("italic"), { italic: true });
    assert.deepEqual(piece("underlined"), { underline: true });
    assert.deepEqual(piece("struck"), { strike: true });
    assert.deepEqual(marksOf(formatted.child(9)), { superscript: true });
    assert.deepEqual(marksOf(formatted.child(11)), { subscript: true });
    assert.deepEqual(piece("red"), { text_color: "#ff0000" });
    assert.deepEqual(piece("highlighted"), { highlight: "#ffff00" }, "Word's yellow, not a paler one");
    assert.deepEqual(piece("shaded"), { highlight: "#d9ead3" });
    assert.deepEqual(piece("Georgia"), { font_family: "Georgia, serif" });
    assert.deepEqual(piece("big"), { font_size: "18pt" });
    assert.deepEqual(piece(", black"), {}, "black is left to the page, for dark mode");
    assert.deepEqual(piece("a link"), { link: "https://example.com/page?a=1&b=2" }, "Google's link blue and underline are Inline's link look");
  });

  test("paragraph layout: spacing, alignment and indents", async () => {
    const doc = (await readDocx(readZip(everythingGoogle()), { saveImage })).tabs[0]!.doc;
    const find = (text: string) => {
      let found = doc.firstChild!;
      doc.forEach((block) => {
        if (block.textContent.startsWith(text)) found = block;
      });
      return found.attrs;
    };
    assert.deepEqual([find("Double spaced").lineHeight, find("Double spaced").align], ["2", "center"]);
    assert.deepEqual([find("A first-line").textIndent, find("A first-line").align], [0.5, "justify"]);
    assert.deepEqual([find("A works-cited").indent, find("A works-cited").textIndent], [0, -0.5]);
    assert.deepEqual([find("Indented a whole").indent, find("Indented a whole").spaceBefore], [2, 12]);
    assert.equal(find("Right aligned").align, "right");
    assert.deepEqual([find("Plain, ").lineHeight, find("Plain, ").spaceAfter, find("Plain, ").indent], [null, null, 0], "ordinary paragraphs carry nothing extra");
  });

  test("lists nest, keep counting across an interruption, and lettered lists are numbered lists", async () => {
    const doc = (await readDocx(readZip(everythingGoogle()), { saveImage })).tabs[0]!.doc;
    const lists = Array.from({ length: doc.childCount }, (_, i) => doc.child(i)).filter((block) => block.type.name.endsWith("_list"));
    const [bullets, steps, third, letters] = lists;
    assert.equal(bullets!.type.name, "bullet_list");
    assert.equal(bullets!.childCount, 2);
    assert.equal(bullets!.child(0).child(1).child(0).child(1).firstChild!.textContent, "Cells", "three levels deep");
    assert.equal(steps!.childCount, 2);
    assert.equal(third!.attrs.order, 3, "Third step stays number 3 after the note");
    assert.equal(letters!.type.name, "ordered_list");
  });

  test("tables: merged and shaded cells, and Google's rows aren't header rows", async () => {
    const doc = (await readDocx(readZip(everythingGoogle()), { saveImage })).tabs[0]!.doc;
    let tableNode = doc.firstChild!;
    doc.forEach((block) => {
      if (block.type.name === "table") tableNode = block;
    });
    assert.equal(tableNode.childCount, 4);
    assert.equal(tableNode.child(0).child(0).type.name, "table_cell", "Google writes tblHeader=0 on every row");
    assert.equal(tableNode.child(0).child(0).attrs.background, "#cfe2f3");
    assert.equal(tableNode.child(1).child(0).attrs.rowspan, 2);
    assert.equal(tableNode.child(2).childCount, 1, "the merged cell isn't repeated");
    assert.equal(tableNode.child(3).child(0).attrs.colspan, 2);
    assert.equal(tableNode.child(0).child(0).firstChild!.attrs.spaceAfter, null, "cell paragraphs have no space after, as on the page");
  });

  test("horizontal lines, pictures, page breaks and comments", async () => {
    const { tabs } = await readDocx(readZip(everythingGoogle()), { saveImage });
    const doc = tabs[0]!.doc;
    const types = Array.from({ length: doc.childCount }, (_, i) => doc.child(i).type.name);
    assert.ok(types.includes("horizontal_rule"));
    const picture = doc.child(types.indexOf("image"));
    assert.deepEqual([picture.attrs.width, picture.attrs.alt, picture.attrs.align], ["120px", "A chart", "center"]);
    assert.ok(images.has(picture.attrs.src as string));
    const brk = types.indexOf("page_break");
    assert.equal(doc.child(brk + 1).textContent, "Last line of the draft.", "Google's page-break paragraph leaves no empty line");

    assert.equal(tabs[0]!.comments.length, 1, "Google writes a reply as a second comment on the same text");
    const [thread] = tabs[0]!.comments;
    assert.equal(thread!.body, "Reviewer: Rephrase?");
    assert.equal(thread!.quote, "difficult");
    assert.deepEqual(thread!.replies.map((reply) => reply.body), ["Writer: Done"]);
  });
});

/** Right-to-left text, outline numbering, paragraph borders, list items in heading styles and phone links. */
function moreGoogle() {
  return googleDocx(
    [
      tabTitle("Tab 1"),
      para([rtlRun("نص عربي")], { rtl: true }),
      para([rtlRun("عنوان في الوسط")], { rtl: true, align: "center" }),
      para([run("English words")], { rtl: true, align: "right" }),
      para([run("SECTION", '<w:b w:val="1"/>')], { border: "bottom" }),
      para("Section text"),
      para("Boxed text.", { border: "box" }),
      para("More boxed text.", { border: "box" }),
      para("Part one", { list: { id: LIST.upperRoman } }),
      para("Part two", { list: { id: LIST.upperRoman } }),
      para("A detail", { list: { id: LIST.lowerLetter, level: 1 } }),
      para("A finer detail", { list: { id: LIST.lowerRoman, level: 2 } }),
      para("Heading item", { style: "Heading3", list: { id: LIST.bullet } }),
      para([run("Call "), '<w:hyperlink r:id="rId11">' + run("+1 555 0100") + "</w:hyperlink>"]),
    ],
    { links: { rId11: "Tel:+15550100" } },
  );
}

describe("right-to-left text, outline lists, borders and links", () => {
  test("a document with one Google tab doesn't get the tab's name as a title", async () => {
    const { tabs } = await readDocx(readZip(moreGoogle()), { saveImage });
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0]!.doc.firstChild!.textContent, "نص عربي");
  });

  test("Arabic paragraphs are right to left, aligned the way Google shows them", async () => {
    const doc = (await readDocx(readZip(moreGoogle()), { saveImage })).tabs[0]!.doc;
    const attrs = (i: number) => [doc.child(i).attrs.dir, doc.child(i).attrs.align];
    assert.deepEqual(attrs(0), ["rtl", "left"], "no alignment: the paragraph's start, the right");
    assert.deepEqual(attrs(1), ["rtl", "center"]);
    assert.deepEqual(attrs(2), ["rtl", "right"], "right in a right-to-left paragraph is its far edge, the left");
    // The page lays it out so.
    const dom = schema.nodes.paragraph!.spec.toDOM!(doc.child(2)) as [string, Record<string, string>];
    assert.equal(dom[1].dir, "rtl");
    assert.match(dom[1].style!, /text-align: left/);
    assert.equal((schema.nodes.paragraph!.spec.toDOM!(doc.child(0)) as [string, Record<string, string>])[1].style, undefined, "start alignment is the default for right-to-left");
  });

  test("a line under a heading, and boxed paragraphs", async () => {
    const doc = (await readDocx(readZip(moreGoogle()), { saveImage })).tabs[0]!.doc;
    const types = Array.from({ length: doc.childCount }, (_, i) => doc.child(i).type.name);
    const heading = types.findIndex((_, i) => doc.child(i).textContent === "SECTION");
    assert.equal(types[heading + 1], "horizontal_rule", "a line drawn under a paragraph is kept");
    const box = doc.child(types.indexOf("table"));
    assert.equal(box.childCount, 1);
    assert.equal(box.firstChild!.childCount, 1, "one cell holds both boxed paragraphs");
    assert.equal(box.firstChild!.firstChild!.textContent, "Boxed text.More boxed text.");
  });

  test("outline numbering keeps its marker styles; the usual style for a depth isn't stored", async () => {
    const doc = (await readDocx(readZip(moreGoogle()), { saveImage })).tabs[0]!.doc;
    let outline = doc.firstChild!;
    doc.forEach((block) => {
      if (block.type.name === "ordered_list") outline = block;
    });
    assert.equal(outline.attrs.numbering, "upper-roman");
    const letters = outline.child(1).child(1);
    assert.equal(letters.type.name, "ordered_list");
    assert.equal(letters.attrs.numbering, null, "a. is what a second level shows anyway");
    assert.equal(letters.firstChild!.child(1).attrs.numbering, null, "and i. a third");
    const dom = schema.nodes.ordered_list!.spec.toDOM!(outline) as [string, Record<string, string>];
    assert.equal(dom[1].style, "list-style-type: upper-roman");
  });

  test("a heading that's a list item keeps its bullet and its look; phone links are links", async () => {
    const doc = (await readDocx(readZip(moreGoogle()), { saveImage })).tabs[0]!.doc;
    let bullets = doc.firstChild!;
    doc.forEach((block) => {
      if (block.type.name === "bullet_list") bullets = block;
    });
    const item = bullets.firstChild!.firstChild!;
    assert.equal(item.textContent, "Heading item");
    assert.deepEqual(marksOf(item.firstChild!), { text_color: "#434343", font_size: "14pt" }, "Heading 3's size and grey");
    const call = doc.lastChild!;
    assert.deepEqual(marksOf(call.child(1)), { link: "Tel:+15550100" });
  });

  test("a list that opens with a sub-item numbers the rest as Google does", async () => {
    const doc = (
      await readDocx(
        readZip(
          googleDocx([
            para("Opening words."),
            para("A sub-point", { list: { id: LIST.lowerLetter, level: 1 } }),
            para("First point", { list: { id: LIST.decimal } }),
            para("Second point", { list: { id: LIST.decimal } }),
          ]),
        ),
      )
    ).tabs[0]!.doc;
    assert.deepEqual([doc.child(1).type.name, doc.child(1).attrs.numbering, doc.child(1).childCount], ["ordered_list", "lower-alpha", 1], "the sub-item keeps its letter");
    assert.deepEqual([doc.child(2).attrs.order, doc.child(2).attrs.numbering, doc.child(2).firstChild!.textContent], [1, null, "First point"], "and the list after it starts at 1., not after an empty item");
  });

  test("all of it comes back the same through Inline's Word copy", async () => {
    const imported = await readDocx(readZip(moreGoogle()), { saveImage });
    assertSameDocument(imported, await throughWord(imported));
  });

  test("Word gets right-to-left paragraphs and runs, with the complex-script size and weight Arabic uses", async () => {
    const doc = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create({ dir: "rtl" }, schema.text("مرحبا", [schema.marks.bold!.create(), schema.marks.font_size!.create({ size: "14pt" })])),
      schema.nodes.ordered_list!.create({ numbering: "upper-roman" }, schema.nodes.list_item!.create(null, schema.nodes.paragraph!.create(null, schema.text("One")))),
    ]);
    const xml = new TextDecoder().decode(readZip(await documentToDocx(doc, meta(DEFAULT_SETTINGS), loadImage)).get("word/document.xml")!);
    assert.match(xml, /<w:pPr><w:bidi\/><\/w:pPr><w:r><w:rPr><w:b\/><w:bCs\/><w:sz w:val="28"\/><w:szCs w:val="28"\/><w:rtl\/><\/w:rPr>/);
    const numbering = new TextDecoder().decode(readZip(await documentToDocx(doc, meta(DEFAULT_SETTINGS), loadImage)).get("word/numbering.xml")!);
    assert.match(numbering, /<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"\/><w:lvl w:ilvl="0"><w:start w:val="1"\/><w:numFmt w:val="upperRoman"\/>/);
  });

  test("Markdown (what Claude reads and writes) keeps a paragraph right to left", async () => {
    const { docToMarkdown } = await import("@/lib/doc/markdown");
    const doc = schema.nodes.doc!.create(null, schema.nodes.paragraph!.create({ dir: "rtl" }, schema.text("مرحبا")));
    const markdown = docToMarkdown(doc);
    assert.match(markdown, /\{dir=rtl\}/);
    assert.equal(markdownToDoc(markdown).firstChild!.attrs.dir, "rtl");
  });
});

describe("Inline's Word copy reads back as the same document", () => {
  test("a Google Doc, through the mirror and back", async () => {
    const imported = await readDocx(readZip(everythingGoogle()), { saveImage });
    const again = await throughWord(imported);
    assertSameDocument(imported, again);
    // And once more: nothing drifts.
    assertSameDocument(again, await throughWord(again));
  });

  test("a document using every kind of block, mark and setting", async () => {
    const settings: DocumentSettings = {
      ...DEFAULT_SETTINGS,
      pageSetup: { paperSize: "a4", orientation: "landscape", margins: { top: 0.75, right: 1.25, bottom: 0.5, left: 1.5 } },
      fontFamily: FONT_FAMILIES[3].value,
      fontSize: 12,
      lineSpacing: 2,
      paragraphSpacing: 0,
      headerFooter: { header: "Smith {page}", footer: "Page {page} of {pages}", headerAlign: "right", footerAlign: "center", differentFirstPage: true, firstHeader: "", firstFooter: "Cover page" },
    };
    const doc = markdownToDoc(
      [
        "# Report {.title}",
        "",
        "## Background",
        "",
        "Text with **bold**, *italic*, <u>underline</u>, ~~strike~~, `code`, <sup>up</sup>, <sub>down</sub>, ==marked== and a [link](https://example.com).",
        "",
        "> Quoted first",
        ">",
        "> Quoted second",
        "",
        "- one",
        "  - nested",
        "- two",
        "",
        "3. three",
        "4. four",
        "   1. inner",
        "",
        "- [ ] to do",
        "- [x] done",
        "",
        "```",
        "let a = 1;",
        "",
        "\treturn a;",
        "```",
        "",
        "---",
        "",
        "| Head | Er |",
        "| --- | --- |",
        "| a | b |",
        "",
        "\\pagebreak",
        "",
        "After the break",
      ].join("\n"),
    );
    // What Markdown can't say, made directly.
    const p = (attrs: Record<string, unknown>, ...content: ReturnType<typeof schema.text>[]) => schema.nodes.paragraph!.create(attrs, content);
    const extra = [
      schema.nodes.subtitle!.create({ align: "center" }, schema.text("Centered subtitle")),
      ...[3, 4, 5, 6].map((level) => schema.nodes.heading!.create({ level }, schema.text(`Heading ${level}`))),
      p({ align: "justify", indent: 2, textIndent: -0.5, lineHeight: "1.5", spaceBefore: 12, spaceAfter: 6 }, schema.text("Laid out")),
      p({}, schema.text("Colored", [schema.marks.text_color!.create({ color: "#c5221f" })]), schema.text(" sized", [schema.marks.font_size!.create({ size: "14pt" })]), schema.text(" Georgia", [schema.marks.font_family!.create({ family: "Georgia, serif" })]), schema.text(" green", [schema.marks.highlight!.create({ color: "#bbf7d0" })])),
      schema.nodes.paragraph!.create(null, [schema.text("line one"), schema.nodes.hard_break!.create(), schema.text("line two")]),
      schema.nodes.image!.create({ src: await saveImage(png(400, 200)), alt: "Wide", width: "200px", align: "right" }),
      schema.nodes.table!.create(null, [
        schema.nodes.table_row!.create(null, [schema.nodes.table_cell!.create({ rowspan: 2, background: "#fde68a" }, p({}, schema.text("tall"))), schema.nodes.table_cell!.create(null, p({}, schema.text("x")))]),
        schema.nodes.table_row!.create(null, [schema.nodes.table_cell!.create(null, [p({}, schema.text("y")), p({}, schema.text("y2"))])]),
        schema.nodes.table_row!.create(null, [schema.nodes.table_cell!.create({ colspan: 2 }, p({}, schema.text("wide")))]),
      ]),
    ];
    const commented = schema.nodes.paragraph!.create(null, [schema.text("Please "), schema.text("check this", [schema.marks.comment!.create({ id: "c1" })]), schema.text(" and "), schema.text("this", [schema.marks.comment!.create({ id: "c2" })])]);
    const full = schema.nodes.doc!.create(null, [...Array.from({ length: doc.childCount }, (_, i) => doc.child(i)), ...extra, commented]);
    const comments: DocComment[] = [
      { id: "c1", author: "user", body: "Is this right?", quote: "check this", createdAt: Date.UTC(2026, 0, 1), resolved: false, replies: [{ id: "r1", author: "claude", body: "Yes, it checks out.", createdAt: Date.UTC(2026, 0, 2) }] },
      { id: "c2", author: "claude", body: "Consider rewording.\nTwo lines.", quote: "this", createdAt: Date.UTC(2026, 0, 3), resolved: true, replies: [] },
    ];
    const original: ImportedDocx = { settings, tabs: [{ title: null, doc: full, comments }] };
    const back = await throughWord(original);
    assertSameDocument(original, back);
  });

  test("a document with tabs keeps its tabs, each with its own comments", async () => {
    const tab = (text: string, comment?: DocComment) => ({
      title: text.split(" ")[0]!,
      doc: schema.nodes.doc!.create(null, [schema.nodes.paragraph!.create(null, comment ? [schema.text(text, [schema.marks.comment!.create({ id: comment.id })])] : [schema.text(text)])]),
      comments: comment ? [comment] : [],
    });
    const note: DocComment = { id: "n1", author: "user", body: "On the second tab", quote: "Appendix text", createdAt: 0, resolved: false, replies: [] };
    const original: ImportedDocx = { settings: DEFAULT_SETTINGS, tabs: [tab("Chapter one"), tab("Appendix text", note), tab("Index")] };
    assertSameDocument(original, await throughWord(original));
  });

  test("Inline's defaults come back as Inline's defaults", async () => {
    const original: ImportedDocx = { settings: DEFAULT_SETTINGS, tabs: [{ title: null, doc: markdownToDoc("Hello\n\n- a\n- b"), comments: [] }] };
    const back = await throughWord(original);
    assert.deepEqual(back.settings, DEFAULT_SETTINGS);
    assertSameDocument(original, back);
  });
});

describe("the Word file itself", () => {
  const exported = async (markdown: string) => new TextDecoder().decode(readZip(await documentToDocx(markdownToDoc(markdown), meta(DEFAULT_SETTINGS), loadImage)).get("word/document.xml")!);
  const styles = async () => new TextDecoder().decode(readZip(await documentToDocx(markdownToDoc("x"), meta(DEFAULT_SETTINGS), loadImage)).get("word/styles.xml")!);

  test("headings look as on the page: regular weight, Google's greys", async () => {
    const xml = await styles();
    const heading = (level: number) => new RegExp(`<w:style w:type="paragraph" w:styleId="Heading${level}">.*?</w:style>`).exec(xml)![0];
    for (const level of [1, 2, 3, 4, 5, 6]) assert.doesNotMatch(heading(level), /<w:b\/>/, `heading ${level} isn't bold`);
    assert.match(heading(3), /<w:color w:val="434343"\/>/);
    assert.match(heading(6), /<w:i\/>/);
  });

  test("a table gets an empty paragraph after it only where Word needs one", async () => {
    const tableMd = "| A |\n| --- |\n| 1 |";
    assert.match(await exported(`${tableMd}\n\nAfter`), /<\/w:tbl><w:p><w:r>/, "a paragraph already follows");
    assert.match(await exported(`Before\n\n${tableMd}`), /<\/w:tbl><w:p\/><w:sectPr>/, "the document can't end on a table");
    assert.match(await exported(`${tableMd}\n\n${tableMd}`), /<\/w:tbl><w:p\/><w:tbl>/, "two tables would run together");
  });

  test("list items have the page's 2pt after them, header rows repeat and are bold", async () => {
    const xml = await exported("- a\n\n| H |\n| --- |\n| b |");
    assert.match(xml, /<w:numPr>.*?<\/w:numPr><w:spacing w:after="40"\/>/);
    assert.match(xml, /<w:tr><w:trPr><w:tblHeader\/><\/w:trPr>.*?<w:pStyle w:val="TableHeading"\/>/);
  });
});
