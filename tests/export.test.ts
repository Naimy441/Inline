import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { useTempDataDir } from "./support/mcp";

/** Downloading a document with Claude's changes still pending. */

useTempDataDir("inline-export-");

let route: typeof import("@/app/api/documents/[id]/export/route");
let hub: ReturnType<typeof import("@/lib/server/hub").documentHub>;
let applyStringEdits: typeof import("@/lib/doc/editing").applyStringEdits;

before(async () => {
  route = await import("@/app/api/documents/[id]/export/route");
  hub = (await import("@/lib/server/hub")).documentHub();
  ({ applyStringEdits } = await import("@/lib/doc/editing"));
});

const get = (id: string, query: string) =>
  route.GET(new Request(`http://localhost:3000/api/documents/${id}/export?${query}`), { params: Promise.resolve({ id }) });

describe("export with pending changes", () => {
  test("includes pending changes by default and can leave them out", async () => {
    const doc = await hub.create({ markdown: "The meeting is on Tuesday." });
    doc.applyTransform(applyStringEdits(doc.doc, [{ old_string: "Tuesday", new_string: "Thursday" }]), { kind: "agent", author: "chat-1" });
    assert.equal(doc.hunks.length, 1);

    assert.equal(await (await get(doc.id, "format=md")).text(), "The meeting is on Thursday.");
    assert.equal(await (await get(doc.id, "format=md&changes=with")).text(), "The meeting is on Thursday.");
    assert.equal(await (await get(doc.id, "format=txt&changes=without")).text(), "The meeting is on Tuesday.");
    const docx = await get(doc.id, "format=docx&changes=without");
    assert.equal(docx.status, 200);
    assert.ok((await docx.arrayBuffer()).byteLength > 1000);

    // Exporting never changes the document itself.
    assert.equal(doc.hunks.length, 1);
    assert.match(doc.doc.textContent, /Thursday/);
  });

  test("rejects an unknown changes option", async () => {
    const doc = await hub.create({ markdown: "Hi." });
    assert.equal((await get(doc.id, "format=md&changes=maybe")).status, 400);
  });
});
