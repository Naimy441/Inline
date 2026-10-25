import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isCanvas, isUnrestrictedCanvas } from "./compiler";
import { UNRESTRICTED_STARTER, readUnrestrictedCanvas, switchToUnrestrictedTransform, unrestrictedCanvasDoc, unrestrictedTransform, validateUnrestrictedHtml } from "./unrestricted";
import { compileCanvas } from "./compiler";
import { canvasTransform, readCanvas } from "./operations";
import { validateCanvasDocument } from "./model";
import { documentHub, type LiveDocument } from "@/lib/server/hub";

process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-unrestricted-"));

const PAGE = `<!doctype html><html><head><style>h1 { color: red; }</style></head><body><h1>Hello</h1><p>Hello again</p></body></html>`;

async function createUnrestricted(html = PAGE) {
  return documentHub().create({ title: "Free page", doc: unrestrictedCanvasDoc(html).toJSON() });
}

function applyWrite(doc: LiveDocument, patch: Parameters<typeof unrestrictedTransform>[1]) {
  const tr = unrestrictedTransform(doc, patch);
  doc.applyTransform(tr, { kind: "agent", author: "test", turn: "turn-1", tool: "write_unrestricted_canvas" });
}

describe("unrestricted canvas", () => {
  test("is a canvas, but not an SDK canvas", async () => {
    const doc = await createUnrestricted();
    assert.equal(isCanvas(doc.doc), true);
    assert.equal(isUnrestrictedCanvas(doc.doc), true);
    assert.equal(doc.meta.kind, "canvas");
    assert.equal(doc.meta.canvasMode, "unrestricted");
    assert.throws(() => readCanvas(doc), /read_unrestricted_canvas/);
    assert.throws(() => canvasTransform(doc, { epoch: doc.epoch, version: doc.version, operation: "styles", css: "" }), /read_unrestricted_canvas/);
  });

  test("stores the HTML exactly and keeps the ProseMirror body empty", async () => {
    const doc = await createUnrestricted();
    const state = readUnrestrictedCanvas(doc);
    assert.equal(state.html, PAGE);
    assert.equal(doc.doc.textContent, "");
    assert.equal(doc.doc.childCount, 1);
    assert.equal(doc.doc.firstChild?.type.name, "paragraph");
  });

  test("new canvases start from a complete HTML document", async () => {
    const doc = await createUnrestricted(UNRESTRICTED_STARTER);
    assert.match(readUnrestrictedCanvas(doc).html, /^<!doctype html>/);
  });

  test("a whole-document write needs the current epoch and version", async () => {
    const doc = await createUnrestricted();
    const { epoch, version } = readUnrestrictedCanvas(doc);
    assert.throws(() => unrestrictedTransform(doc, { epoch: "old", version, html: PAGE }), /revision/);
    assert.throws(() => unrestrictedTransform(doc, { epoch, version: version + 1, html: PAGE }), /revision/);
    applyWrite(doc, { epoch, version, html: "<!doctype html><html><body><p>New</p></body></html>" });
    assert.match(readUnrestrictedCanvas(doc).html, /New/);
    assert.equal(readUnrestrictedCanvas(doc).version, version + 1);
  });

  test("exact edits must match once, and a batch applies all or nothing", async () => {
    const doc = await createUnrestricted();
    const { epoch, version } = readUnrestrictedCanvas(doc);
    assert.throws(() => unrestrictedTransform(doc, { epoch, version, edits: [{ old_string: "missing", new_string: "x" }] }), /not found/);
    assert.throws(() => unrestrictedTransform(doc, { epoch, version, edits: [{ old_string: "<", new_string: "&lt;" }] }), /more than once/);
    assert.throws(
      () => unrestrictedTransform(doc, { epoch, version, edits: [{ old_string: "Hello again", new_string: "Bye" }, { old_string: "nope", new_string: "x" }] }),
      /not found/,
    );
    assert.equal(readUnrestrictedCanvas(doc).html, PAGE);
    applyWrite(doc, { epoch, version, edits: [{ old_string: "color: red;", new_string: "color: blue;" }, { old_string: "Hello again", new_string: "Bye" }] });
    const html = readUnrestrictedCanvas(doc).html;
    assert.match(html, /color: blue;/);
    assert.match(html, /<p>Bye<\/p>/);
  });

  test("a write takes either html or edits, and refuses an empty document", async () => {
    const doc = await createUnrestricted();
    const { epoch, version } = readUnrestrictedCanvas(doc);
    assert.throws(() => unrestrictedTransform(doc, { epoch, version }), /Pass html/);
    assert.throws(() => unrestrictedTransform(doc, { epoch, version, html: PAGE, edits: [] }), /Not both|Pass html/);
    assert.throws(() => validateUnrestrictedHtml("<p>just a fragment</p>"), /complete HTML document/);
  });

  test("an SDK canvas is not read as an unrestricted one", async () => {
    const sdk = compileCanvas("<Canvas><Text>Hi</Text></Canvas>");
    const doc = await documentHub().create({ title: "SDK", doc: sdk.toJSON() });
    assert.equal(isUnrestrictedCanvas(doc.doc), false);
    assert.throws(() => unrestrictedTransform(doc, { epoch: doc.epoch, version: doc.version, html: PAGE }), /not an unrestricted Canvas/);
  });

  test("an SDK canvas switches permanently to an unrestricted one", async () => {
    const doc = await documentHub().create({ title: "SDK", doc: compileCanvas("<Canvas><Section><Text>Hi</Text></Section></Canvas>").toJSON() });
    assert.throws(() => switchToUnrestrictedTransform(doc, { epoch: "old", version: doc.version, html: PAGE }), /revision/);
    assert.throws(() => switchToUnrestrictedTransform(doc, { epoch: doc.epoch, version: doc.version, html: "<p>fragment</p>" }), /complete HTML document/);
    doc.applyTransform(switchToUnrestrictedTransform(doc, { epoch: doc.epoch, version: doc.version, html: PAGE }), { kind: "agent", author: "test", turn: "turn-1", tool: "switch_to_unrestricted_canvas" });
    assert.equal(isUnrestrictedCanvas(doc.doc), true);
    assert.equal(doc.meta.canvasMode, "unrestricted");
    assert.equal(readUnrestrictedCanvas(doc).html, PAGE);
    assert.throws(() => switchToUnrestrictedTransform(doc, { epoch: doc.epoch, version: doc.version, html: PAGE }), /already unrestricted/);
  });

  test("the starter is a paged page", () => {
    assert.match(UNRESTRICTED_STARTER, /@page/);
    assert.match(UNRESTRICTED_STARTER, /break-after: page/);
  });

  test("the document model rejects SDK components inside an unrestricted canvas", () => {
    const doc = unrestrictedCanvasDoc(PAGE);
    const sdk = compileCanvas("<Canvas><Section><Text>Hi</Text></Section></Canvas>");
    const mixed = doc.type.create({ canvas: { format: 2, html: PAGE } }, sdk.content);
    assert.throws(() => validateCanvasDocument(mixed), /no SDK components/);
  });
});

describe("untouched untitled documents", () => {
  test("are dropped from the list, and anything with content or a title stays", async () => {
    const hub = documentHub();
    const blank = await hub.create({});
    const canvas = await hub.create({ title: "Untitled canvas", doc: compileCanvas("<Canvas></Canvas>").toJSON() });
    const written = await hub.create({ markdown: "Some words" });
    const named = await hub.create({ title: "Plans" });
    const free = await hub.create({ title: "Untitled canvas", doc: unrestrictedCanvasDoc(PAGE).toJSON() });
    for (const doc of [blank, canvas, written, named, free]) await doc.flush();
    const later = Date.now() + 60_000;
    assert.equal(await hub.purgePristine(later), 2);
    const ids = new Set((await hub.list()).map((meta) => meta.id));
    assert.deepEqual([blank, canvas, written, named, free].map((doc) => ids.has(doc.id)), [false, false, true, true, true]);
  });

  test("stay while they are new", async () => {
    const hub = documentHub();
    const fresh = await hub.create({});
    await fresh.flush();
    assert.equal(await hub.purgePristine(), 0);
    assert.ok((await hub.list()).some((meta) => meta.id === fresh.id));
  });
});
