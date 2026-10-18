import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "prosemirror-transform";
import { EditorState } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import { compileCanvas, canvasMarkup } from "./compiler";
import { CANVAS_EXAMPLES, CANVAS_GUIDE } from "./examples";
import { darkScreenCanvasCss, validateCanvasCss, scopedCanvasCss } from "./styles";
import { darkColor } from "@/lib/pdf/thumbnail";
import { validateCanvasDocument } from "./model";
import { canvasTransform, readCanvas } from "./operations";
import { documentHub, type LiveDocument } from "@/lib/server/hub";
import { canvasTurnContext, documentListing, runTool } from "@/lib/agent/tools";
import { docToMarkdown } from "@/lib/doc/markdown";
import { schema } from "@/lib/doc/schema";
import { readDocumentFile } from "@/lib/server/store";

process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-canvas-"));
async function create() { const e = CANVAS_EXAMPLES.editorial; return documentHub().create({ title: "Canvas", doc: compileCanvas(e.html, e.css).toJSON() }); }
const patch = (doc: LiveDocument, extra: Partial<Parameters<typeof canvasTransform>[1]>) => canvasTransform(doc, { epoch: doc.epoch, version: doc.version, operation: "styles", ...extra });

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
    assert.doesNotMatch(CANVAS_GUIDE, /\/api\/images/);
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
  test("painted containers must be indivisible, with decoration allowed inside atomic columns", () => {
    assert.throws(() => compileCanvas('<Canvas><Section class="box"><Text>x</Text></Section></Canvas>', '.box {padding:20px;background-color:red}'), /Flowing containers/);
    assert.doesNotThrow(() => compileCanvas('<Canvas><Columns><Column class="box"><Text>x</Text></Column><Column><Text>y</Text></Column></Columns></Canvas>', '.box {padding:20px;background-color:red}'));
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
    doc.applyTransform(patch(doc, { operation: "replace_component", target: "intro", html: '<Canvas><Text>Revised introduction.</Text></Canvas>' }), { kind: "agent", author: "claude" });
    assert.equal(doc.doc.child(1), original);
    assert.ok(readCanvas(doc).html.includes('id="intro"'));
    assert.ok(doc.doc.textContent.includes("Revised introduction."));
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
  test("saved history restores both composition and CSS", async () => {
    const doc = await create();
    const saved = await doc.saveVersion("Original canvas", "user");
    const original = doc.doc;
    doc.applyTransform(patch(doc, { operation: "replace", html: '<Canvas><Text>New design</Text></Canvas>', css: 'p {color:blue}' }), { kind: "system", label: "test" });
    await doc.restoreVersion(saved.id, { discard: true });
    assert.ok(doc.doc.eq(original));
  });
});
