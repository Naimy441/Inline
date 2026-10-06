import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diffParagraphs, diffStats, diffWords } from "@/lib/doc/textDiff";

const render = (parts: ReturnType<typeof diffWords>) => parts.map((part) => (part.kind === "same" ? part.text : part.kind === "insert" ? `{+${part.text}+}` : `[-${part.text}-]`)).join("");

describe("text diff", () => {
  it("marks changed words only", () => {
    assert.equal(render(diffWords("The meeting is on Tuesday.", "The meeting is on Thursday.")), "The meeting is on [-Tuesday-]{+Thursday+}.");
    assert.equal(render(diffWords("a b c", "a c")), "a [-b -]c");
    assert.equal(render(diffWords("", "new")), "{+new+}");
  });

  it("matches paragraphs, then words inside edited ones", () => {
    const result = diffParagraphs("Intro.\nKeep me.\nOld line here.\nGone.", "Intro.\nKeep me.\nNew line here.\nAdded one.");
    assert.deepEqual(
      result.map((p) => p.kind),
      ["same", "same", "changed", "changed"],
    );
    assert.equal(render(result[2]!.parts), "[-Old-]{+New+} line here.");
    const added = diffParagraphs("A.", "A.\nB.");
    assert.deepEqual(added.map((p) => p.kind), ["same", "insert"]);
    const removed = diffParagraphs("A.\nB.\nC.", "A.\nC.");
    assert.deepEqual(removed.map((p) => p.kind), ["same", "delete", "same"]);
  });

  it("counts words added and removed", () => {
    assert.deepEqual(diffStats(diffParagraphs("one two three", "one 2 three four")), { added: 2, removed: 1 });
    assert.deepEqual(diffStats(diffParagraphs("same", "same")), { added: 0, removed: 0 });
  });

  it("handles large documents without blowing up", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `Paragraph ${i} with some words.`).join("\n");
    const after = before.replace("Paragraph 1500 with", "Paragraph 1500 now with");
    const result = diffParagraphs(before, after);
    assert.equal(result.filter((p) => p.kind !== "same").length, 1);
    assert.deepEqual(diffStats(result), { added: 1, removed: 0 });
  });
});
