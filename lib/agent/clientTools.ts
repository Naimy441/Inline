import {
  applyFontSize,
  findNext,
  insertHorizontalLine,
  insertImage,
  insertLink,
  runCommand,
  setAlignment,
  setHighlightColor,
  toggleList,
} from "@/lib/editorApi";
import type { AgentToolCall, AgentToolName } from "@/lib/agent/tools";
import { isClientTool } from "@/lib/agent/tools";

export type ClientToolIO = {
  print: () => void;
  setHeader: (text: string) => void;
  showHeader: () => void;
  showPageNumbers: () => void;
};

export type AppliedClientTool = {
  name: AgentToolName;
  ok: boolean;
  detail?: string;
};

export function applyClientTools(
  editor: HTMLElement,
  calls: AgentToolCall[],
  io: ClientToolIO,
): AppliedClientTool[] {
  const applied: AppliedClientTool[] = [];
  for (const call of calls) {
    if (!isClientTool(call.name)) continue;
    applied.push(applyOne(editor, call, io));
  }
  return applied;
}

function applyOne(editor: HTMLElement, call: AgentToolCall, io: ClientToolIO): AppliedClientTool {
  const args = call.args ?? {};
  try {
    if (call.name === "export_pdf") {
      io.print();
      return { name: call.name, ok: true, detail: "Opened print / PDF" };
    }
    if (call.name === "undo") {
      runCommand(editor, "undo");
      return { name: call.name, ok: true };
    }
    if (call.name === "redo") {
      runCommand(editor, "redo");
      return { name: call.name, ok: true };
    }
    if (call.name === "insert_link") {
      const url = String(args.url ?? "").trim();
      if (!url) return { name: call.name, ok: false, detail: "Missing url" };
      insertLink(editor, url, typeof args.text === "string" ? args.text : undefined);
      return { name: call.name, ok: true };
    }
    if (call.name === "insert_image") {
      const url = String(args.url ?? "").trim();
      if (!url || !/^(https?:|data:image\/)/i.test(url)) {
        return { name: call.name, ok: false, detail: "Missing image url" };
      }
      insertImage(editor, url);
      return { name: call.name, ok: true };
    }
    if (call.name === "highlight_text") {
      const find = String(args.find ?? "").trim();
      if (!find || !findNext(editor, find)) return { name: call.name, ok: false, detail: "Text not found" };
      setHighlightColor(editor, String(args.color ?? "#fff3b0"));
      return { name: call.name, ok: true };
    }
    if (call.name === "set_font_size") {
      const size = String(args.size ?? "").trim();
      if (!size) return { name: call.name, ok: false, detail: "Missing size" };
      applyFontSize(editor, size.endsWith("pt") ? size : `${size}pt`);
      return { name: call.name, ok: true };
    }
    if (call.name === "toggle_list") {
      toggleList(editor, args.type === "ol" ? "ol" : "ul");
      return { name: call.name, ok: true };
    }
    if (call.name === "add_header") {
      io.showHeader();
      io.setHeader(String(args.text ?? "").trim() || "Header");
      return { name: call.name, ok: true };
    }
    if (call.name === "add_page_numbers") {
      io.showPageNumbers();
      return { name: call.name, ok: true };
    }
    if (call.name === "set_alignment") {
      const align = args.align;
      if (align === "left" || align === "center" || align === "right" || align === "justify") {
        setAlignment(editor, align);
        return { name: call.name, ok: true };
      }
      return { name: call.name, ok: false, detail: "Bad alignment" };
    }
    if (call.name === "insert_horizontal_line") {
      insertHorizontalLine(editor);
      return { name: call.name, ok: true };
    }
  } catch (error) {
    return { name: call.name, ok: false, detail: error instanceof Error ? error.message : "Failed" };
  }
  return { name: call.name, ok: false, detail: "Unknown tool" };
}

export function silentToolLabel(name: AgentToolName) {
  if (name === "lint_writing") return "Writing lint";
  if (name === "count_words") return "Word count";
  if (name === "detect_ai_tropes") return "AI trope scan";
  if (name === "retrieve_passages") return "Passage retrieval";
  if (name === "search_citations") return "Citation catalog";
  if (name === "run_code") return "Code";
  if (name === "export_pdf") return "Export PDF";
  return name.replace(/_/g, " ");
}
