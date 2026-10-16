import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMarkdown } from "@/lib/doc/markdown";
import { serializeLayoutBlocks } from "./layoutMarkdown";

/** Layout Markdown read and written again: the same blocks, and the same text. */
function roundTrip(markdown: string) {
  const blocks = parseMarkdown(markdown);
  const written = serializeLayoutBlocks(blocks);
  const again = parseMarkdown(written);
  assert.equal(again.length, blocks.length);
  again.forEach((node, index) => assert.ok(node.eq(blocks[index]!), `block ${index} changed:\n${written.split("\n\n")[index]}`));
  assert.equal(serializeLayoutBlocks(again), written);
  return written;
}

describe("layout Markdown", () => {
  it("writes back every layout attribute a page can have", () => {
    const written = roundTrip(
      [
        "## **1&emsp;Sample Section** {size=14.4 color=#000000 before=0 after=0}",
        "Questions&#9;<span style=\"font-family: 'CMR10 (notes)'; font-size: 10pt\">1</span> {tabs=\"468:right\" before=10 after=0}",
        "1\\.&#9;The first item, long enough. {left=10 hanging=0.194 align=justify tabs=\"24:left\" before=12 after=0}",
        "**import** urllib<br>&nbsp;&nbsp;&nbsp;&nbsp;x = <span style=\"color: #008000\">1</span> {.box border-width=0.4 border-space=2.6 border-space-top=3.4 border-color=#e0e0e0 line=1.3 before=0.2 after=0 font=\"Menlo (hw)\"}",
        "Set(bottom) {border=\"left right bottom\" border-width=0.4 border-space=3 before=0}",
        "Let $X$ be a value and $T_{A}$ a time. {first-line=0.5 size=9 color=#c00000}",
        "<img src=\"/api/uploads/abc.png\" width=\"513\" height=\"347\"> {size=1 line=1 before=9.5 after=0}",
        "![Plot](/api/uploads/abc.png){width=98%}",
        "&nbsp; {size=1 before=0 after=3.3}",
        "$$\n\\mathbb{P}(X=k)=p\n$$ {before=25 after=0}",
      ].join("\n\n"),
    );
    assert.match(written, /border-color=#e0e0e0/);
    assert.match(written, /<span style="color: #008000">1<\/span>/);
    assert.match(written, /font="Menlo \(hw\)"/);
  });
});
