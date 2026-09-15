import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DocumentSession } from "./session";

describe("DocumentSession writes", () => {
  it("replaces an exact occurrence and records the edit", () => {
    const session = new DocumentSession({ title: "Doc", text: "alpha beta alpha" });
    const first = session.replaceText("alpha", "ALPHA", 0);
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(session.text, "ALPHA beta alpha");
    const second = session.replaceText("alpha", "omega", 0);
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(session.text, "ALPHA beta omega");
  });

  it("refuses locked passages", () => {
    const session = new DocumentSession({
      title: "Doc",
      text: "Keep this. Change that.",
      locked: [{ id: "1", text: "Keep this." }],
    });
    const locked = session.replaceText("Keep this.", "Nope");
    assert.equal(locked.ok, false);
    const free = session.replaceText("Change that.", "Changed.");
    assert.equal(free.ok, true);
  });

  it("inserts after a paragraph id", () => {
    const session = new DocumentSession({ title: "Doc", text: "One.\n\nTwo." });
    const result = session.insertText("Three.", undefined, "P1");
    assert.equal(result.ok, true);
    assert.match(session.text, /One\.\n\nThree\./);
  });

  it("labels page paragraphs with stable document ids", () => {
    const text = "One.\n\nTwo.\n\nThree.";
    const session = new DocumentSession({
      title: "Doc",
      text,
      pages: [
        { number: 1, start: 0, end: 11, text: text.slice(0, 11) },
        { number: 2, start: 12, end: text.length, text: text.slice(12) },
      ],
    });
    const page2 = session.read({ page: 2 }) as { paragraphs?: Array<{ id: string; text: string }> };
    assert.deepEqual(page2.paragraphs, [{ id: "P3", text: "Three." }]);
    assert.equal(session.search("Three")[0]?.paragraphId, "P3");
  });
});
