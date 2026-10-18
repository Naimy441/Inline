import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { DOMSerializer } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { EditorState } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import { compileCanvas, canvasMarkup } from "./compiler";
import { CANVAS_EXAMPLES, CANVAS_FRAGMENTS, CANVAS_GUIDE } from "./examples";
import { canvasFlowIssues, canvasPageSpace, type CanvasBlockBox } from "./editor";
import { darkScreenCanvasCss, canvasCssNotes, validateCanvasCss, scopedCanvasCss } from "./styles";
import { darkColor } from "@/lib/pdf/thumbnail";
import { validateCanvasDocument } from "./model";
import { canvasTransform, readCanvas } from "./operations";
import { documentHub, type LiveDocument } from "@/lib/server/hub";
import { canvasScreenshotText, canvasTurnContext, documentListing, runTool } from "@/lib/agent/tools";
import { docToMarkdown } from "@/lib/doc/markdown";
import { schema } from "@/lib/doc/schema";
import { readDocumentFile } from "@/lib/server/store";

process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-canvas-"));
async function create() { const e = CANVAS_EXAMPLES.editorial; return documentHub().create({ title: "Canvas", doc: compileCanvas(e.html, e.css).toJSON() }); }
const patch = (doc: LiveDocument, extra: Partial<Parameters<typeof canvasTransform>[1]>) => canvasTransform(doc, { epoch: doc.epoch, version: doc.version, operation: "styles", ...extra }).tr;

describe("Canvas SDK", () => {
  test("three distinct designs round-trip with stable IDs and scoped styles", () => {
    for (const example of Object.values(CANVAS_EXAMPLES)) {
      const doc = compileCanvas(example.html, example.css);
      validateCanvasDocument(doc);
      const ids: string[] = [];
      doc.descendants((n) => { if (n.isBlock && "id" in n.attrs) { assert.ok(n.attrs.id); ids.push(n.attrs.id); } });
      assert.equal(new Set(ids).size, ids.length);
      const roundtrip = compileCanvas(canvasMarkup(doc), doc.attrs.canvas.css);
      assert.equal(roundtrip.textContent, doc.textContent);
      assert.equal(roundtrip.attrs.canvas.css, doc.attrs.canvas.css);
      assert.ok(scopedCanvasCss(example.css, "test").includes('[data-canvas-root="test"]'));
    }
  });
  test("rejects scripts, arbitrary attributes, links, duplicate IDs, and invalid layouts", () => {
    for (const html of [
      '<Canvas><script>alert(1)</script></Canvas>',
      '<Canvas><Text onclick="alert(1)">x</Text></Canvas>',
      '<Canvas><Text><a href="javascript:alert(1)">x</a></Text></Canvas>',
      '<Canvas><Text id="same">a</Text><Text id="same">b</Text></Canvas>',
      '<Canvas><Columns><Text>Wrong child</Text></Columns></Canvas>',
      '<Canvas><Figure><img src="https://remote/image.png" alt="x"></Figure></Canvas>',
      '<Canvas><Text as="iframe">x</Text></Canvas>',
      '<Canvas><Text class="page-gap">x</Text></Canvas>',
    ]) assert.throws(() => compileCanvas(html), Error, html);
  });
  test("CSS parser refuses escapes, nested rules, imports, layout overrides and application selectors", () => {
    for (const css of ['@import "https://evil";', '.x { position:fixed }', '.x { background-color:url(https://evil) }', '.x { color:red!important }', 'body { color:red }', '.x { height:100px }', '.x { & p { color:red } }', '.x { font-family:"</style><script>" }', '.page-gap {padding:100px}']) assert.throws(() => validateCanvasCss(css), Error, css);
    const css = scopedCanvasCss('Canvas {color:red} .foo p, Columns > Column { padding: 4px }', "document-1");
    assert.ok(!css.includes('[data-canvas-root="document-1"] [data-canvas-root]'));
    assert.ok(css.includes('.doc-content[data-canvas-root="document-1"] .foo p'));
  });
  test("math, document images, and section text round-trip", () => {
    const src = "/api/documents/u794f4zkt9xd/files/graphs.png";
    const doc = compileCanvas(`<Canvas><Text id="stem">Let <Math>x^2</Math> be given.</Text><Math display id="integral">\\int_0^1 x dx</Math><Figure id="plot"><img src="${src}" alt="A graph"></Figure><Section id="close"><Text>Q.E.D.</Text></Section></Canvas>`);
    assert.equal(doc.child(0).textContent, "Let x^2 be given.");
    let marked = false;
    doc.child(0).descendants((node) => { if (node.isText && node.marks.some((mark) => mark.type.name === "math")) marked = true; });
    assert.equal(marked, true);
    assert.equal(doc.child(1).type.name, "code_block");
    assert.equal(doc.child(1).attrs.language, "math");
    assert.equal(doc.child(2).child(0).attrs.src, src);
    const html = canvasMarkup(doc);
    assert.match(html, /<Math>x\^2<\/Math>/);
    assert.match(html, /<Math display id="integral">/);
    assert.match(html, new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, /<section id="close"[\s\S]*Q\.E\.D\./);
    const again = compileCanvas(html, doc.attrs.canvas.css);
    assert.equal(again.textContent, doc.textContent);
    const markdown = docToMarkdown(doc);
    assert.match(markdown, /Let \$x\^2\$ be given/);
    assert.match(markdown, /Q\.E\.D\./);
    assert.equal(markdown.includes("&nbsp;"), false);
    assert.match(CANVAS_GUIDE, /id attributes are patch targets, not CSS selectors/);
    assert.match(CANVAS_GUIDE, /Create a Canvas when the layout is part of the piece/);
    assert.match(CANVAS_GUIDE, /\/api\/documents\/<document id>\/files\/<file>/);
    assert.match(CANVAS_GUIDE, /<Math> is inline LaTeX/);
    assert.match(CANVAS_GUIDE, /<table> with <tr>, <th>, and <td>/);
    assert.match(CANVAS_GUIDE, /The document title is the first h1/);
    assert.match(CANVAS_GUIDE, /Figure img \{ max-width: 330px \}/);
    assert.match(CANVAS_GUIDE, /6\.5in \(624px at 96px per inch\)/);
    assert.match(CANVAS_GUIDE, /ratio of 3:2/);
    assert.match(CANVAS_GUIDE, /Pass operations, at most 12/);
    assert.match(CANVAS_GUIDE, /screenshot_page returns the image and a short issue summary/);
    assert.match(CANVAS_GUIDE, /call check_layout\. It is the cheap overflow check/);
    assert.match(CANVAS_GUIDE, /only when you need a block's top or height in pixels/);
    assert.match(CANVAS_GUIDE, /Do not call check_layout, inspect_canvas, and screenshot_page on every design pass/);
    assert.match(CANVAS_GUIDE, /redesign: true/);
    assert.match(CANVAS_GUIDE, /downscaled preview/);
    assert.match(CANVAS_GUIDE, /no padding or borders/);
    assert.doesNotMatch(CANVAS_GUIDE, /inspect_canvas and screenshot_page to inspect/);
    assert.match(CANVAS_GUIDE, /syntax only/);
    assert.match(CANVAS_GUIDE, /do not reuse a title, equation, or palette/);
    assert.match(CANVAS_GUIDE, /dry_run/);
    assert.match(CANVAS_GUIDE, /Spans cannot nest: a span class applies to its own text, and a nested span is rejected with that element's name\./);
    assert.match(CANVAS_GUIDE, /A preformatted block is <pre>, placed beside text and not inside it\. It keeps leading spaces and column alignment, and the page sets white-space: pre so copying it copies real spaces\./);
    assert.match(CANVAS_GUIDE, /styles replaces the whole stylesheet\./);
    assert.match(CANVAS_GUIDE, /html_file or operations_file/);
    assert.match(CANVAS_GUIDE, /measurement is unavailable/);
    assert.doesNotMatch(CANVAS_GUIDE, /nbsp|invisible dot/);
    assert.match(CANVAS_GUIDE, /add a class or set <img width>/);
    assert.doesNotMatch(JSON.stringify(CANVAS_FRAGMENTS), /A better beginning|Evidence before assumptions|Make room for discovery/);
    assert.match(CANVAS_FRAGMENTS.map((fragment) => fragment.html).join("\n"), /<Math display/);
    assert.match(CANVAS_GUIDE, /class that is not on any element/);
    assert.doesNotMatch(CANVAS_GUIDE, /\/api\/images/);
  });
  test("a page screenshot summary does not repeat the block list", () => {
    const report = {
      pages: 2,
      page: 1,
      issues: [{ id: "fig", message: "overflows by 12px" }],
      blocks: [{ id: "fig", page: 1, toPage: 1 }, { id: "next", page: 2, toPage: 2 }],
    };
    const summary = canvasScreenshotText(report, false);
    assert.match(summary, /Page 1 of 2/);
    assert.match(summary, /fig: overflows by 12px/);
    assert.doesNotMatch(summary, /"blocks"/);
    assert.doesNotMatch(summary, /"next"/);
    assert.match(canvasScreenshotText(report, true), /"blocks"/);
  });
  test("a blank canvas is an empty page", () => {
    const doc = compileCanvas("<Canvas></Canvas>");
    assert.equal(doc.textContent, "");
    assert.equal(doc.attrs.canvas.format, 1);
    assert.equal(doc.attrs.canvas.css, "");
    assert.equal(doc.childCount, 1);
  });
  test("dark editing flips painted colors on screen and leaves the light rules for print", () => {
    const light = scopedCanvasCss("Canvas { color: #25392f; background-color: #ffffff } h1 { border-left: 2px solid #789079 }", "document-1");
    const dark = darkScreenCanvasCss(light);
    assert.match(dark, /^@media screen \{/);
    const [r, g, b] = darkColor([0x25 / 255, 0x39 / 255, 0x2f / 255]);
    assert.match(dark, new RegExp(`rgb\\(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)}\\)`));
    assert.doesNotMatch(dark, /#25392f|#ffffff|#789079/);
    assert.match(dark, /border-left: 2px solid rgb\(/);
  });
  test("design attributes use normal ProseMirror history", () => {
    const doc = compileCanvas('<Canvas><Text>Keep my words</Text></Canvas>', 'p {color:red}');
    let state = EditorState.create({ doc, plugins: [history()] });
    state = state.apply(state.tr.setDocAttribute("canvas", { format: 1, css: 'p {color:blue}' }));
    assert.equal(state.doc.textContent, "Keep my words");
    assert.ok(undo(state, (tr) => { state = state.apply(tr); }));
    assert.equal(state.doc.attrs.canvas.css, 'p {color:red}');
  });
  test("an image width round-trips and is refused on other elements", () => {
    const src = "/api/documents/doc/files/butterfly.png";
    const doc = compileCanvas(`<Canvas><Figure id="fig1"><img src="${src}" alt="A butterfly" width="330"></Figure><Figure id="fig2"><img src="${src}" alt="A wider butterfly" width="4.5in"></Figure></Canvas>`);
    assert.equal(doc.child(0).child(0).attrs.width, "330px");
    assert.equal(doc.child(1).child(0).attrs.width, "4.5in");
    const html = canvasMarkup(doc);
    assert.match(html, /width="330px"/);
    assert.match(html, /width="4\.5in"/);
    assert.equal(compileCanvas(html).child(0).child(0).attrs.width, "330px");
    assert.throws(() => compileCanvas(`<Canvas><Text width="10">x</Text></Canvas>`), /width is only supported/);
    assert.throws(() => compileCanvas(`<Canvas><Figure><img src="${src}" alt="A butterfly" width="wide"></Figure></Canvas>`), /Image width/);
  });
  test("page-fit warnings name an empty gap, a stranded heading, and a short last page", () => {
    const content = { contentWidth: 624, contentHeight: 864 };
    const block = (partial: Partial<CanvasBlockBox> & Pick<CanvasBlockBox, "id" | "page" | "top" | "height">): CanvasBlockBox => ({ toPage: partial.page, kind: "block", ...partial });
    const empty = canvasPageSpace([block({ id: "head", page: 1, top: 0, height: 80, kind: "heading" })], 2, content.contentWidth, content.contentHeight);
    assert.equal(empty[0].free, 784);
    assert.match(canvasFlowIssues([block({ id: "head", page: 1, top: 0, height: 80, kind: "heading" })], empty).map((issue) => issue.message).join("\n"), /Page 1 is mostly empty/);
    const broken = [block({ id: "split", page: 1, top: 40, height: 12, kind: "break" }), block({ id: "head", page: 1, top: 0, height: 28, kind: "heading" })];
    const brokenIssues = canvasFlowIssues(broken, canvasPageSpace(broken, 2, content.contentWidth, content.contentHeight));
    assert.match(brokenIssues.map((issue) => issue.message).join("\n"), /very little content before a page break/);
    assert.equal(brokenIssues.some((issue) => /short block|mostly empty/.test(issue.message)), false);
    const gap = [block({ id: "note", page: 2, top: 0, height: 70 }), block({ id: "br", page: 2, top: 72, height: 14, toPage: 3, kind: "break" })];
    const gapSpace = canvasPageSpace(gap, 3, content.contentWidth, content.contentHeight);
    assert.equal(gapSpace[1]!.used, 86);
    assert.ok(gapSpace[1]!.free > 700);
    assert.equal(gapSpace[2]!.used, 0);
    const stranded = [block({ id: "late", page: 1, top: 620, height: 36, kind: "heading" })];
    assert.match(canvasFlowIssues(stranded, canvasPageSpace(stranded, 2, content.contentWidth, content.contentHeight)).map((issue) => issue.message).join("\n"), /Heading late sits in the lower part/);
    const short = [block({ id: "body", page: 1, top: 0, height: 800 }), block({ id: "coda", page: 2, top: 0, height: 28 })];
    const shortSpace = canvasPageSpace(short, 2, content.contentWidth, content.contentHeight);
    assert.match(canvasFlowIssues(short, shortSpace).map((issue) => issue.message).join("\n"), /Page 2 holds only a short block/);
    const intentional = [block({ id: "body", page: 1, top: 0, height: 700 }), block({ id: "rule", page: 1, top: 740, height: 8, kind: "break" }), block({ id: "coda", page: 2, top: 0, height: 28 })];
    assert.equal(canvasFlowIssues(intentional, canvasPageSpace(intentional, 2, content.contentWidth, content.contentHeight)).some((issue) => /short block/.test(issue.message)), false);
    const only = [block({ id: "only", page: 1, top: 0, height: 40 })];
    assert.equal(canvasFlowIssues(only, canvasPageSpace(only, 1, content.contentWidth, content.contentHeight)).length, 0);
  });
  test("an unused class is reported and a class that is present is not", () => {
    const doc = compileCanvas(CANVAS_EXAMPLES.editorial.html, CANVAS_EXAMPLES.editorial.css);
    const notes = canvasCssNotes(".narrow { max-width: 330px }\n.opening { color: #112233 }", doc);
    assert.match(notes.join("\n"), /\.narrow is not on any element/);
    assert.equal(notes.some((note) => note.includes(".opening")), false);
  });
  test("painted containers must be indivisible, with decoration allowed inside atomic columns", () => {
    assert.throws(() => compileCanvas('<Canvas><Section class="box"><Text>x</Text></Section></Canvas>', '.box {padding:20px;background-color:red}'), /Flowing containers/);
    assert.throws(() => compileCanvas('<Canvas><Section class="box"><Text>x</Text></Section></Canvas>', '.box { background: linear-gradient(#ffffff, #eeeeee) }'), /Flowing containers/);
    assert.doesNotThrow(() => compileCanvas('<Canvas><Columns><Column class="box"><Text>x</Text></Column><Column><Text>y</Text></Column></Columns></Canvas>', '.box {padding:20px;background-color:red}'));
    assert.doesNotThrow(() => compileCanvas('<Canvas><Section class="wash" pagination="keep-together"><Text>x</Text></Section></Canvas>', '.wash { background: linear-gradient(#f7f7f7, #e4e4e4); padding: 12px }'));
  });
  test("an id selector points at a class or img width", () => {
    assert.throws(() => validateCanvasCss("#fig2 img { max-width: 330px }"), /Add a class \(or set <img width>\) instead of #fig2 img/);
    assert.throws(() => validateCanvasCss(".x { background: radial-gradient(#fff, #000) }"), /linear-gradient/);
    assert.throws(() => validateCanvasCss(".x { background-image: linear-gradient(#fff, #000) }"), /background images/);
    const scoped = scopedCanvasCss("Math.rule { border-top: 1px solid #111111 }", "document-1");
    assert.match(scoped, /\.math-block\.rule/);
    const dark = darkScreenCanvasCss(scopedCanvasCss(".wash { background: linear-gradient(#112233, #ffffff) }", "document-1"));
    assert.match(dark, /linear-gradient/);
    assert.doesNotMatch(dark, /#112233|#ffffff/);
  });
  test("bleed is only a keep-together section and round-trips", () => {
    assert.throws(() => compileCanvas('<Canvas><Section bleed><Text>x</Text></Section></Canvas>'), /keep-together Section/);
    assert.throws(() => compileCanvas('<Canvas><Stack bleed pagination="keep-together"><Text>x</Text></Stack></Canvas>'), /keep-together Section/);
    const doc = compileCanvas('<Canvas><Section id="band" class="wash" pagination="keep-together" bleed><Text>x</Text></Section></Canvas>', '.wash { background: linear-gradient(#f7f7f7, #e4e4e4) }');
    assert.equal(doc.child(0).attrs.bleed, true);
    assert.match(canvasMarkup(doc), /<section id="band" class="wash" pagination="keep-together" bleed>/);
    assert.equal(compileCanvas(canvasMarkup(doc), doc.attrs.canvas.css).child(0).attrs.bleed, true);
  });
  test("a dry run measures without writing", async () => {
    const doc = await create();
    const version = doc.version;
    const css = doc.doc.attrs.canvas.css;
    const guide = await runTool("get_canvas_guide", {}, { author: "claude" });
    assert.match(guide.text, /syntax only/);
    assert.doesNotMatch(guide.text, /A better beginning/);
    const read = await runTool("read_canvas", { document_id: doc.id, include_guide: true }, { author: "claude", documentId: doc.id });
    const body = JSON.parse(read.text) as { fragments?: unknown; examples?: unknown };
    assert.ok(body.fragments);
    assert.equal(body.examples, undefined);
    const bad = await runTool("patch_canvas", {
      document_id: doc.id, epoch: doc.epoch, version: doc.version, operation: "styles", css: "#fig2 img { max-width: 10px }", dry_run: true,
    }, { author: "claude", documentId: doc.id });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /<img width>/);
    const measured = await runTool("patch_canvas", {
      document_id: doc.id, epoch: doc.epoch, version: doc.version, operation: "styles", css: "h1 { color: #112233 }", dry_run: true,
    }, { author: "claude", documentId: doc.id });
    assert.notEqual(measured.isError, true);
    assert.match(measured.text, /Dry run only/);
    assert.match(measured.text, /Measurement is unavailable/);
    assert.match(measured.text, /styles replaces the whole stylesheet/);
    assert.equal(doc.version, version);
    assert.equal(doc.doc.attrs.canvas.css, css);
  });
  test("a preformatted block keeps spaces, round-trips, and copies as real spaces", () => {
    const aligned = "name  value\na     1\nbb    22\n  indented";
    const doc = compileCanvas(`<Canvas><Text id="note">See the listing.</Text><pre id="listing">${aligned}</pre></Canvas>`);
    assert.equal(doc.child(1).type.name, "code_block");
    assert.equal(doc.child(1).attrs.language, "canvas-pre");
    assert.equal(doc.child(1).textContent, aligned);
    const html = canvasMarkup(doc);
    assert.match(html, /<pre id="listing">name {2}value\na {5}1\nbb {4}22\n {2}indented<\/pre>/);
    assert.equal(compileCanvas(html).child(1).textContent, aligned);
    const wrapped = compileCanvas("<Canvas><pre>\n  def f():\n      return 1\n</pre></Canvas>");
    assert.equal(wrapped.child(0).textContent, "  def f():\n      return 1");
    const nbsp = compileCanvas("<Canvas><pre>&nbsp;&nbsp;kept</pre></Canvas>");
    assert.equal(nbsp.child(0).textContent, "  kept");
    const markup = canvasMarkup(nbsp);
    assert.equal(markup.includes("&nbsp;"), false);
    assert.equal(markup.includes("&#160;"), false);
    const { window } = new JSDOM("<!doctype html><body></body>");
    window.document.body.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(nbsp.content, { document: window.document }));
    const pre = window.document.querySelector("pre");
    assert.ok(pre);
    assert.equal(pre.textContent, "  kept");
    assert.match(pre.getAttribute("style") || "", /white-space:\s*pre/);
    assert.equal(pre.innerHTML.includes("nbsp"), false);
    assert.equal(pre.innerHTML.includes("&#160;"), false);
    assert.throws(() => compileCanvas('<Canvas><Text id="t"><pre>inside</pre></Text></Canvas>'), /<pre> is its own block[\s\S]*<Text id="t">/);
    assert.throws(() => compileCanvas('<Canvas><Text id="t"><span class="a"><span class="b">Hi</span></span></Text></Canvas>'), /Spans cannot nest: <span class="b"> is inside <span class="a"> in <Text id="t">/);
  });
});

describe("Canvas authority", () => {
  test("persists design and content in the same document and metadata", async () => {
    const doc = await create();
    doc.applyTransform(patch(doc, { css: 'h1 {color:blue}' }), { kind: "system", label: "test" });
    await doc.flush();
    const stored = await readDocumentFile(doc.id);
    assert.equal(stored?.meta.kind, "canvas");
    assert.equal(schema.nodeFromJSON(stored!.doc).attrs.canvas.css, 'h1 {color:blue}');
  });
  test("stale versions and epochs cannot overwrite manual work", async () => {
    const doc = await create(); const before = readCanvas(doc);
    let at = 0; doc.doc.descendants((n, pos) => { if (n.isText && n.text!.includes("A better")) at = pos; });
    doc.applyTransform(new Transform(doc.doc).insert(at, schema.text("My correction: ")), { kind: "client", clientID: "human" });
    assert.throws(() => canvasTransform(doc, { ...before, operation: "styles", css: "" }), /changed since/);
    assert.throws(() => canvasTransform(doc, { epoch: "old-epoch", version: doc.version, operation: "styles", css: "" }), /changed since/);
    doc.applyTransform(patch(doc, { css: 'h1 {color:blue}' }), { kind: "agent", author: "claude" });
    assert.ok(doc.doc.textContent.includes("My correction"));
    assert.ok(readCanvas(doc).html.includes("My correction"));
  });
  test("focused replacement preserves unrelated nodes and stable IDs", async () => {
    const doc = await create(); const original = doc.doc.child(1);
    const version = doc.version;
    doc.applyTransform(patch(doc, { operation: "replace_component", target: "intro", html: '<Canvas><Text>Revised introduction.</Text></Canvas>' }), { kind: "agent", author: "claude" });
    assert.equal(doc.doc.child(1), original);
    assert.equal(doc.version - version, 1);
    assert.ok(readCanvas(doc).html.includes('id="intro"'));
    assert.ok(doc.doc.textContent.includes("Revised introduction."));
  });
  test("replace_component keeps authored ids and reports a child that reuses the target", async () => {
    const src = "/api/documents/doc/files/butterfly.png";
    const doc = await documentHub().create({ title: "Plot", doc: compileCanvas(`<Canvas><Text as="h1" id="title">Two equations</Text><Figure id="fig1"><img src="${src}" alt="Butterfly"></Figure></Canvas>`).toJSON() });
    const version = doc.version;
    const written = canvasTransform(doc, {
      epoch: doc.epoch, version, operation: "replace_component", target: "fig1",
      html: `<Canvas><Columns id="eq1body" ratio="3:2"><Column id="eq1figcol"><Figure id="fig1"><img src="${src}" alt="Butterfly" width="330"></Figure></Column><Column id="eq1notes"><Text id="why">Why it works</Text></Column></Columns></Canvas>`,
    });
    doc.applyTransform(written.tr, { kind: "agent", author: "claude" });
    assert.equal(doc.version - version, 1);
    const html = readCanvas(doc).html;
    assert.match(html, /<columns id="eq1body"/);
    assert.match(html, /<figure id="fig1"/);
    assert.match(html, /width="330px"/);
    assert.match(written.notes.join("\n"), /Kept id "eq1body"/);
    const omitted = await documentHub().create({ title: "Plot", doc: compileCanvas(`<Canvas><Text as="h1" id="title">Two equations</Text><Figure id="fig1"><img src="${src}" alt="Butterfly"></Figure></Canvas>`).toJSON() });
    const again = canvasTransform(omitted, {
      epoch: omitted.epoch, version: omitted.version, operation: "replace_component", target: "fig1",
      html: `<Canvas><Columns ratio="3:2"><Column><Figure id="fig1"><img src="${src}" alt="Butterfly"></Figure></Column><Column><Text>Notes</Text></Column></Columns></Canvas>`,
    });
    omitted.applyTransform(again.tr, { kind: "agent", author: "claude" });
    const kept = readCanvas(omitted).html;
    assert.match(kept, /<figure id="fig1"/);
    assert.doesNotMatch(kept, /<columns id="fig1"/);
    assert.match(again.notes.join("\n"), /child kept "fig1"/);
    assert.throws(() => canvasTransform(doc, { epoch: doc.epoch, version: doc.version, operation: "replace_component", target: "why", html: '<Canvas><Text id="title">Nope</Text></Canvas>' }), /already used outside/);
    assert.throws(() => canvasTransform(doc, { epoch: doc.epoch, version: doc.version, operation: "styles", operations: [{ operation: "remove", target: "why" }] }), /not both/);
  });
  test("batched edits apply together and a failed batch changes nothing", async () => {
    const doc = await create();
    const version = doc.version;
    const before = doc.doc;
    assert.throws(() => canvasTransform(doc, {
      epoch: doc.epoch, version, operations: [
        { operation: "remove", target: "next" },
        { operation: "replace_component", target: "missing", html: "<Canvas><Text>Nope</Text></Canvas>" },
      ],
    }), /was not found/);
    assert.equal(doc.doc, before);
    const { tr, notes } = canvasTransform(doc, {
      epoch: doc.epoch, version, operations: [
        { operation: "replace_component", target: "intro", html: '<Canvas><Text id="intro">Revised introduction.</Text></Canvas>' },
        { operation: "remove", target: "next" },
      ],
    });
    doc.applyTransform(tr, { kind: "agent", author: "claude" });
    assert.equal(doc.version - version, 2);
    assert.equal(notes.length, 0);
    const html = readCanvas(doc).html;
    assert.match(html, /id="intro"/);
    assert.match(html, /Revised introduction/);
    assert.doesNotMatch(html, /id="next"/);
    const moved = canvasTransform(doc, { epoch: doc.epoch, version: doc.version, operation: "move_after", target: "overview", after: "opening" });
    const orderBefore = doc.version;
    doc.applyTransform(moved.tr, { kind: "agent", author: "claude" });
    assert.equal(doc.version - orderBefore, 2);
    const ids: string[] = [];
    doc.doc.forEach((node) => { if (node.attrs.id) ids.push(node.attrs.id); });
    assert.deepEqual(ids.slice(0, 2), ["opening", "overview"]);
    const swapped = canvasTransform(doc, { epoch: doc.epoch, version: doc.version, operation: "move_after", target: "opening", after: "overview" });
    doc.applyTransform(swapped.tr, { kind: "agent", author: "claude" });
    const swappedIds: string[] = [];
    doc.doc.forEach((node) => { if (node.attrs.id) swappedIds.push(node.attrs.id); });
    assert.deepEqual(swappedIds.slice(0, 2), ["overview", "opening"]);
  });
  test("a style patch names an unused class and the steps it took", async () => {
    const doc = await create();
    const result = await runTool("patch_canvas", {
      document_id: doc.id, epoch: doc.epoch, version: doc.version, operation: "styles",
      css: ".narrow { max-width: 330px }\n.opening { color: #112233 }",
    }, { author: "claude", documentId: doc.id });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /\.narrow is not on any element/);
    assert.doesNotMatch(result.text, /\.opening is not on any element/);
    assert.match(result.text, /"steps":1/);
    assert.match(result.text, /styles replaces the whole stylesheet\./);
  });
  test("a nested span names the element and a seven-operation batch changes nothing", async () => {
    const doc = await create();
    const version = doc.version;
    const before = doc.doc.textContent;
    const result = await runTool("patch_canvas", {
      document_id: doc.id, epoch: doc.epoch, version: doc.version,
      operations: [
        { operation: "styles", css: "h1 { color: #112233 }" },
        { operation: "replace_component", target: "eyebrow", html: "<Canvas><Text id=\"eyebrow\">One</Text></Canvas>" },
        { operation: "replace_component", target: "title", html: "<Canvas><Text id=\"title\" as=\"h1\">Two</Text></Canvas>" },
        { operation: "replace_component", target: "intro", html: "<Canvas><Text id=\"intro\"><span class=\"a\"><span class=\"b\">Nested</span></span></Text></Canvas>" },
        { operation: "replace_component", target: "approach", html: "<Canvas><Column id=\"approach\"><Text>Four</Text></Column></Canvas>" },
        { operation: "replace_component", target: "details", html: "<Canvas><Column id=\"details\"><Text>Five</Text></Column></Canvas>" },
        { operation: "remove", target: "next" },
      ],
    }, { author: "claude", documentId: doc.id });
    assert.equal(result.isError, true);
    assert.match(result.text, /Spans cannot nest: <span class="b"> is inside <span class="a"> in <Text id="intro"/);
    assert.equal(doc.version, version);
    assert.equal(doc.doc.textContent, before);
  });
  test("a dry run validates markup when the page cannot be measured", async () => {
    const blank = await documentHub().create({ title: "Blank", doc: compileCanvas("<Canvas></Canvas>").toJSON() });
    const marker = "UniqueDryRunMarkerXYZ-should-not-echo";
    const version = blank.version;
    const dry = await runTool("patch_canvas", {
      document_id: blank.id, epoch: blank.epoch, version: blank.version, operation: "replace",
      html: `<Canvas><Text id="body">${marker}</Text></Canvas>`, dry_run: true,
    }, { author: "claude", documentId: blank.id });
    assert.notEqual(dry.isError, true);
    assert.match(dry.text, /Dry run only/);
    assert.match(dry.text, /The markup is valid/);
    assert.match(dry.text, /Measurement is unavailable/);
    assert.match(dry.text, /Apply this same patch to write it/);
    assert.doesNotMatch(dry.text, /UniqueDryRunMarkerXYZ/);
    assert.equal(blank.version, version);
    assert.equal(blank.doc.textContent.includes(marker), false);
  });
  test("patch_canvas reads HTML and operations from the document folder", async () => {
    const blank = await documentHub().create({ title: "Blank", doc: compileCanvas("<Canvas></Canvas>").toJSON() });
    const ctx = { author: "claude", documentId: blank.id };
    const html = "<Canvas><Text id=\"body\">From a file.</Text></Canvas>";
    const wrote = await runTool("write_file", { path: "piece.html", content: html }, ctx);
    assert.equal(wrote.isError, undefined, wrote.text);
    const both = await runTool("patch_canvas", {
      document_id: blank.id, epoch: blank.epoch, version: blank.version, operation: "replace", html, html_file: "piece.html",
    }, ctx);
    assert.equal(both.isError, true);
    assert.match(both.text, /html or html_file, not both/);
    const fromFile = await runTool("patch_canvas", {
      document_id: blank.id, epoch: blank.epoch, version: blank.version, operation: "replace", html_file: "piece.html",
    }, ctx);
    assert.equal(fromFile.isError, undefined, fromFile.text);
    assert.match(blank.doc.textContent, /From a file/);
    const inline = await runTool("patch_canvas", {
      document_id: blank.id, epoch: blank.epoch, version: blank.version, operation: "replace_component", target: "body", html: "<Canvas><Text id=\"body\">Inline still works.</Text></Canvas>",
    }, ctx);
    assert.equal(inline.isError, undefined, inline.text);
    assert.match(blank.doc.textContent, /Inline still works/);
    await runTool("write_file", { path: "ops.json", content: JSON.stringify([{ operation: "replace_component", target: "body", html_file: "piece.html" }]) }, ctx);
    const fromOps = await runTool("patch_canvas", {
      document_id: blank.id, epoch: blank.epoch, version: blank.version, operations_file: "ops.json",
    }, ctx);
    assert.equal(fromOps.isError, undefined, fromOps.text);
    assert.match(blank.doc.textContent, /From a file/);
    const clash = await runTool("patch_canvas", {
      document_id: blank.id, epoch: blank.epoch, version: blank.version, operations_file: "ops.json", operations: [{ operation: "remove", target: "body" }],
    }, ctx);
    assert.equal(clash.isError, true);
    assert.match(clash.text, /operations or operations_file, not both/);
  });
  test("locked content rejects replacement while allowing a stylesheet change", async () => {
    const doc = await create(); let from = 0;
    doc.doc.descendants((n, pos) => { if (n.isText && n.text!.includes("A better")) from = pos; });
    doc.applyTransform(new Transform(doc.doc).addMark(from, from + 3, schema.mark("locked", { id: "lock" })), { kind: "system", label: "lock" });
    assert.throws(() => patch(doc, { operation: "replace", html: '<Canvas><Text>Oops</Text></Canvas>' }), /locked/);
    assert.doesNotThrow(() => patch(doc, { css: 'h1 {color:blue}' }));
  });
  test("authority validates forged stylesheet steps before mutating the document", async () => {
    const doc = await create(); const before = doc.doc;
    const tr = new Transform(doc.doc).setDocAttribute("canvas", { format: 1, css: 'body {position:fixed}' });
    assert.throws(() => doc.receiveClientSteps(doc.version, tr.steps.map((s) => s.toJSON()), "forged"));
    assert.equal(doc.doc, before);
  });
  test("create_canvas names the document from its h1", async () => {
    const created = await runTool("create_canvas", {
      title: "§ CALCULUS · PROBLEM SET 01",
      html: '<Canvas><Text class="eyebrow">§ CALCULUS · PROBLEM SET 01</Text><Text as="h1">The fundamental theorem</Text></Canvas>',
      css: "",
    }, { author: "claude" });
    assert.equal(created.isError, undefined);
    assert.equal(JSON.parse(created.text).title, "The fundamental theorem");
  });
  test("markdown tools are refused and the valid canvas stays", async () => {
    const doc = await create();
    const before = doc.doc.textContent;
    const version = doc.version;
    const result = await runTool("write_document", { document_id: doc.id, content: "# Replaced" }, { author: "claude", documentId: doc.id });
    assert.equal(result.isError, true);
    assert.match(result.text, /patch_canvas/);
    assert.equal(documentListing(doc), null);
    const note = canvasTurnContext(doc);
    assert.match(note, /^Type: Canvas\./);
    assert.match(note, /A better beginning/);
    assert.doesNotMatch(note, /no need to read/);
    assert.doesNotMatch(note, /&nbsp;/);
    const image = await runTool("insert_image", { document_id: doc.id, file: "graphs.png", alt: "Graph", position: "end" }, { author: "claude", documentId: doc.id });
    assert.equal(image.isError, true);
    assert.match(image.text, new RegExp(`/api/documents/${doc.id}/files/graphs.png`));
    assert.equal(doc.doc.textContent, before);
    assert.equal(doc.version, version);
    const stale = await runTool("inspect_canvas", { document_id: doc.id, epoch: "old", version: 0 }, { author: "claude", documentId: doc.id });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /stale/);
  });
  test("a whole replace is kept for an empty canvas and rejected once it has content", async () => {
    const blank = await documentHub().create({ title: "Blank", doc: compileCanvas("<Canvas></Canvas>").toJSON() });
    const first = await runTool("patch_canvas", {
      document_id: blank.id, epoch: blank.epoch, version: blank.version, operation: "replace", html: "<Canvas><Text id=\"body\">First composition.</Text></Canvas>",
    }, { author: "claude", documentId: blank.id });
    assert.equal(first.isError, undefined, first.text);
    assert.match(blank.doc.textContent, /First composition/);
    const version = blank.version;
    const again = await runTool("patch_canvas", {
      document_id: blank.id, epoch: blank.epoch, version: blank.version, operation: "replace", html: "<Canvas><Text>Second</Text></Canvas>",
    }, { author: "claude", documentId: blank.id });
    assert.equal(again.isError, true);
    assert.match(again.text, /redesign: true/);
    assert.equal(blank.version, version);
    const dry = await runTool("patch_canvas", {
      document_id: blank.id, epoch: blank.epoch, version: blank.version, operation: "replace", html: "<Canvas><Text>Dry</Text></Canvas>", dry_run: true,
    }, { author: "claude", documentId: blank.id });
    assert.equal(dry.isError, true);
    assert.equal(blank.version, version);
    const batched = await runTool("patch_canvas", {
      document_id: blank.id, epoch: blank.epoch, version: blank.version,
      operations: [{ operation: "replace", html: "<Canvas><Text>Batched</Text></Canvas>" }],
    }, { author: "claude", documentId: blank.id });
    assert.equal(batched.isError, true);
    const redesigned = await runTool("patch_canvas", {
      document_id: blank.id, epoch: blank.epoch, version: blank.version, operation: "replace", html: "<Canvas><Text id=\"body\">Rewritten.</Text></Canvas>", redesign: true,
    }, { author: "claude", documentId: blank.id });
    assert.equal(redesigned.isError, undefined, redesigned.text);
    assert.match(blank.doc.textContent, /Rewritten/);
  });
  test("saved history restores both composition and CSS", async () => {
    const doc = await create();
    const saved = await doc.saveVersion("Original canvas", "user");
    const original = doc.doc;
    doc.applyTransform(patch(doc, { operation: "replace", html: '<Canvas><Text>New design</Text></Canvas>', css: 'p {color:blue}' }), { kind: "system", label: "test" });
    await doc.restoreVersion(saved.id, { discard: true });
    assert.ok(doc.doc.eq(original));
  });
});
