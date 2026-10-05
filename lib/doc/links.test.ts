import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DOMSerializer } from "prosemirror-model";
import { JSDOM } from "jsdom";
import { DOMParser as PMDOMParser } from "prosemirror-model";
import { Transform } from "prosemirror-transform";

import { applyFormat, EditError } from "./editing";
import { docToMarkdown, markdownToDoc } from "./markdown";
import { safeHref, schema } from "./schema";
import { fragmentToHtml } from "./html";

describe("link safety", () => {
  it("allows web, mail, phone, anchors and relative links", () => {
    for (const href of ["https://example.com", "http://x.y/z?q=1", "mailto:a@b.c", "tel:+15551234", "#section", "/api/uploads/a.png", "notes.html"]) {
      assert.equal(safeHref(href), href);
    }
  });

  it("refuses script, data and other schemes, however they're disguised", () => {
    for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "java\nscript:x", "data:text/html,<script>", "vbscript:x", "file:///etc/passwd", "", null, 42]) {
      assert.equal(safeHref(href), null, String(href));
    }
  });

  it("never turns an unsafe Markdown link into a link", () => {
    const doc = markdownToDoc("Click [here](javascript:alert(1)) or [there](https://ok.example) or <a href=\"vbscript:x\">this</a>.");
    const hrefs: string[] = [];
    doc.descendants((node) => {
      for (const mark of node.marks) if (mark.type.name === "link") hrefs.push(mark.attrs.href);
    });
    assert.deepEqual(hrefs, ["https://ok.example"]);
    assert.match(docToMarkdown(doc), /\[there\]\(https:\/\/ok\.example\)/);
  });

  it("drops unsafe links when HTML is pasted or imported", () => {
    const { window } = new JSDOM(`<p><a href="javascript:alert(1)">bad</a> <a href="https://good.example">good</a></p>`);
    const doc = PMDOMParser.fromSchema(schema).parse(window.document.body);
    const hrefs: string[] = [];
    doc.descendants((node) => {
      for (const mark of node.marks) if (mark.type.name === "link") hrefs.push(mark.attrs.href);
    });
    assert.deepEqual(hrefs, ["https://good.example"]);
  });

  it("never renders an unsafe href that is already stored, in the editor or in HTML exports", () => {
    const bad = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("x", [schema.mark("link", { href: "javascript:alert(1)" })])])]);
    assert.doesNotMatch(fragmentToHtml(bad), /javascript/);
    const { window } = new JSDOM("");
    const dom = DOMSerializer.fromSchema(schema).serializeFragment(bad.content, { document: window.document });
    const div = window.document.createElement("div");
    div.append(dom);
    assert.equal(div.querySelector("a")!.getAttribute("href"), "#");
  });

  it("Claude's format_text refuses an unsafe link", () => {
    const doc = markdownToDoc("Some text here.");
    assert.throws(() => applyFormat(new Transform(doc), 1, 5, { link: "javascript:alert(1)" }), EditError);
  });
});
