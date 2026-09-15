import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeGrammarEdits } from "./grammar";

describe("grammar sanitize", () => {
  it("drops invented finds and oversized rewrites", () => {
    const source = "I went to the store.";
    const edits = sanitizeGrammarEdits(source, [
      { find: "I went to the store.", replace: "I went to the shop." },
      { find: "missing", replace: "nope" },
      { find: "I went to the store.", replace: "A completely different essay about rivers and cities." },
    ]);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].replace, "I went to the shop.");
  });

  it("keeps newline counts aligned", () => {
    const source = "One.\nTwo.";
    const edits = sanitizeGrammarEdits(source, [{ find: "One.\nTwo.", replace: "One. Two." }]);
    assert.equal(edits.length, 0);
  });
});
