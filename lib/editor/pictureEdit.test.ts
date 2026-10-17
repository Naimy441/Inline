import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";

import { schema } from "@/lib/doc/schema";
import { gapBesidePicture, localPointerDelta, movePicture, pictureArrowMotion, picturePlacement, placePicture, resizedBox } from "@/lib/editor/pictureEdit";

function docWith(imageAt: "start" | "middle" | "end" = "middle") {
  const image = schema.nodes.image.create({ src: "/photo.png", alt: "photo", width: "200px" });
  const before = schema.nodes.paragraph.create(null, schema.text("Hello world"));
  const after = schema.nodes.paragraph.create(null, schema.text("After"));
  const content = imageAt === "start" ? [image, before, after] : imageAt === "end" ? [before, after, image] : [before, image, after];
  return schema.nodes.doc.create(null, content);
}

function imagePos(state: EditorState) {
  let pos = -1;
  state.doc.descendants((node, at) => {
    if (node.type.name === "image") {
      pos = at;
      return false;
    }
    return true;
  });
  return pos;
}

describe("picture resize", () => {
  it("keeps the aspect ratio on a corner and squishes a side", () => {
    const corner = resizedBox({ width: 200, height: 100 }, 40, 10, "se", 800);
    assert.equal(corner.width, 240);
    assert.equal(corner.height, 120);
    const side = resizedBox({ width: 200, height: 100 }, 0, 30, "s", 800);
    assert.equal(side.width, 200);
    assert.equal(side.height, 130);
    const west = resizedBox({ width: 200, height: 100 }, 40, 0, "w", 800);
    assert.equal(west.width, 160);
    assert.equal(west.height, 100);
  });

  it("stays at least 48px and no wider than the column", () => {
    assert.deepEqual(resizedBox({ width: 200, height: 100 }, -500, 0, "e", 800), { width: 48, height: 100 });
    assert.equal(resizedBox({ width: 200, height: 100 }, 900, 0, "e", 400).width, 400);
  });

  it("turns a screen drag into the picture's axes", () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(localPointerDelta(10, 0, 0)).map(([key, value]) => [key, Math.round(value)])),
      { dx: 10, dy: 0 },
    );
    const turned = localPointerDelta(0, 12, 90);
    assert.ok(Math.abs(turned.dx - 12) < 0.01);
    assert.ok(Math.abs(turned.dy) < 0.01);
  });
});

describe("moving a picture", () => {
  it("lands in the middle of another paragraph", () => {
    const state = EditorState.create({ doc: docWith("middle") });
    const from = imagePos(state);
    // "Hello " is 6 characters; the paragraph content starts at 1.
    const tr = movePicture(state, from, 1 + "Hello ".length);
    assert.ok(tr);
    const next = tr.doc;
    assert.equal(next.child(0).textContent, "Hello ");
    assert.equal(next.child(1).type.name, "image");
    assert.equal(next.child(2).textContent, "world");
    assert.equal(next.child(3).textContent, "After");
    assert.equal(next.child(1).attrs.src, "/photo.png");
  });

  it("moves to a later paragraph and refuses a drop on itself", () => {
    const state = EditorState.create({ doc: docWith("start") });
    const from = imagePos(state);
    assert.equal(movePicture(state, from, from), null);
    const after = state.doc.child(0).nodeSize + state.doc.child(1).nodeSize;
    // Inside "After".
    const tr = movePicture(state, from, after + 1 + 2);
    assert.ok(tr);
    assert.equal(tr.doc.child(0).textContent, "Hello world");
    assert.equal(tr.doc.child(1).textContent, "Af");
    assert.equal(tr.doc.child(2).type.name, "image");
    assert.equal(tr.doc.child(3).textContent, "ter");
  });
});

describe("picture wraps", () => {
  it("maps the menu onto inline, square, break, behind and front", () => {
    const block = schema.nodes.image.create({ src: "/a.png", wrap: null });
    assert.equal(picturePlacement(block), "break");
    assert.equal(picturePlacement(schema.nodes.image.create({ src: "/a.png", wrap: "square" })), "square");
    assert.equal(picturePlacement(schema.nodes.inline_image.create({ src: "/a.png" })), "inline");
    const state = EditorState.create({ doc: docWith("middle"), selection: undefined });
    const from = imagePos(state);
    const selected = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, from)));
    const square = placePicture(selected, "square");
    assert.equal(square?.doc.nodeAt(from)?.attrs.wrap, "square");
    const inline = placePicture(selected, "inline");
    assert.ok(inline);
    let found = "";
    inline.doc.descendants((node) => {
      if (node.type.name === "inline_image") found = node.type.name;
    });
    assert.equal(found, "inline_image");
    assert.equal(inline.doc.child(0).type.name, "paragraph");
    const back = placePicture(selected.apply(inline), "break");
    assert.equal(back?.doc.child(1).type.name, "image");
    assert.equal(back?.doc.child(1).attrs.wrap, null);
    assert.equal(back?.doc.child(2).textContent, "After");
  });

  it("lifts an inline picture out of the middle of a line", () => {
    const inline = schema.nodes.inline_image.create({ src: "/a.png", alt: "icon", width: 40, height: 20 });
    const para = schema.nodes.paragraph.create(null, [schema.text("Hello "), inline, schema.text(" there")]);
    const state = EditorState.create({ doc: schema.nodes.doc.create(null, para) });
    let pos = -1;
    state.doc.descendants((node, at) => {
      if (node.type.name === "inline_image") {
        pos = at;
        return false;
      }
      return true;
    });
    const selected = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
    const broken = placePicture(selected, "square");
    assert.ok(broken);
    assert.equal(broken.doc.child(0).textContent, "Hello ");
    assert.equal(broken.doc.child(1).type.name, "image");
    assert.equal(broken.doc.child(1).attrs.wrap, "square");
    assert.equal(broken.doc.child(2).textContent, " there");
  });
});

describe("arrow keys around a picture", () => {
  it("lands on the picture's line, then leaves it", () => {
    const doc = docWith("middle");
    const state = EditorState.create({ doc });
    const at = imagePos(state);
    const endOfAbove = at - 1;
    const down = pictureArrowMotion(doc, { type: "text", head: endOfAbove, empty: true }, "down", true);
    assert.deepEqual(down, { kind: "gap", pos: at });
    const startOfBelow = at + 2;
    const up = pictureArrowMotion(doc, { type: "text", head: startOfBelow, empty: true }, "up", true);
    assert.deepEqual(up, { kind: "gap", pos: at });
    const leave = pictureArrowMotion(doc, { type: "gap", pos: at }, "up", true);
    assert.deepEqual(leave, { kind: "text", pos: endOfAbove });
    const onward = pictureArrowMotion(doc, { type: "gap", pos: at }, "down", true);
    assert.deepEqual(onward, { kind: "text", pos: startOfBelow });
    assert.equal(gapBesidePicture(doc, at)?.side, "before");
    const after = at + doc.nodeAt(at)!.nodeSize;
    assert.equal(gapBesidePicture(doc, after)?.side, "after");
  });

  it("does not skip a line that is still above the picture", () => {
    const doc = docWith("middle");
    const at = imagePos(EditorState.create({ doc }));
    assert.equal(pictureArrowMotion(doc, { type: "text", head: 3, empty: true }, "down", false), null);
    assert.equal(at > 3, true);
  });
});

describe("text caret positions", () => {
  it("uses a text selection at the ends of the neighbouring lines", () => {
    const doc = docWith("middle");
    const state = EditorState.create({ doc });
    const at = imagePos(state);
    const sel = TextSelection.create(doc, at - 1);
    assert.equal(sel.$head.parent.type.name, "paragraph");
    assert.equal(sel.$head.parentOffset, sel.$head.parent.content.size);
  });
});
