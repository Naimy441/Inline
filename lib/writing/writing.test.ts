import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lintWriting, PAGE_WORDS, summarizeLint } from "./lint";
import { cleanAiArtifacts, detectAiTropes, summarizeTropes } from "./tropes";

describe("writing diagnostics", () => {
  it("counts words, sentences and paragraphs", () => {
    const lint = lintWriting("One short line. Another one here!\n\nA second paragraph?");
    assert.equal(lint.words, 9);
    assert.equal(lint.sentences, 3);
    assert.equal(lint.paragraphs, 2);
    assert.equal(lint.pages, 1);
  });

  it("flags an empty document only as empty", () => {
    const lint = lintWriting("   ");
    assert.equal(lint.words, 0);
    assert.equal(lint.paragraphs, 0);
    assert.deepEqual(lint.issues.map((issue) => issue.id), ["empty"]);
  });

  it("flags long sentences and points at the longest one", () => {
    const long = `${"word ".repeat(60).trim()}.`;
    const lint = lintWriting(`${long} Short one.`);
    const issue = lint.issues.find((item) => item.id === "sentences");
    assert.ok(issue);
    assert.equal(issue.find, long);
  });

  it("flags repetitive vocabulary and a single wall of text", () => {
    const lint = lintWriting("the cat and the dog ".repeat(40));
    const ids = lint.issues.map((issue) => issue.id);
    assert.ok(ids.includes("vocab"));
    assert.ok(ids.includes("paragraphs"));
  });

  it("estimates pages from length but never below the editor's page count", () => {
    assert.equal(lintWriting("word ".repeat(PAGE_WORDS * 3)).pages, 3);
    assert.equal(lintWriting("A few words.", 4).pages, 4);
  });

  it("rates simple prose easier than dense prose", () => {
    const simple = lintWriting("The cat sat. The dog ran. We had fun. It was sunny.");
    const dense = lintWriting("Institutional considerations necessitate comprehensive organizational restructuring initiatives encompassing interdepartmental communication methodologies.");
    assert.ok(simple.readingEase > dense.readingEase);
    assert.ok(simple.gradeLevel < dense.gradeLevel);
    assert.equal(simple.vocabularyLevel, "elementary");
    assert.equal(dense.vocabularyLevel, "graduate");
  });

  it("summarizes in one line", () => {
    assert.match(summarizeLint(lintWriting("Hello there.")), /^2 words, 1 paragraphs, ~1 pages\. .*Flags: Very short draft$/);
  });
});

describe("AI tropes", () => {
  it("finds em dashes, stock phrases and their suggested replacements", () => {
    const hits = detectAiTropes("Let's delve into it — it's a testament to effort. We leverage tools.");
    const byTitle = new Map(hits.map((hit) => [hit.title, hit]));
    assert.equal(byTitle.get("1 em dash")?.replace, " - ");
    assert.equal(byTitle.get("AI verb: delve into")?.find, "delve into");
    assert.equal(byTitle.get("AI verb: delve into")?.replace, "look at");
    assert.ok(byTitle.has("AI cliché: testament"));
    assert.equal(byTitle.get("Corporate AI verb: leverage")?.replace, "use");
  });

  it("classifies cadence patterns as structure", () => {
    const [hit] = detectAiTropes("This is not only fast but also cheap.");
    assert.equal(hit?.kind, "structure");
  });

  it("detects hidden characters on every call", () => {
    const text = "Clean​text";
    for (let i = 0; i < 3; i += 1) {
      assert.ok(detectAiTropes(text).some((hit) => hit.kind === "watermark"), `call ${i + 1}`);
    }
    assert.ok(!detectAiTropes("Plain text").some((hit) => hit.kind === "watermark"));
  });

  it("returns nothing for clean prose", () => {
    assert.deepEqual(detectAiTropes("We looked at the numbers and changed the plan."), []);
    assert.equal(summarizeTropes([]), "No common AI tropes or hidden tokens found.");
  });

  it("cleans watermarks, disclaimers, hedges and em dashes", () => {
    const cleaned = cleanAiArtifacts("As an AI language model, I think​ it's important to note that cats—dogs differ.");
    assert.equal(cleaned, "I think cats - dogs differ.");
  });
});
