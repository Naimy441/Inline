import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSoftWrapContinuation, splitEditorParagraphs } from "./paragraphs";

describe("splitEditorParagraphs", () => {
  it("keeps MLA heading lines separate", () => {
    assert.deepEqual(splitEditorParagraphs("Student Name\nInstructor Name\nCourse Name\n15 Sept. 2026"), [
      "Student Name",
      "Instructor Name",
      "Course Name",
      "15 Sept. 2026",
    ]);
  });

  it("joins hard-wrapped body fragments at the end of a paper", () => {
    const parts = splitEditorParagraphs(
      "With human-centred guidance (UNESCO) and clear trustworthiness standards (NIST), AI can \nsupport the \neducation system rather than weaken it—helping young people gain skills.",
    );
    assert.equal(parts.length, 1);
    assert.match(parts[0] ?? "", /AI can support the education system/);
  });

  it("joins mid-paragraph wraps and keeps a new paragraph after a blank line", () => {
    const parts = splitEditorParagraphs(
      "In practice, this means an AI app can \noffer additional explanations for students who need them most.\n\nAI can also expand accessibility.",
    );
    assert.equal(parts.length, 2);
    assert.match(parts[0] ?? "", /AI app can offer additional/);
    assert.equal(parts[1], "AI can also expand accessibility.");
  });

  it("does not join a section heading onto the next paragraph", () => {
    const parts = splitEditorParagraphs("Counterarguments\nCritics argue that AI in schools creates serious risks.");
    assert.deepEqual(parts, ["Counterarguments", "Critics argue that AI in schools creates serious risks."]);
  });
});

describe("isSoftWrapContinuation", () => {
  it("joins lowercase leftovers and leaves capitalized heading lines alone", () => {
    assert.equal(isSoftWrapContinuation("AI can", "support the"), true);
    assert.equal(isSoftWrapContinuation("Student Name", "Instructor Name"), false);
    assert.equal(isSoftWrapContinuation("educational institutions", "unprepared to validate tools"), true);
  });
});
