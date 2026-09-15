import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { acceptAgentEdit, applyAgentEdits, settleAgentEdits, splitParagraphs } from "./edits";
import { applyClientTools } from "./clientTools";
import { createEditor, destroyEditor, installDom, mockClientIo, tool } from "./eval/harness";

before(() => {
  installDom();
});

const MLA = [
  "Student Name",
  "Instructor Name",
  "Course Name",
  "15 Sept. 2026",
  "",
  "Using AI Applications Is a Net Positive for the Next Generation",
  "",
  "Personalized tutors can close gaps that a single classroom cannot.",
  "",
  "Works Cited",
  "",
  "UNESCO. Guidance for Generative AI in Education and Research. 2023.",
].join("\n");

describe("splitParagraphs", () => {
  it("keeps heading lines instead of joining them with spaces", () => {
    const parts = splitParagraphs("Student Name\nInstructor Name\nCourse Name\n15 Sept. 2026");
    assert.deepEqual(parts, ["Student Name", "Instructor Name", "Course Name", "15 Sept. 2026"]);
    assert.equal(parts.join(" ").includes("Student Name Instructor Name Course Name"), true);
    assert.equal(parts.some((part) => part.includes("Student Name Instructor")), false);
  });

  it("joins hard-wrapped leftover lines into one paragraph", () => {
    const parts = splitParagraphs("AI can \nsupport the \neducation system rather than weaken it.");
    assert.deepEqual(parts, ["AI can support the education system rather than weaken it."]);
  });
});

describe("applyAgentEdits line breaks", () => {
  it("inserts each heading line as its own block", () => {
    const editor = createEditor("<div><br></div>");
    const edits = applyAgentEdits(editor, [{ find: "", replace: MLA, operation: "insert" }], null);
    assert.ok(edits.length);
    assert.ok(
      [...editor.querySelectorAll<HTMLElement>(".agent-edit")].every((node) => node.spellcheck === false),
    );
    for (const edit of edits) acceptAgentEdit(editor, edit.id);
    const lines = [...editor.querySelectorAll("div")]
      .map((node) => (node.textContent ?? "").trim())
      .filter((text) => text && text !== "Page break");
    assert.ok(lines.includes("Student Name"));
    assert.ok(lines.includes("Instructor Name"));
    assert.ok(lines.includes("Course Name"));
    assert.ok(lines.includes("15 Sept. 2026"));
    assert.doesNotMatch(editor.textContent ?? "", /Student Name Instructor Name Course Name 15 Sept\. 2026/);
    assert.ok(editor.querySelector("[data-manual-break]"));
    const works = lines.indexOf("Works Cited");
    assert.ok(works > 0);
    destroyEditor(editor);
  });

  it("inserts a hard-wrapped closing paragraph as one block", () => {
    const editor = createEditor("<div><br></div>");
    const edits = applyAgentEdits(
      editor,
      [{
        find: "",
        replace: "With human-centred guidance (UNESCO), AI can \nsupport the \neducation system rather than weaken it.",
        operation: "insert",
      }],
      null,
    );
    for (const edit of edits) acceptAgentEdit(editor, edit.id);
    settleAgentEdits(editor);
    const bodies = [...editor.querySelectorAll("div")]
      .map((node) => (node.textContent ?? "").trim())
      .filter((text) => text && text !== "Page break");
    assert.equal(bodies.length, 1, bodies.join(" | "));
    assert.match(bodies[0] ?? "", /AI can support the education system/);
    destroyEditor(editor);
  });

  it("replacing a heading line does not leave a blank sibling block", () => {
    const editor = createEditor("<div>Student Name</div><div>Instructor Name</div>");
    const edits = applyAgentEdits(editor, [{ find: "Student Name", replace: "John Smith" }], null);
    assert.ok(edits.some((edit) => edit.status === "pending"));
    const lines = [...editor.children]
      .filter((node): node is HTMLElement => node instanceof HTMLElement)
      .map((node) => (node.textContent ?? "").trim());
    assert.equal(lines.includes(""), false, editor.innerHTML);
    assert.match(editor.innerHTML, /John Smith/);
    assert.doesNotMatch(editor.innerHTML, /suggestion-del"><div/i);
    destroyEditor(editor);
  });

  it("keeps paper styles when accepting inserted paragraphs", () => {
    const editor = createEditor("<div><br></div>");
    const { io } = mockClientIo();
    const edits = applyAgentEdits(
      editor,
      [{ find: "", replace: "Centered Title\n\nA body paragraph with a claim.", operation: "insert" }],
      null,
    );
    applyClientTools(
      editor,
      [
        tool("apply_paper_style", { preset: "mla", lastName: "Lopez" }),
        tool("set_alignment", { find: "Centered Title", align: "center" }),
        tool("set_paragraph_indent", { find: "A body paragraph with a claim.", kind: "first-line" }),
      ],
      io,
    );
    for (const edit of edits) acceptAgentEdit(editor, edit.id);
    settleAgentEdits(editor);
    const title = [...editor.querySelectorAll("div")].find((node) => (node.textContent ?? "").trim() === "Centered Title");
    const body = [...editor.querySelectorAll("div")].find((node) => (node.textContent ?? "").includes("body paragraph"));
    assert.equal(editor.querySelectorAll(".agent-edit, .suggestion-add").length, 0);
    assert.equal(title?.style.textAlign, "center");
    assert.ok(body?.classList.contains("indent-first"), body?.outerHTML);
    assert.equal(body?.style.textIndent, "0.5in");
    assert.match(body?.style.fontFamily || editor.style.fontFamily, /Times/);
    assert.equal(body?.style.lineHeight || editor.style.lineHeight, "2");
    destroyEditor(editor);
  });

  it("can center a title after the insert is accepted", () => {
    const editor = createEditor("<div><br></div>");
    const { io } = mockClientIo();
    const edits = applyAgentEdits(
      editor,
      [{ find: "", replace: "Paper Title\n\nA body paragraph.", operation: "insert" }],
      null,
    );
    for (const edit of edits) acceptAgentEdit(editor, edit.id);
    settleAgentEdits(editor);
    applyClientTools(editor, [tool("set_alignment", { find: "Paper Title", align: "center" })], io);
    const title = [...editor.querySelectorAll("div")].find((node) => (node.textContent ?? "").trim() === "Paper Title");
    assert.equal(title?.style.textAlign, "center", title?.outerHTML);
    destroyEditor(editor);
  });
});
