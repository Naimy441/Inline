import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DocumentSession } from "../mcp/session";
import {
  leftoverWhitespaceIssues,
  blankPageIssues,
  messyFormattingIssues,
  tidyDocumentText,
} from "../../writing/documentQuality";
import { MESSY_MULTI_PAGE, CLEAN_MULTI_PAGE } from "./cases";

const DELETE_CASES: Array<{ name: string; text: string; find: string; occurrence?: number; expect: string }> = [
  { name: "middle word", text: "The cat sat.", find: "cat", expect: "The sat." },
  { name: "first word", text: "Alpha beta gamma.", find: "Alpha ", expect: "beta gamma." },
  { name: "last word", text: "Alpha beta gamma.", find: " gamma", expect: "Alpha beta." },
  { name: "whole sentence", text: "Keep this. Drop this. Keep that.", find: "Drop this. ", expect: "Keep this. Keep that." },
  { name: "middle paragraph", text: "One stays.\n\nGone entirely.\n\nThree stays.", find: "Gone entirely.", expect: "One stays.\n\nThree stays." },
  { name: "first paragraph", text: "Delete me.\n\nKeep me.", find: "Delete me.", expect: "Keep me." },
  { name: "last paragraph", text: "Keep me.\n\nDelete me.", find: "Delete me.", expect: "Keep me." },
  { name: "two paragraphs", text: "A stays.\n\nB goes.\n\nC goes.\n\nD stays.", find: "B goes.\n\nC goes.", expect: "A stays.\n\nD stays." },
  { name: "second occurrence", text: "alpha beta alpha", find: "alpha", occurrence: 1, expect: "alpha beta" },
  { name: "spaces around a word", text: "foo   bar   baz", find: "bar", expect: "foo baz" },
  { name: "nbsp around a word", text: "foo\u00a0bar\u00a0baz", find: "bar", expect: "foo baz" },
  { name: "clause in a sentence", text: "The museum, which is closed, opens in May.", find: ", which is closed,", expect: "The museum opens in May." },
  { name: "parenthetical", text: "Call Jan (the editor) tomorrow.", find: " (the editor)", expect: "Call Jan tomorrow." },
  { name: "quoted phrase", text: 'She said "delete this" twice.', find: '"delete this" ', expect: "She said twice." },
  { name: "list line", text: "- keep\n- drop\n- keep", find: "- drop\n", expect: "- keep\n- keep" },
  { name: "entire document", text: "Only this.", find: "Only this.", expect: "" },
  { name: "extra blank lines around a paragraph", text: "Keep.\n\n\n\nDrop.\n\n\n\nKeep two.", find: "Drop.", expect: "Keep.\n\nKeep two." },
  { name: "heading-like line", text: "TITLE LINE\n\nBody remains here.", find: "TITLE LINE", expect: "Body remains here." },
  { name: "ascii row", text: "Intro.\n\nName | Role | Team\n\nOutro.", find: "Name | Role | Team", expect: "Intro.\n\nOutro." },
  { name: "sentence from a paragraph", text: "Hello. World. Moon.", find: "World. ", expect: "Hello. Moon." },
  { name: "trailing leftover spaces", text: "Keep this.    junk    ", find: "junk", expect: "Keep this." },
  { name: "leading leftover spaces", text: "    junk    Keep this.", find: "junk", expect: "Keep this." },
  { name: "duplicate blank pages worth of newlines", text: "Start.\n\n\n\n\n\n\nMiddle gone.\n\n\n\n\nEnd.", find: "Middle gone.", expect: "Start.\n\nEnd." },
  { name: "page-sized middle block", text: "Opening stays.\n\nThe old warehouse is damp and should be removed entirely from this draft.\n\nClosing stays.", find: "The old warehouse is damp and should be removed entirely from this draft.", expect: "Opening stays.\n\nClosing stays." },
];

describe("session deletes leave a tidy draft", () => {
  for (const row of DELETE_CASES) {
    it(row.name, () => {
      const session = new DocumentSession({ title: "Doc", text: row.text });
      const result = session.deleteText(row.find, row.occurrence ?? 0);
      assert.equal(result.ok, true, result.ok ? "" : result.error);
      assert.equal(session.text, row.expect);
      assert.deepEqual(leftoverWhitespaceIssues(session.text), []);
      assert.deepEqual(blankPageIssues(session.pages), []);
    });
  }

  it("records a delete that also removes leftover spaces so the page suggestion stays tidy", () => {
    const original = "The cat sat.";
    const session = new DocumentSession({ title: "Doc", text: original });
    session.deleteText("cat");
    const edit = session.edits[0];
    assert.ok(edit);
    assert.equal(original.slice(0, original.indexOf(edit.find)) + edit.replace + original.slice(original.indexOf(edit.find) + edit.find.length), "The sat.");
  });

  it("records a paragraph delete that also removes extra blank lines", () => {
    const original = "Keep.\n\n\n\nDrop.\n\n\n\nKeep two.";
    const session = new DocumentSession({ title: "Doc", text: original });
    session.deleteText("Drop.");
    const edit = session.edits[0];
    assert.ok(edit);
    const applied = original.replace(edit.find, edit.replace);
    assert.equal(applied, "Keep.\n\nKeep two.");
  });

  it("drops an emptied middle page from the page map", () => {
    const one = "Opening stays.\n\n";
    const two = "The old warehouse is damp and should be removed entirely from this draft.\n\n";
    const three = "Closing stays.";
    const text = `${one}${two}${three}`;
    const session = new DocumentSession({
      title: "Doc",
      text,
      pages: [
        { number: 1, start: 0, end: one.length, text: one },
        { number: 2, start: one.length, end: one.length + two.length, text: two },
        { number: 3, start: one.length + two.length, end: text.length, text: three },
      ],
    });
    const result = session.deleteText(two.trim());
    assert.equal(result.ok, true);
    assert.deepEqual(blankPageIssues(session.pages), []);
    assert.ok(session.pages.every((page) => page.text.trim()));
    assert.ok(session.pages.length <= 2);
  });
});

describe("session replacements do not invent blank gaps", () => {
  const rows: Array<{ name: string; text: string; find: string; replace: string; expect: string }> = [
    { name: "shorter word", text: "The cathedral stood.", find: "cathedral", replace: "church", expect: "The church stood." },
    { name: "empty replace is a delete", text: "Keep. Drop. Keep.", find: "Drop. ", replace: "", expect: "Keep. Keep." },
    { name: "paragraph rewrite", text: "Alpha.\n\nOld paragraph with noise.\n\nOmega.", find: "Old paragraph with noise.", replace: "Quiet paragraph.", expect: "Alpha.\n\nQuiet paragraph.\n\nOmega." },
    { name: "collapse a shout", text: "HELLO WORLD THIS IS FINE", find: "HELLO WORLD THIS IS FINE", replace: "Hello world, this is fine.", expect: "Hello world, this is fine." },
    { name: "join broken lines", text: "this\nbroken\nlines", find: "this\nbroken\nlines", replace: "this broken lines", expect: "this broken lines" },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const session = new DocumentSession({ title: "Doc", text: row.text });
      const result = session.replaceText(row.find, row.replace);
      assert.equal(result.ok, true, result.ok ? "" : result.error);
      assert.equal(session.text, row.expect);
      assert.deepEqual(leftoverWhitespaceIssues(session.text), []);
    });
  }
});

describe("messy multi-page cleanup", () => {
  it("flags the fixture before cleanup", () => {
    assert.ok(messyFormattingIssues(MESSY_MULTI_PAGE).length > 0);
    assert.ok(leftoverWhitespaceIssues(MESSY_MULTI_PAGE).length > 0);
  });

  it("tidyDocumentText squeezes spaces and blank lines", () => {
    const tidied = tidyDocumentText(MESSY_MULTI_PAGE);
    assert.deepEqual(
      leftoverWhitespaceIssues(tidied).filter((issue) => issue !== "shouting-caps"),
      [],
    );
    assert.doesNotMatch(tidied, /\n{3,}/);
    assert.doesNotMatch(tidied, / {2,}/);
  });

  it("a full-document replace can land a clean multi-page draft", () => {
    const session = new DocumentSession({
      title: "Doc",
      text: MESSY_MULTI_PAGE,
      pages: [
        { number: 1, start: 0, end: 120, text: MESSY_MULTI_PAGE.slice(0, 120) },
        { number: 2, start: 120, end: 260, text: MESSY_MULTI_PAGE.slice(120, 260) },
        { number: 3, start: 260, end: MESSY_MULTI_PAGE.length, text: MESSY_MULTI_PAGE.slice(260) },
      ],
    });
    const result = session.replaceText(MESSY_MULTI_PAGE, CLEAN_MULTI_PAGE);
    assert.equal(result.ok, true);
    assert.equal(session.text, CLEAN_MULTI_PAGE);
    assert.deepEqual(leftoverWhitespaceIssues(session.text), []);
    assert.deepEqual(messyFormattingIssues(session.text), []);
    assert.deepEqual(blankPageIssues(session.pages), []);
  });

  it("stepwise deletes of blank gaps do not leave empty pages", () => {
    const session = new DocumentSession({ title: "Doc", text: "Keep.\n\n\n\n\nDrop this island.\n\n\n\nKeep two." });
    session.deleteText("Drop this island.");
    assert.equal(session.text, "Keep.\n\nKeep two.");
    assert.deepEqual(blankPageIssues(session.pages), []);
  });
});
