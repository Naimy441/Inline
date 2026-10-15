import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { docToMarkdown, layoutAttrs, parseMarkdown } from "./markdown";
import { schema } from "./schema";

const block = (markdown: string) => parseMarkdown(markdown)[0]!;

describe("layout attributes in Markdown", () => {
  it("sets size, spacing, line height and indent in points", () => {
    const node = block("## **Results** {size=14.4 before=12 after=6 line=1.2 left=18}");
    assert.equal(node.type.name, "heading");
    assert.deepEqual(
      { fontSize: node.attrs.fontSize, spaceBefore: node.attrs.spaceBefore, spaceAfter: node.attrs.spaceAfter, lineHeight: node.attrs.lineHeight, indent: node.attrs.indent },
      { fontSize: 14.4, spaceBefore: 12, spaceAfter: 6, lineHeight: "1.2", indent: 0.5 },
    );
    assert.equal(node.textContent, "Results");
  });

  it("draws boxes and borders, which neighbouring paragraphs share", () => {
    const [first, second] = parseMarkdown("**Definition:** one {.box border-width=0.4 border-space=3.5}\n\ntwo {.box border-width=0.4 border-space=3.5}");
    assert.deepEqual(first!.attrs.borders.left, { style: "solid", width: 0.4, space: 3.5, color: null });
    assert.deepEqual(first!.attrs.borders, second!.attrs.borders);
    const rule = block("Header {border=bottom border-color=#c00 border-style=double}");
    assert.deepEqual(Object.keys(rule.attrs.borders), ["bottom"]);
    assert.equal(rule.attrs.borders.bottom.color, "#cc0000");
    assert.equal(rule.attrs.borders.bottom.style, "double");
  });

  it("reads tab stops, and tabs written as &#9;", () => {
    const node = block('1.1 Standard Deviation&#9;1 {tabs="234:center 470:right:dot"}');
    assert.deepEqual(node.attrs.tabs, [
      { pos: 234, align: "center" },
      { pos: 470, align: "right", leader: "dot" },
    ]);
    assert.equal(node.textContent, "1.1 Standard Deviation\t1");
  });

  it("colors a paragraph's text but not its equations", () => {
    const node = block("Let $x$ be red {color=#d63322}");
    const marks = (index: number) => node.child(index).marks.map((mark) => mark.type.name);
    assert.deepEqual(marks(0), ["text_color"]);
    assert.deepEqual(marks(1), ["math"]);
  });

  it("styles spans, restoring the outer style after them", () => {
    const node = block('a <span style="color: #00f; font-size: 9pt; font-weight: bold">b <span style="color:red">c</span> d</span> e');
    const styles = (index: number) => node.child(index).marks.map((mark) => `${mark.type.name}${mark.attrs.color ? `:${mark.attrs.color}` : ""}${mark.attrs.size ? `:${mark.attrs.size}` : ""}`).sort();
    assert.equal(node.child(0).text, "a ");
    assert.deepEqual(styles(1), ["bold", "font_size:9pt", "text_color:#00f"]);
    assert.deepEqual(styles(2), ["bold", "font_size:9pt", "text_color:red"]);
    assert.deepEqual(styles(3), ["bold", "font_size:9pt", "text_color:#00f"]);
    assert.deepEqual(styles(4), []);
  });

  it("sets pictures in a line at the size given, from safe sources only", () => {
    const node = block('Plots: <img src="/api/uploads/a.png" width="120" height="70" alt="n=6"> <img src="javascript:alert(1)" width="5">');
    const images: Array<Record<string, unknown>> = [];
    node.forEach((child) => {
      if (child.type.name === "inline_image") images.push(child.attrs);
    });
    assert.equal(images.length, 1);
    assert.equal(images[0]!.width, 120);
    assert.equal(images[0]!.height, 70);
    assert.equal(images[0]!.alt, "n=6");
  });

  it("ignores values out of range and leaves the Markdown view unchanged", () => {
    assert.deepEqual(layoutAttrs({ classes: [], values: { size: "9000", before: "-3", line: "x" } }), {});
    const doc = schema.node("doc", null, parseMarkdown("Text {size=14 after=20 .box}"));
    assert.equal(docToMarkdown(doc), "Text");
  });
});

describe("spacing around displayed equations", () => {
  it("reads before= and after= on the closing $$ line", () => {
    const [math, after] = parseMarkdown("$$\n\\int_0^1 x\\,dx\n$$ {before=4 after=6.5}\n\nNext");
    assert.equal(math!.type.name, "code_block");
    assert.equal(math!.textContent, "\\int_0^1 x\\,dx");
    assert.deepEqual([math!.attrs.spaceBefore, math!.attrs.spaceAfter], [4, 6.5]);
    assert.equal(after!.textContent, "Next");
    const plain = parseMarkdown("$$\nx\n$$")[0]!;
    assert.deepEqual([plain.attrs.spaceBefore, plain.attrs.spaceAfter], [null, null]);
  });
});
