import {
  applyBlockStyle,
  applyFontFamily,
  applyFontSize,
  applyPaperStyle,
  applyParagraphIndent,
  findNext,
  indentBlocks,
  insertHorizontalLine,
  insertImage,
  insertLink,
  insertPageBreak,
  insertTable,
  runCommand,
  setAlignment,
  setHighlightColor,
  setLineSpacing,
  setTextColor,
  toggleInlineFormat,
  toggleList,
} from "@/lib/editorApi";
import type { AgentToolCall, AgentToolName } from "@/lib/agent/toolCatalog";
import { isClientTool } from "@/lib/agent/toolCatalog";

export type ClientToolIO = {
  print: () => void;
  setHeader: (text: string) => void;
  showHeader: () => void;
  setFooter: (text: string) => void;
  showFooter: () => void;
  showPageNumbers: () => void;
  setPageNumberLocation: (location: "header" | "footer") => void;
  setHeaderAlign: (align: "left" | "center" | "right") => void;
  setDocumentChrome?: (patch: { fontFamily?: string; fontSize?: string; lineSpacing?: string }) => void;
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
      if (!selectFind(editor, args.find)) return missing(call.name);
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
      if (!selectFind(editor, args.find)) return missing(call.name);
      const next = size.endsWith("pt") ? size : `${size}pt`;
      applyFontSize(editor, next);
      if (!hasFind(args.find)) io.setDocumentChrome?.({ fontSize: next });
      return { name: call.name, ok: true };
    }
    if (call.name === "set_font_family") {
      const family = String(args.family ?? args.font ?? "").trim();
      if (!family) return { name: call.name, ok: false, detail: "Missing font" };
      if (!selectFind(editor, args.find)) return missing(call.name);
      applyFontFamily(editor, family);
      if (!hasFind(args.find)) io.setDocumentChrome?.({ fontFamily: family });
      return { name: call.name, ok: true };
    }
    if (call.name === "set_text_color") {
      const color = String(args.color ?? "").trim();
      if (!color) return { name: call.name, ok: false, detail: "Missing color" };
      if (!selectFind(editor, args.find)) return missing(call.name);
      setTextColor(editor, color);
      return { name: call.name, ok: true };
    }
    if (call.name === "toggle_list") {
      if (!selectFind(editor, args.find)) return missing(call.name);
      toggleList(editor, args.type === "ol" ? "ol" : "ul", args.variant === "dash" ? "dash" : undefined);
      return { name: call.name, ok: true };
    }
    if (call.name === "toggle_bold" || call.name === "toggle_italic" || call.name === "toggle_underline") {
      if (!selectFind(editor, args.find)) return missing(call.name);
      toggleInlineFormat(
        editor,
        call.name === "toggle_bold" ? "bold" : call.name === "toggle_italic" ? "italic" : "underline",
      );
      return { name: call.name, ok: true };
    }
    if (call.name === "add_header") {
      io.showHeader();
      io.setHeader(String(args.text ?? "").trim() || "Header");
      return { name: call.name, ok: true };
    }
    if (call.name === "add_footer") {
      io.showFooter();
      io.setFooter(String(args.text ?? "").trim() || "Footer");
      return { name: call.name, ok: true };
    }
    if (call.name === "add_page_numbers") {
      io.showPageNumbers();
      if (args.location === "header" || args.location === "footer") {
        io.setPageNumberLocation(args.location);
      }
      return { name: call.name, ok: true };
    }
    if (call.name === "set_alignment") {
      const align = args.align;
      if (align === "left" || align === "center" || align === "right" || align === "justify") {
        if (!selectFind(editor, args.find)) return missing(call.name);
        setAlignment(editor, align);
        return { name: call.name, ok: true };
      }
      return { name: call.name, ok: false, detail: "Bad alignment" };
    }
    if (call.name === "set_line_spacing") {
      const value = String(args.value ?? args.spacing ?? "").trim();
      if (!value) return { name: call.name, ok: false, detail: "Missing spacing" };
      setLineSpacing(editor, value);
      io.setDocumentChrome?.({ lineSpacing: value });
      return { name: call.name, ok: true };
    }
    if (call.name === "set_block_style") {
      const style = args.style;
      if (
        style === "normal" ||
        style === "title" ||
        style === "subtitle" ||
        style === "h1" ||
        style === "h2" ||
        style === "h3"
      ) {
        if (!selectFind(editor, args.find)) return missing(call.name);
        applyBlockStyle(editor, style);
        return { name: call.name, ok: true };
      }
      return { name: call.name, ok: false, detail: "Bad block style" };
    }
    if (call.name === "set_paragraph_indent") {
      const kind = args.kind ?? args.style;
      if (kind === "none" || kind === "first-line" || kind === "hanging") {
        const scope = args.scope === "body" || args.scope === "bibliography"
          ? args.scope
          : !hasFind(args.find)
            ? kind === "hanging" ? "bibliography" : "body"
            : undefined;
        if (scope) {
          applyParagraphIndent(editor, kind, { scope });
          return { name: call.name, ok: true, detail: scope };
        }
        if (!selectFind(editor, args.find)) return missing(call.name);
        applyParagraphIndent(editor, kind, { following: args.following === true });
        return { name: call.name, ok: true };
      }
      return { name: call.name, ok: false, detail: "Bad paragraph indent" };
    }
    if (call.name === "apply_paper_style") {
      const preset = String(args.preset ?? args.style ?? "").toLowerCase();
      if (preset !== "mla" && preset !== "apa" && preset !== "letter") {
        return { name: call.name, ok: false, detail: "Unknown paper style" };
      }
      applyPaperStyle(editor, preset);
      io.setDocumentChrome?.({
        fontFamily: '"Times New Roman", Times, serif',
        fontSize: "12pt",
        lineSpacing: preset === "letter" ? "1.15" : "2",
      });
      if (preset === "mla" || preset === "apa") {
        const header = String(args.lastName ?? args.header ?? "Last Name").trim() || "Last Name";
        io.showHeader();
        io.setHeader(header);
        io.setHeaderAlign("right");
        io.setPageNumberLocation("header");
        io.showPageNumbers();
      } else {
        io.setPageNumberLocation("footer");
        io.showPageNumbers();
      }
      return { name: call.name, ok: true, detail: preset };
    }
    if (call.name === "insert_table") {
      if (!caretAfterFind(editor, args.find)) return missing(call.name);
      const cells = parseTableCells(args.cells);
      const rows = Number(args.rows) || cells?.length || 2;
      const cols = Number(args.cols) || cells?.[0]?.length || 2;
      insertTable(editor, rows, cols, cells);
      return { name: call.name, ok: true };
    }
    if (call.name === "insert_page_break") {
      if (!caretAfterFind(editor, args.find)) return missing(call.name);
      insertPageBreak(editor);
      return { name: call.name, ok: true };
    }
    if (call.name === "indent_blocks") {
      if (!selectFind(editor, args.find)) return missing(call.name);
      const inward = args.direction !== "out" && args.direction !== -1;
      indentBlocks(editor, inward ? 1 : -1);
      return { name: call.name, ok: true };
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

function hasFind(find: unknown) {
  return typeof find === "string" && Boolean(find.trim());
}

function selectFind(editor: HTMLElement, find: unknown) {
  if (typeof find !== "string" || !find.trim()) return true;
  return findNext(editor, find.trim());
}

function caretAfterFind(editor: HTMLElement, find: unknown) {
  if (!selectFind(editor, find)) return false;
  if (typeof find === "string" && find.trim()) window.getSelection()?.collapseToEnd();
  return true;
}

function parseTableCells(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const cells = value
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => String(cell ?? "")));
  return cells.length ? cells : undefined;
}

function missing(name: AgentToolName): AppliedClientTool {
  return { name, ok: false, detail: "Text not found" };
}

export function silentToolLabel(name: AgentToolName) {
  if (name === "lint_writing") return "Writing lint";
  if (name === "count_words") return "Word count";
  if (name === "detect_ai_tropes") return "AI trope scan";
  if (name === "retrieve_passages") return "Passage retrieval";
  if (name === "search_citations") return "Citation catalog";
  if (name === "web_search") return "Web search";
  if (name === "web_fetch") return "Read page";
  if (name === "apply_paper_style") return "Paper style";
  if (name === "run_code") return "Code";
  if (name === "export_pdf") return "Export PDF";
  return name.replace(/_/g, " ");
}
