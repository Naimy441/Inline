import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { schema } from "@/lib/doc/schema";
import { ImageView, dataUrlToBlob, imageSelectionPlugin, resizedWidth } from "@/lib/editor/imageView";

describe("image resizing", () => {
  it("follows the drag, mirrored for the left handle", () => {
    assert.equal(resizedWidth(300, 50, 800), 350);
    assert.equal(resizedWidth(300, 50, 800, "left"), 250);
    assert.equal(resizedWidth(300, -40.4, 800), 260);
  });

  it("stays between a minimum and the page width", () => {
    assert.equal(resizedWidth(300, -1000, 800), 48);
    assert.equal(resizedWidth(300, 1000, 800), 800);
  });
});

describe("pasted data: URLs", () => {
  it("decodes base64 images with their type", async () => {
    const blob = dataUrlToBlob("data:image/png;base64,iVBORw0KGgo=");
    assert.ok(blob);
    assert.equal(blob.type, "image/png");
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(dataUrlToBlob("data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+")?.type, "image/svg+xml");
  });

  it("ignores URLs it can't decode", () => {
    assert.equal(dataUrlToBlob("data:image/png,rawtext"), null);
    assert.equal(dataUrlToBlob("https://example.com/a.png"), null);
  });
});

describe("photo selection", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previous = new Map<string, unknown>();

  before(() => {
    const win = dom.window;
    const host = globalThis as typeof globalThis & Record<string, unknown>;
    for (const key of ["window", "document", "HTMLElement", "Element", "Node", "MouseEvent", "DocumentFragment", "getComputedStyle"]) {
      previous.set(key, host[key]);
      const value = (win as unknown as Record<string, unknown>)[key];
      try {
        host[key] = value;
      } catch {
        Object.defineProperty(host, key, { configurable: true, writable: true, value });
      }
    }
  });

  after(() => {
    const host = globalThis as typeof globalThis & Record<string, unknown>;
    for (const [key, value] of previous) {
      try {
        if (value === undefined) delete host[key];
        else host[key] = value;
      } catch {
        Object.defineProperty(host, key, { configurable: true, writable: true, value });
      }
    }
  });

  function mount() {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, schema.text("Before")),
      schema.nodes.image.create({ src: "/photo.png", alt: "photo" }),
      schema.nodes.paragraph.create(null, schema.text("After")),
    ]);
    const plugin = imageSelectionPlugin();
    const mountPoint = dom.window.document.createElement("div");
    dom.window.document.body.append(mountPoint);
    const view = new EditorView(mountPoint, {
      state: EditorState.create({ doc, plugins: [plugin] }),
      nodeViews: { image: (node, editorView, getPos) => new ImageView(node, editorView, getPos) },
    });
    let imagePos = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "image") {
        imagePos = pos;
        return false;
      }
      return true;
    });
    const selectPhoto = () => view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, imagePos)));
    return { view, plugin, imagePos, selectPhoto, destroy: () => view.destroy() };
  }

  it("clears a selected photo when the click is outside the document", () => {
    const { view, selectPhoto, destroy } = mount();
    try {
      selectPhoto();
      assert.equal(view.state.selection instanceof NodeSelection, true);
      const input = (view as unknown as { input: { lastClick: { time: number; x: number; y: number; type: string; button: number } } }).input;
      input.lastClick = { time: Date.now(), x: 0, y: 0, type: "singleClick", button: 0 };
      const background = dom.window.document.createElement("div");
      dom.window.document.body.append(background);
      background.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 }));
      assert.equal(view.state.selection instanceof NodeSelection, false);
      assert.equal(view.dom.querySelector(".doc-image")?.classList.contains("ProseMirror-selectednode"), false);
      assert.equal(input.lastClick.time, 0);
    } finally {
      destroy();
    }
  });

  it("keeps the photo selected when the click is on it or its resize handle", () => {
    const { view, plugin, imagePos, selectPhoto, destroy } = mount();
    try {
      selectPhoto();
      const image = view.dom.querySelector("img");
      const handle = view.dom.querySelector(".image-handle");
      assert.ok(image && handle);
      const node = view.state.doc.nodeAt(imagePos)!;
      const clickOn = (target: EventTarget) => plugin.props.handleClickOn!.call(plugin, view, imagePos, node, imagePos, { button: 0, shiftKey: false, target } as unknown as MouseEvent, true);
      assert.equal(clickOn(image), false);
      assert.equal(view.state.selection instanceof NodeSelection, true);
      assert.equal(clickOn(handle), false);
      assert.equal(view.state.selection instanceof NodeSelection, true);
      image.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 }));
      assert.equal(view.state.selection instanceof NodeSelection, true);
    } finally {
      destroy();
    }
  });

  it("clears a selected photo when the click misses the photo but hits its block", () => {
    const { view, plugin, imagePos, selectPhoto, destroy } = mount();
    try {
      selectPhoto();
      const figure = view.dom.querySelector(".doc-image");
      assert.ok(figure);
      const handled = plugin.props.handleClickOn!.call(plugin, view, imagePos, view.state.doc.nodeAt(imagePos)!, imagePos, { button: 0, shiftKey: false, target: figure } as unknown as MouseEvent, true);
      assert.equal(handled, true);
      assert.equal(view.state.selection instanceof NodeSelection, false);
      assert.equal(view.dom.querySelector(".ProseMirror-selectednode"), null);
    } finally {
      destroy();
    }
  });

  it("leaves a text selection alone when the click is outside the document", () => {
    const { view, destroy } = mount();
    try {
      const from = 1;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + 6)));
      const before = { from: view.state.selection.from, to: view.state.selection.to, text: view.state.doc.textBetween(view.state.selection.from, view.state.selection.to) };
      assert.equal(before.text, "Before");
      dom.window.document.body.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 }));
      assert.deepEqual(
        { from: view.state.selection.from, to: view.state.selection.to, text: view.state.doc.textBetween(view.state.selection.from, view.state.selection.to) },
        before,
      );
    } finally {
      destroy();
    }
  });

  it("does not take a text click away from the editor", () => {
    const { view, selectPhoto, destroy } = mount();
    try {
      selectPhoto();
      const paragraph = view.dom.querySelector("p");
      assert.ok(paragraph);
      paragraph.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, button: 0 }));
      // ProseMirror places the caret on mouseup. This click must not move it first.
      assert.equal(view.state.selection instanceof NodeSelection, true);
    } finally {
      destroy();
    }
  });

  it("runs an outside control's click before clearing the photo", () => {
    const { view, selectPhoto, destroy } = mount();
    try {
      selectPhoto();
      const button = dom.window.document.createElement("button");
      let selectedDuringClick = false;
      button.addEventListener("click", () => {
        selectedDuringClick = view.state.selection instanceof NodeSelection;
      });
      dom.window.document.body.append(button);
      button.click();
      assert.equal(selectedDuringClick, true);
      assert.equal(view.state.selection instanceof NodeSelection, false);
    } finally {
      destroy();
    }
  });
});
