import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { schema } from "@/lib/doc/schema";
import { edgesToAttrs, indentEdges } from "./indents";

describe("ruler indents", () => {
  it("maps left, first-line and hanging indents onto the markers and back", () => {
    const cases = [
      { indent: 0, textIndent: null, rightIndent: 0 },
      { indent: 2, textIndent: null, rightIndent: 0 },
      { indent: 0, textIndent: 0.5, rightIndent: 0 },
      { indent: 1, textIndent: -0.25, rightIndent: 0.5 },
      { indent: 1.25, textIndent: 0.2, rightIndent: 1 },
    ];
    for (const attrs of cases) {
      const edges = indentEdges(attrs.indent, attrs.textIndent, attrs.rightIndent);
      const back = edgesToAttrs(edges.body, edges.first, edges.right, 6.5);
      assert.equal(back.indent, attrs.indent);
      assert.equal(back.textIndent, attrs.textIndent);
      assert.equal(back.rightIndent, attrs.rightIndent);
    }
  });

  it("keeps a gap between the two sides and refuses a negative indent", () => {
    const next = edgesToAttrs(-1, 8, 8, 6.5);
    assert.ok(next.indent >= 0);
    assert.ok((next.rightIndent ?? 0) >= 0);
    assert.ok(next.indent * 0.5 + (next.textIndent ?? 0) + next.rightIndent < 6.5);
  });

  it("keeps a right indent in the paragraph HTML", () => {
    const node = schema.node("paragraph", { indent: 1.25, textIndent: 0.25, rightIndent: 0.5 }, schema.text("Hi"));
    const spec = schema.nodes.paragraph.spec.toDOM!(node) as [string, Record<string, string>];
    const attrs = spec[1];
    assert.match(attrs.style, /margin-left: 0.625in/);
    assert.match(attrs.style, /text-indent: 0.25in/);
    assert.match(attrs.style, /margin-right: 0.5in/);
    const el = new JSDOM(
      `<p data-indent="${attrs["data-indent"]}" data-right-indent="${attrs["data-right-indent"]}" style="${attrs.style}">Hi</p>`,
    ).window.document.querySelector("p")!;
    const parsed = schema.nodes.paragraph.spec.parseDOM![0]!.getAttrs!(el) as { indent: number; textIndent: number; rightIndent: number };
    assert.equal(parsed.indent, 1.25);
    assert.equal(parsed.textIndent, 0.25);
    assert.equal(parsed.rightIndent, 0.5);
  });
});
