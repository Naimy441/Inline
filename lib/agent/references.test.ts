import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wordCount } from "@/lib/doc/editing";
import { PAGE_BREAK, markdownToDoc } from "@/lib/doc/markdown";
import { DEFAULT_SETTINGS } from "@/lib/doc/settings";
import { wordsPerPageFromSettings } from "@/lib/agent/pages";
import { linkedDocumentContext, pagesOf } from "@/lib/agent/references";

const SAMPLE = `The formal page keeps its distance.\n\n${PAGE_BREAK}\n\nThe warm page talks like a friend.`;

describe("document pages", () => {
  it("splits on page breaks so a writing sample can be one page", () => {
    const { pages, measured } = pagesOf(markdownToDoc(SAMPLE), DEFAULT_SETTINGS, null);
    assert.equal(measured, false);
    assert.equal(pages.length, 2);
    assert.match(pages[0]!.markdown, /The formal page keeps its distance/);
    assert.doesNotMatch(pages[0]!.markdown, /warm page/);
    assert.match(pages[1]!.markdown, /The warm page talks like a friend/);
    assert.doesNotMatch(pages[1]!.markdown, /formal page/);
  });

  it("uses the editor's page starts when the layout is current", () => {
    const doc = markdownToDoc("Alpha on the first page.\n\nBeta on the second page.");
    let split = doc.content.size;
    doc.forEach((child, pos) => {
      if (child.textContent.includes("Beta")) split = pos;
    });
    const { pages, measured } = pagesOf(doc, DEFAULT_SETTINGS, { starts: [split] });
    assert.equal(measured, true);
    assert.equal(pages.length, 2);
    assert.match(pages[0]!.markdown, /Alpha on the first page/);
    assert.doesNotMatch(pages[0]!.markdown, /Beta/);
    assert.match(pages[1]!.markdown, /Beta on the second page/);
    assert.doesNotMatch(pages[1]!.markdown, /Alpha/);
  });

  it("cuts a page that starts mid-paragraph", () => {
    const doc = markdownToDoc("Alpha stays. Beta goes.");
    let at = 0;
    doc.descendants((child, pos) => {
      if (!child.isText || !child.text) return;
      const index = child.text.indexOf("Beta");
      if (index >= 0) at = pos + index;
    });
    const { pages } = pagesOf(doc, DEFAULT_SETTINGS, { starts: [at] });
    assert.equal(pages.length, 2);
    assert.match(pages[0]!.markdown, /Alpha stays/);
    assert.doesNotMatch(pages[0]!.markdown, /Beta/);
    assert.match(pages[1]!.markdown, /Beta goes/);
  });

  it("estimates further pages when a stretch is longer than one page", () => {
    const perPage = wordsPerPageFromSettings(DEFAULT_SETTINGS);
    const filler = "river ".repeat(perPage).trim();
    const doc = markdownToDoc(`STARTWORD begins the document.\n\n${filler}\n\nENDWORD closes the document.`);
    const { pages, measured } = pagesOf(doc, DEFAULT_SETTINGS, null);
    assert.equal(measured, false);
    assert.ok(pages.length >= 2, `expected more than one page, got ${pages.length}`);
    assert.match(pages[0]!.markdown, /STARTWORD/);
    assert.doesNotMatch(pages[0]!.markdown, /ENDWORD/);
    assert.match(pages[pages.length - 1]!.markdown, /ENDWORD/);
    assert.doesNotMatch(pages[pages.length - 1]!.markdown, /STARTWORD/);
    assert.ok(pages[0]!.words > 0);
    assert.equal(wordCount(pages[0]!.markdown), pages[0]!.words);
  });
});

describe("linked document context", () => {
  const source = { id: "sample-1", title: "Voice guide", doc: markdownToDoc(SAMPLE), settings: DEFAULT_SETTINGS, layout: null };

  it("includes only the selected pages for a writing sample", () => {
    const text = linkedDocumentContext(source, { id: "sample-1", title: "Voice guide", purpose: "voice", pages: [2] });
    assert.match(text, /Writing sample from "Voice guide"/);
    assert.match(text, /Match this voice/);
    assert.match(text, /<writing-sample>[\s\S]*The warm page talks like a friend/);
    assert.doesNotMatch(text, /formal page/);
    assert.doesNotMatch(text, /<linked-document>/);
  });

  it("includes the whole document when it is linked as context", () => {
    const text = linkedDocumentContext(source, { id: "sample-1", title: "Voice guide", purpose: "context" });
    assert.match(text, /Context document "Voice guide"/);
    assert.match(text, /whole document is included/);
    assert.match(text, /<linked-document>[\s\S]*The formal page keeps its distance/);
    assert.match(text, /The warm page talks like a friend/);
    assert.doesNotMatch(text, /<writing-sample>/);
  });

  it("says when the linked document is gone", () => {
    const text = linkedDocumentContext(null, { id: "missing", title: "Gone", purpose: "context" });
    assert.match(text, /"Gone" is no longer available/);
  });
});
