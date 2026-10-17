import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOCUMENT_SNAPSHOT_LIMIT, documentTurnLog } from "@/lib/agent/documentLog";

describe("document turn log", () => {
  it("keeps the markdown from before and after a short edit, plus pending hunks", () => {
    const log = documentTurnLog({
      documentId: "doc-1",
      title: "Notes",
      before: "The meeting is on Tuesday.",
      after: "The meeting is on Thursday.",
      changed: true,
      pending: [{ id: "h1", deleted: "Tuesday", inserted: "Thursday" }],
    });
    assert.deepEqual(log, {
      documentId: "doc-1",
      title: "Notes",
      before: "The meeting is on Tuesday.",
      after: "The meeting is on Thursday.",
      pending: [{ id: "h1", deleted: "Tuesday", inserted: "Thursday" }],
    });
  });

  it("does not keep the document text when the turn changed nothing", () => {
    const after = "A long note. ".repeat(100);
    const log = documentTurnLog({ documentId: "doc", title: "Notes", before: null, after, changed: false, pending: [] });
    assert.deepEqual(log, { documentId: "doc", title: "Notes" });
  });

  it("keeps a diff instead of both texts when the snapshot is too large", () => {
    const unchanged = `${"The harbor stays calm. ".repeat(20)}\n\n`.repeat(80);
    const before = `${unchanged}The meeting is on Tuesday.`;
    const after = `${unchanged}The meeting is on Thursday.`;
    assert.ok(before.length + after.length > DOCUMENT_SNAPSHOT_LIMIT);
    const log = documentTurnLog({
      documentId: "doc",
      title: "Notes",
      before,
      after,
      changed: true,
      pending: [{ id: "h1", deleted: "Tuesday", inserted: "Thursday" }],
    });
    assert.equal(log.before, undefined);
    assert.equal(log.after, undefined);
    assert.ok((log.diff ?? "").includes("[-Tuesday-]{+Thursday+}"), log.diff ?? "");
    assert.equal((log.diff ?? "").includes("harbor"), false);
    assert.deepEqual(log.pending, [{ id: "h1", deleted: "Tuesday", inserted: "Thursday" }]);
  });

  it("records an empty before when the document was created in the turn", () => {
    const log = documentTurnLog({ documentId: "doc", title: "New", before: "", after: "Hi team", changed: true, pending: [] });
    assert.equal(log.before, "");
    assert.equal(log.after, "Hi team");
  });
});
