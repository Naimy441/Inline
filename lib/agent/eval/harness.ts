import { JSDOM } from "jsdom";
import type { AgentEditDraft } from "@/lib/agent/types";
import type { AgentToolCall, AgentToolName } from "@/lib/agent/toolCatalog";
import type { ClientToolIO } from "@/lib/agent/clientTools";
import { DocumentSession } from "@/lib/agent/mcp/session";

let installed = false;

export function installDom() {
  if (installed) return;
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const g = globalThis as typeof globalThis & {
    window: Window;
    document: Document;
    NodeFilter: typeof NodeFilter;
    getComputedStyle: typeof getComputedStyle;
  };
  g.window = window as unknown as Window & typeof globalThis;
  g.document = window.document;
  g.HTMLElement = window.HTMLElement;
  g.HTMLDivElement = window.HTMLDivElement;
  g.HTMLSpanElement = window.HTMLSpanElement;
  g.HTMLAnchorElement = window.HTMLAnchorElement;
  g.HTMLTableElement = window.HTMLTableElement;
  g.HTMLLIElement = window.HTMLLIElement;
  g.HTMLUListElement = window.HTMLUListElement;
  g.HTMLOListElement = window.HTMLOListElement;
  g.Node = window.Node;
  g.Text = window.Text;
  g.Comment = window.Comment;
  g.Element = window.Element;
  g.Document = window.Document;
  g.DocumentFragment = window.DocumentFragment;
  g.Range = window.Range;
  g.NodeFilter = window.NodeFilter;
  g.DOMParser = window.DOMParser;
  g.getComputedStyle = window.getComputedStyle.bind(window);
  Object.defineProperty(g, "navigator", { value: window.navigator, configurable: true });
  if (typeof window.Element !== "undefined") {
    const proto = window.Element.prototype as Element & { scrollIntoView?: () => void };
    if (typeof proto.scrollIntoView !== "function") {
      proto.scrollIntoView = function () {};
    }
  }
  if (typeof window.document.execCommand !== "function") {
    window.document.execCommand = () => false;
  }
  installed = true;
}

export function createEditor(html: string) {
  installDom();
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.innerHTML = html;
  document.body.appendChild(editor);
  selectAll(editor);
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0) selection.collapseToStart();
  return editor;
}

export function destroyEditor(editor: HTMLElement) {
  editor.remove();
}

export function htmlFromPlain(text: string) {
  if (!text.trim()) return "<div><br></div>";
  return text
    .split(/\n{2,}/)
    .map((para) => `<div>${escapeHtml(para).replace(/\n/g, "<br>")}</div>`)
    .join("");
}

export function selectAll(editor: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function tool(name: AgentToolName, args: Record<string, unknown> = {}): AgentToolCall {
  return { id: crypto.randomUUID(), name, args };
}

export function mockClientIo() {
  const state = {
    header: "",
    footer: "",
    showHeader: false,
    showFooter: false,
    showPageNumbers: false,
    pageNumberLocation: "footer" as "header" | "footer",
    headerAlign: "center" as "left" | "center" | "right",
    printed: false,
    fontFamily: "",
    fontSize: "",
    lineSpacing: "",
  };
  const io: ClientToolIO = {
    print: () => {
      state.printed = true;
    },
    setHeader: (text) => {
      state.header = text;
    },
    showHeader: () => {
      state.showHeader = true;
    },
    setFooter: (text) => {
      state.footer = text;
    },
    showFooter: () => {
      state.showFooter = true;
    },
    showPageNumbers: () => {
      state.showPageNumbers = true;
    },
    setPageNumberLocation: (location) => {
      state.pageNumberLocation = location;
    },
    setHeaderAlign: (align) => {
      state.headerAlign = align;
    },
    setDocumentChrome: (patch) => {
      if (patch.fontFamily) state.fontFamily = patch.fontFamily;
      if (patch.fontSize) state.fontSize = patch.fontSize;
      if (patch.lineSpacing) state.lineSpacing = patch.lineSpacing;
    },
  };
  return { io, state };
}

export function applyEditsToSession(session: DocumentSession, edits: AgentEditDraft[]) {
  for (const edit of edits) {
    if (edit.operation === "insert" && !edit.find) {
      session.insertText(edit.replace);
      continue;
    }
    if (edit.operation === "delete" || edit.replace === "") {
      session.deleteText(edit.find, edit.occurrence ?? 0);
      continue;
    }
    session.replaceText(edit.find, edit.replace, edit.occurrence ?? 0);
  }
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
