import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { leftoverWhitespaceIssues, messyFormattingIssues, tidyDocumentText, gradeLength, gradePromptLength, words, sentences, paragraphs, PAGE_WORDS, markdownListIssues, markdownTableIssues } from "./documentQuality";
import { parseWritingTargets, reviewProposedWriting } from "./review";

describe("document quality graders", () => {
  it("flags leftover spaces, blank lines, and punctuation gaps", () => {
    const issues = leftoverWhitespaceIssues("  Hello   world ,\n\n\nThere.\n");
    assert.ok(issues.includes("double-space"));
    assert.ok(issues.includes("extra-blank-lines"));
    assert.ok(issues.includes("leading-whitespace"));
    assert.ok(issues.includes("space-before-punctuation"));
  });

  it("accepts a clean draft", () => {
    assert.deepEqual(leftoverWhitespaceIssues("Hello world.\n\nNext paragraph."), []);
  });

  it("flags shouting caps and tabs in messy copy", () => {
    const issues = messyFormattingIssues("THIS HEADLINE NEVER STOPS SHOUTING AT THE READER\n\tindented");
    assert.ok(issues.includes("shouting-caps"));
    assert.ok(issues.includes("tabs"));
  });

  it("tidies nbsp, double spaces, and extra blank lines", () => {
    assert.equal(tidyDocumentText("A\u00a0\u00a0B.\n\n\n\nC.  "), "A B.\n\nC.");
  });
});

describe("list and table graders", () => {
  it("accepts markdown bullets and numbered lists", () => {
    assert.deepEqual(markdownListIssues("- Milk\n- Eggs\n- Bread", "ul", 3), []);
    assert.deepEqual(markdownListIssues("1. Preheat\n2. Mix\n3. Bake\n4. Cool", "ol", 4), []);
    assert.ok(markdownListIssues("Just prose.", "ul", 3).length > 0);
  });

  it("accepts markdown tables", () => {
    const table = "| Name | Role |\n| --- | --- |\n| Ada | Engineer |\n| Lin | Editor |";
    assert.deepEqual(markdownTableIssues(table, 3, 2), []);
    assert.ok(markdownTableIssues("no table", 2, 2).length > 0);
  });
});

describe("length graders", () => {
  it("counts generated sentences, paragraphs, and words", () => {
    assert.equal(gradeLength(sentences(5), { kind: "sentences", value: 5 }).ok, true);
    assert.equal(gradeLength(paragraphs(2), { kind: "paragraphs", value: 2 }).ok, true);
    assert.equal(gradeLength(words(50), { kind: "words", value: 50 }).ok, true);
    assert.equal(gradeLength(sentences(4), { kind: "sentences", value: 5 }).ok, false);
  });

  it("treats one page as about 500 words, and brim as nearly full", () => {
    assert.equal(gradeLength(words(500), { kind: "one_page_exact" }).ok, true);
    assert.equal(gradeLength(words(500), { kind: "one_page_brim" }).ok, true);
    assert.equal(gradeLength(words(480), { kind: "one_page_brim" }).ok, true);
    assert.equal(gradeLength(words(200), { kind: "one_page_exact" }).ok, false);
    assert.equal(gradeLength(words(400), { kind: "one_page_brim" }).ok, false);
    assert.equal(PAGE_WORDS, 500);
  });

  const prompts: Array<{ prompt: string; check: (text: string) => boolean }> = [
    { prompt: "Write exactly two paragraphs.", check: (text) => gradePromptLength("Write exactly two paragraphs.", text).ok },
    { prompt: "Write exactly five sentences.", check: (text) => gradePromptLength("Write exactly five sentences.", text).ok },
    { prompt: "Write exactly 3 sentences.", check: (text) => gradePromptLength("Write exactly 3 sentences.", text).ok },
    { prompt: "Write one paragraph.", check: (text) => gradePromptLength("Write one paragraph.", text).ok },
    { prompt: "Write exactly 50 words.", check: (text) => gradePromptLength("Write exactly 50 words.", text).ok },
    { prompt: "Write at least 3 paragraphs.", check: (text) => gradePromptLength("Write at least 3 paragraphs.", text).ok },
    { prompt: "Write at most 1 paragraph.", check: (text) => gradePromptLength("Write at most 1 paragraph.", text).ok },
    { prompt: "Write exactly 8 sentences.", check: (text) => gradePromptLength("Write exactly 8 sentences.", text).ok },
  ];

  it("parses common length instructions", () => {
    assert.equal(parseWritingTargets("Write exactly two paragraphs.")?.paragraphs?.value, 2);
    assert.equal(parseWritingTargets("Write exactly five sentences.")?.sentences?.value, 5);
    assert.equal(parseWritingTargets("Write exactly 50 words.")?.words?.value, 50);
    assert.equal(parseWritingTargets("Write at least 3 paragraphs.")?.paragraphs?.mode, "min");
    assert.equal(parseWritingTargets("Fill one page to the brim about trees.")?.pages?.value, 1);
    assert.equal(gradePromptLength("Fill one page to the brim about trees.", words(500)).ok, true);
  });

  for (const row of prompts) {
    it(`grades prompt: ${row.prompt}`, () => {
      const targets = parseWritingTargets(row.prompt);
      assert.ok(targets);
      let text = "Placeholder.";
      if (targets?.paragraphs) text = paragraphs(targets.paragraphs.value);
      else if (targets?.sentences) text = sentences(targets.sentences.value);
      else if (targets?.words) text = words(targets.words.value);
      if (targets?.paragraphs?.mode === "min") text = paragraphs(targets.paragraphs.value);
      if (targets?.paragraphs?.mode === "max") text = paragraphs(Math.max(1, targets.paragraphs.value));
      assert.equal(row.check(text), true);
    });
  }

  it("reviewProposedWriting agrees with generated two-paragraph inserts", () => {
    const targets = parseWritingTargets("Write exactly two paragraphs.");
    const text = paragraphs(2);
    const review = reviewProposedWriting("", [{ find: "", replace: text }], targets ? { ...targets, scope: "document" } : null);
    assert.equal(review.ok, true, review.summary);
  });
});
