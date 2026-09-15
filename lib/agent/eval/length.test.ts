import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DocumentSession } from "../mcp/session";
import { leftoverWhitespaceIssues, gradeLength, gradePromptLength, words, sentences, paragraphs, PAGE_WORDS } from "../../writing/documentQuality";
import { parseWritingTargets } from "../../writing/review";

const LENGTH_WRITES: Array<{ prompt: string; text: () => string; spec: Parameters<typeof gradeLength>[1] }> = [
  { prompt: "Write exactly 1 sentence.", text: () => sentences(1), spec: { kind: "sentences", value: 1 } },
  { prompt: "Write exactly two sentences.", text: () => sentences(2), spec: { kind: "sentences", value: 2 } },
  { prompt: "Write exactly five sentences.", text: () => sentences(5), spec: { kind: "sentences", value: 5 } },
  { prompt: "Write exactly 8 sentences.", text: () => sentences(8), spec: { kind: "sentences", value: 8 } },
  { prompt: "Write exactly one paragraph.", text: () => paragraphs(1), spec: { kind: "paragraphs", value: 1 } },
  { prompt: "Write exactly two paragraphs.", text: () => paragraphs(2), spec: { kind: "paragraphs", value: 2 } },
  { prompt: "Write exactly 3 paragraphs.", text: () => paragraphs(3), spec: { kind: "paragraphs", value: 3 } },
  { prompt: "Write exactly 4 paragraphs.", text: () => paragraphs(4), spec: { kind: "paragraphs", value: 4 } },
  { prompt: "Write exactly 50 words.", text: () => words(50), spec: { kind: "words", value: 50 } },
  { prompt: "Write exactly 100 words.", text: () => words(100), spec: { kind: "words", value: 100 } },
  { prompt: "Write exactly 200 words.", text: () => words(200), spec: { kind: "words", value: 200 } },
  { prompt: "Write exactly one page.", text: () => words(PAGE_WORDS), spec: { kind: "one_page_exact" } },
  { prompt: "Fill one page to the brim.", text: () => words(PAGE_WORDS), spec: { kind: "one_page_brim" } },
  { prompt: "Write at least 3 paragraphs.", text: () => paragraphs(3), spec: { kind: "paragraphs", value: 3 } },
  { prompt: "Write at most 1 paragraph.", text: () => paragraphs(1), spec: { kind: "paragraphs", value: 1 } },
];

describe("exact-length writing through document tools", () => {
  for (const row of LENGTH_WRITES) {
    it(row.prompt, () => {
      const session = new DocumentSession({ title: "Doc", text: "" });
      const body = row.text();
      const result = session.insertText(body);
      assert.equal(result.ok, true, result.ok ? "" : result.error);
      const grade = gradeLength(session.text, row.spec);
      assert.equal(grade.ok, true, grade.detail);
      const parsed = gradePromptLength(row.prompt, session.text);
      if (row.prompt.includes("brim") || row.prompt.includes("one page")) {
        assert.equal(parsed.ok, true, parsed.detail);
      } else {
        const targets = parseWritingTargets(row.prompt);
        assert.ok(targets, `did not parse ${row.prompt}`);
        assert.equal(parsed.ok, true, parsed.detail);
      }
      assert.deepEqual(leftoverWhitespaceIssues(session.text), []);
    });
  }

  it("replacing a placeholder with two paragraphs does not leave the placeholder", () => {
    const session = new DocumentSession({ title: "Doc", text: "Placeholder." });
    session.replaceText("Placeholder.", paragraphs(2));
    assert.equal(gradeLength(session.text, { kind: "paragraphs", value: 2 }).ok, true);
    assert.doesNotMatch(session.text, /Placeholder/);
  });

  it("rejects a two-paragraph draft when five sentences were required", () => {
    const session = new DocumentSession({ title: "Doc", text: "" });
    session.insertText(paragraphs(2));
    assert.equal(gradeLength(session.text, { kind: "sentences", value: 5 }).ok, false);
  });

  it("rejects a short note when a full page was required", () => {
    const session = new DocumentSession({ title: "Doc", text: "" });
    session.insertText(words(80));
    assert.equal(gradeLength(session.text, { kind: "one_page_exact" }).ok, false);
    assert.equal(gradeLength(session.text, { kind: "one_page_brim" }).ok, false);
  });

  it("rejects overflow past one page when filling to the brim", () => {
    const session = new DocumentSession({ title: "Doc", text: "" });
    session.insertText(words(620));
    assert.equal(gradeLength(session.text, { kind: "one_page_brim" }).ok, false);
  });
});
