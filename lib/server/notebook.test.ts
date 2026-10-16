import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { notebookDir, runNotebookSource } from "@/lib/server/notebook";

process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-notebook-"));

describe("notebook cells", () => {
  test("javascript runs in the canvas document's own folder", async () => {
    const documentId = "doccanvas1";
    const output = await runNotebookSource({
      documentId,
      cellId: "intro-cell",
      language: "javascript",
      source: `import { writeFileSync } from "node:fs";\nwriteFileSync("note.txt", "inside");\nconsole.log("hello from the canvas");`,
    });
    assert.equal(output.error, null, output.stderr || output.error || "");
    assert.match(output.stdout, /hello from the canvas/);
    const dir = notebookDir(documentId);
    assert.equal(readFileSync(path.join(dir, "note.txt"), "utf8"), "inside");
    assert.equal(existsSync(path.join(dir, "..", "..", "note.txt")), false);
  });

  test("javascript cannot write outside that folder", async () => {
    const output = await runNotebookSource({
      documentId: "doccanvas1",
      cellId: "escape",
      language: "javascript",
      source: `import { writeFileSync } from "node:fs";\nwriteFileSync("../outside.txt", "no");\nconsole.log("wrote");`,
    });
    assert.ok(output.error, "an escape should fail");
    assert.equal(existsSync(path.join(notebookDir("doccanvas1"), "..", "outside.txt")), false);
    assert.doesNotMatch(output.stdout, /wrote/);
  });
});
