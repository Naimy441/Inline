"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MdOutlineFormatClear } from "react-icons/md";
import { AgentPanel } from "@/components/AgentPanel";
import { CommentsPanel, type DocComment } from "@/components/CommentsPanel";
import { ColorPicker } from "@/components/ColorPicker";
import {
  DOCUMENT_FONTS,
  FontFamilyPicker,
  FontSizePicker,
  LineSpacingPicker,
} from "@/components/FontControls";
import { ContextMenu } from "@/components/ContextMenu";
import {
  CitationDialog,
  CompareDialog,
  EmojiDialog,
  LinkDialog,
  SearchReplaceDialog,
  ShortcutsDialog,
  SignatureDialog,
  SpecialCharsDialog,
  TableDialog,
  WordCountDialog,
} from "@/components/DocDialogs";
import {
  EditorSurface,
  type EditorHandle,
  type EditorMetrics,
} from "@/components/EditorSurface";
import { MenuBar, type ViewMode } from "@/components/MenuBar";
import {
  applyBlockStyle,
  applyCapitalization,
  applySubstitutionsAll,
  findNext,
  handleTab,
  indentBlocks,
  insertHorizontalLine,
  insertHtml,
  insertImage,
  insertLink,
  insertPageBreak,
  insertTab,
  insertTable,
  insertText,
  paragraphCount,
  pastePlain,
  pasteRich,
  replaceAll,
  replaceCurrent,
  runCommand,
  selectedText,
  setAlignment,
  setColumns,
  setHighlightColor,
  setLineSpacing,
  setTextColor,
  toggleList,
  wrapSelectionMark,
} from "@/lib/editorApi";
import { acceptAgentEdit, applyAgentEdits, captureAgentSelection, jumpToAgentEdit, rejectAgentEdit } from "@/lib/agent/edits";
import type { AgentSelection, AgentTurn } from "@/lib/agent/types";
import {
  countWords,
  getPlainText,
  isEditorVisuallyEmpty,
  PAGE_GAP,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  restoreSelectionRange,
  saveSelectionRange,
  type TextRange,
} from "@/lib/pagination";

type DialogName =
  | "search"
  | "word-count"
  | "link"
  | "table"
  | "emoji"
  | "special"
  | "compare"
  | "citation"
  | "signature"
  | "shortcuts"
  | null;

export function DocumentWorkspace() {
  const editorRef = useRef<EditorHandle>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const savedSelectionRef = useRef<TextRange | null>(null);
  const expandedSelectionRef = useRef<TextRange | null>(null);
  const [linkText, setLinkText] = useState("");
  const [title, setTitle] = useState("Untitled document");
  const [metrics, setMetrics] = useState<EditorMetrics>({
    pageCount: 1,
    wordCount: 0,
    charCount: 0,
  });
  const canvasRef = useRef<HTMLElement>(null);
  const [zoomMode, setZoomMode] = useState<"fit" | number>("fit");
  const [fitZoom, setFitZoom] = useState(1);
  const [font, setFont] = useState("Arial");
  const [fontSize, setFontSize] = useState("11pt");
  const [active, setActive] = useState({
    bold: false,
    italic: false,
    underline: false,
    align: "left" as "left" | "center" | "right" | "justify",
    list: null as "ul" | "ol" | null,
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [mode, setMode] = useState<ViewMode>("editing");
  const [showInvisibles, setShowInvisibles] = useState(false);
  const [substitutions, setSubstitutions] = useState(true);
  const [screenReader, setScreenReader] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [columns, setColumnCount] = useState(1);
  const [lineSpacing, setSpacing] = useState("1.15");
  const [showHeader, setShowHeader] = useState(false);
  const [showFooter, setShowFooter] = useState(false);
  const [showPageNumbers, setShowPageNumbers] = useState(false);
  const [headerText, setHeaderText] = useState("");
  const [footerText, setFooterText] = useState("");
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsMinimized, setCommentsMinimized] = useState(false);
  const [comments, setComments] = useState<DocComment[]>([]);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentMinimized, setAgentMinimized] = useState(false);
  const [askPrompt, setAskPrompt] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [agentContext, setAgentContext] = useState<AgentSelection | null>(null);
  const [agentTurns, setAgentTurns] = useState<AgentTurn[]>([]);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
  } | null>(null);
  const [darkMode, setDarkMode] = useState<boolean | null>(null);
  const [textColor, setTextColorValue] = useState("auto");
  const [highlightColor, setHighlightColorValue] = useState("transparent");

  useEffect(() => {
    document.title = `${title || "Untitled document"} - Inline`;
  }, [title]);

  useEffect(() => {
    const stored = window.localStorage.getItem("inline-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    setDarkMode(stored ? stored === "dark" : prefersDark);
  }, []);

  useEffect(() => {
    if (darkMode == null) return;
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
    window.localStorage.setItem("inline-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    const saveSelection = () => {
      const el = editorRef.current?.getElement();
      if (!el) return;
      const range = saveSelectionRange(el);
      if (!range) return;
      const selection = window.getSelection();
      const inside = Boolean(selection?.anchorNode && el.contains(selection.anchorNode));
      if (!inside) return;
      if (range.start === range.end && document.activeElement !== el && savedSelectionRef.current) {
        return;
      }
      savedSelectionRef.current = range;
      if (range.start !== range.end) expandedSelectionRef.current = range;
    };
    document.addEventListener("selectionchange", saveSelection);
    return () => document.removeEventListener("selectionchange", saveSelection);
  }, []);

  const restoreSelection = (preferExpanded = false) => {
    const el = editorRef.current?.getElement();
    if (!el) return;
    el.focus({ preventScroll: true });
    const collapsed = savedSelectionRef.current && savedSelectionRef.current.start === savedSelectionRef.current.end;
    const range =
      preferExpanded && collapsed && expandedSelectionRef.current
        ? expandedSelectionRef.current
        : savedSelectionRef.current;
    if (range) restoreSelectionRange(el, range);
  };

  const openLinkDialog = () => {
    restoreSelection();
    setLinkText(selectedText());
    setDialog("link");
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const updateFit = () => {
      const next = Math.min(1, (canvas.clientWidth - 80) / PAGE_WIDTH);
      setFitZoom(Number.isFinite(next) && next > 0.2 ? next : 1);
    };
    updateFit();
    const observer = new ResizeObserver(updateFit);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const zoom = zoomMode === "fit" ? fitZoom : zoomMode;

  const updateCurrentPage = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const papers = canvas.querySelectorAll(".paper");
    if (papers.length === 0) return;
    const probe = canvas.getBoundingClientRect().top + 48;
    let next = papers.length;
    for (let index = 0; index < papers.length; index += 1) {
      const rect = papers[index].getBoundingClientRect();
      if (rect.bottom > probe) {
        next = index + 1;
        break;
      }
    }
    setCurrentPage(next);
  }, []);

  useEffect(() => {
    updateCurrentPage();
  }, [metrics.pageCount, zoom, updateCurrentPage]);

  const onMetricsChange = useCallback((next: EditorMetrics) => {
    setMetrics((prev) =>
      prev.pageCount === next.pageCount &&
      prev.wordCount === next.wordCount &&
      prev.charCount === next.charCount
        ? prev
        : next,
    );
  }, []);

  const refreshActive = useCallback(() => {
    const next = editorRef.current?.queryActive();
    if (!next) return;
    setActive((prev) =>
      prev.bold === next.bold &&
      prev.italic === next.italic &&
      prev.underline === next.underline &&
      prev.align === next.align &&
      prev.list === next.list
        ? prev
        : {
            bold: next.bold,
            italic: next.italic,
            underline: next.underline,
            align: next.align,
            list: next.list,
          },
    );
    if (next.font) {
      const match = DOCUMENT_FONTS.find((name) => name.toLowerCase() === next.font.toLowerCase());
      setFont(match ?? next.font);
    }
    if (next.fontSize) setFontSize(next.fontSize);
  }, []);

  const editorEl = () => editorRef.current?.getElement() ?? null;

  const speak = useCallback((text: string) => {
    setAnnounce(text);
    if (!screenReader || typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }, [screenReader]);

  const afterEdit = () => {
    editorRef.current?.reflow();
    refreshActive();
  };

  const addComment = () => {
    const quote = selectedText().trim();
    if (!quote) {
      speak("Select text to comment on.");
      return;
    }
    const id = crypto.randomUUID();
    const el = editorEl();
    if (!el || !wrapSelectionMark(el, id, quote)) return;
    setComments((list) => [...list, { id, quote, body: "" }]);
    setCommentsOpen(true);
    setCommentsMinimized(false);
    afterEdit();
    speak("Comment added.");
  };

  const openAsk = () => {
    if (mode === "viewing") return;
    restoreSelection(true);
    const el = editorEl();
    setAgentContext(el ? captureAgentSelection(el) : null);
    setAgentOpen(true);
    setAgentMinimized(false);
    setAskError(null);
  };

  const submitAsk = async () => {
    const el = editorEl();
    const prompt = askPrompt.trim();
    if (!el || !prompt || askBusy || mode === "viewing") return;
    restoreSelection(true);
    const context = agentContext;
    setAgentContext(context);
    setAskBusy(true);
    setAskError(null);
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          prompt,
          document: getPlainText(el),
          selection: context
            ? { text: context.text, before: context.before, after: context.after }
            : null,
        }),
      });
      const data = (await response.json()) as {
        message?: string;
        edits?: Array<{ find: string; replace: string; reason?: string }>;
        mock?: boolean;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error || "The agent could not propose edits.");
      }
      const edits = applyAgentEdits(el, data.edits ?? [], context);
      setAgentTurns((list) => [
        ...list,
        {
          id: crypto.randomUUID(),
          prompt,
          selection: context?.text ?? null,
          message: data.message || "Review the proposed edits.",
          mock: Boolean(data.mock),
          edits,
        },
      ]);
      setAskPrompt("");
      setAgentOpen(true);
      setAgentMinimized(false);
      afterEdit();
      const pending = edits.filter((edit) => edit.status === "pending").length;
      speak(pending ? `${pending} ${pending === 1 ? "edit" : "edits"} ready to accept or reject.` : data.message || "No edits proposed.");
    } catch (error) {
      setAskError(error instanceof Error ? error.message : "The agent could not propose edits.");
      setAgentOpen(true);
      setAgentMinimized(false);
    } finally {
      setAskBusy(false);
    }
  };

  const reviewEdit = (id: string, action: "accept" | "reject") => {
    const el = editorEl();
    if (!el) return;
    if (action === "accept") acceptAgentEdit(el, id);
    else rejectAgentEdit(el, id);
    setAgentTurns((list) =>
      list.map((turn) => ({
        ...turn,
        edits: turn.edits.map((edit) =>
          edit.id === id && edit.status === "pending"
            ? { ...edit, status: action === "accept" ? "accepted" : "rejected" }
            : edit,
        ),
      })),
    );
    afterEdit();
    speak(action === "accept" ? "Edit accepted." : "Edit rejected.");
  };

  const reviewAll = (action: "accept" | "reject") => {
    const el = editorEl();
    if (!el) return;
    const ids = agentTurns.flatMap((turn) =>
      turn.edits.filter((edit) => edit.status === "pending").map((edit) => edit.id),
    );
    for (const id of ids) {
      if (action === "accept") acceptAgentEdit(el, id);
      else rejectAgentEdit(el, id);
    }
    setAgentTurns((list) =>
      list.map((turn) => ({
        ...turn,
        edits: turn.edits.map((edit) =>
          edit.status === "pending" ? { ...edit, status: action === "accept" ? "accepted" : "rejected" } : edit,
        ),
      })),
    );
    afterEdit();
  };

  const handleAction = async (action: string, value?: string) => {
    if (
      action !== "text-color" &&
      action !== "highlight-color" &&
      action !== "ask-inline" &&
      action !== "agent-panel" &&
      action !== "add-to-chat"
    ) {
      restoreSelection();
    }
    const el = editorEl();
    const readOnly = mode === "viewing";

    switch (action) {
      case "print":
        window.print();
        return;
      case "undo":
      case "redo":
      case "cut":
      case "copy":
      case "select-all":
      case "delete":
      case "bold":
      case "italic":
      case "underline":
      case "strikeThrough":
      case "superscript":
      case "subscript":
        if (readOnly && action !== "copy" && action !== "select-all") return;
        if (el) runCommand(el, action === "select-all" ? "selectAll" : action);
        afterEdit();
        return;
      case "indent":
        if (el && !readOnly) indentBlocks(el, 1);
        afterEdit();
        return;
      case "outdent":
        if (el && !readOnly) indentBlocks(el, -1);
        afterEdit();
        return;
      case "ul":
      case "ol":
        if (el && !readOnly) toggleList(el, action);
        afterEdit();
        return;
      case "paste":
        if (el && !readOnly) await pasteRich(el);
        afterEdit();
        return;
      case "paste-plain":
        if (el && !readOnly) await pastePlain(el);
        afterEdit();
        return;
      case "search":
        setDialog("search");
        return;
      case "mode":
        setMode((value as ViewMode) || "editing");
        speak(`Mode: ${value}`);
        return;
      case "comments-toggle":
        if (!commentsOpen) {
          setCommentsOpen(true);
          setCommentsMinimized(false);
        } else {
          setCommentsMinimized((min) => !min);
        }
        return;
      case "invisibles":
        setShowInvisibles((on) => !on);
        return;
      case "theme":
        setDarkMode((on) => !on);
        return;
      case "text-color":
        if (el && !readOnly && value) {
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed) restoreSelection(true);
          setTextColor(el, value);
          setTextColorValue(value);
          afterEdit();
        }
        return;
      case "highlight-color":
        if (el && !readOnly && value) {
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed) restoreSelection(true);
          setHighlightColor(el, value);
          setHighlightColorValue(value);
          afterEdit();
        }
        return;
      case "fullscreen":
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else {
          await document.documentElement.requestFullscreen();
        }
        return;
      case "image":
        imageInputRef.current?.click();
        return;
      case "table":
        setDialog("table");
        return;
      case "link":
        openLinkDialog();
        return;
      case "emoji":
        setDialog("emoji");
        return;
      case "special":
        setDialog("special");
        return;
      case "comment":
        addComment();
        return;
      case "tab":
        if (el && !readOnly) insertTab(el);
        afterEdit();
        return;
      case "hr":
        if (el && !readOnly) insertHorizontalLine(el);
        afterEdit();
        return;
      case "page-break":
        if (el && !readOnly) insertPageBreak(el);
        afterEdit();
        return;
      case "caps":
        if (el && !readOnly) applyCapitalization(el, (value as "upper" | "lower" | "title") ?? "upper");
        afterEdit();
        return;
      case "style":
        if (el && !readOnly) applyBlockStyle(el, (value as "normal" | "title" | "subtitle" | "h1" | "h2" | "h3") ?? "normal");
        afterEdit();
        return;
      case "align":
        if (el && !readOnly) setAlignment(el, (value as "left" | "center" | "right" | "justify") ?? "left");
        afterEdit();
        return;
      case "spacing":
        if (el) {
          const next = value || "1.15";
          setSpacing(next);
          setLineSpacing(el, next);
          afterEdit();
        }
        return;
      case "columns":
        if (el) {
          const next = Number(value || 1);
          setColumnCount(next);
          setColumns(el, next);
          afterEdit();
        }
        return;
      case "header":
        setShowHeader((on) => !on);
        return;
      case "footer":
        setShowFooter((on) => !on);
        return;
      case "page-numbers":
        setShowPageNumbers((on) => {
          if (!on) setShowFooter(true);
          return !on;
        });
        return;
      case "clear-format":
        if (el && !readOnly) runCommand(el, "removeFormat");
        afterEdit();
        return;
      case "word-count":
        setDialog("word-count");
        return;
      case "compare":
        setDialog("compare");
        return;
      case "citation":
        setDialog("citation");
        return;
      case "signature":
        setDialog("signature");
        return;
      case "substitutions":
        setSubstitutions((on) => {
          const next = !on;
          if (next && el) applySubstitutionsAll(el);
          return next;
        });
        afterEdit();
        return;
      case "screen-reader":
        setScreenReader((on) => {
          const next = !on;
          if (next) speak(editorRef.current?.getText() || "Empty document.");
          else window.speechSynthesis?.cancel();
          return next;
        });
        return;
      case "shortcuts":
        setDialog("shortcuts");
        return;
      case "ask-inline":
      case "agent-panel":
      case "add-to-chat":
        if (!readOnly) openAsk();
        return;
      default:
        return;
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      const target = event.target;
      const inField = target instanceof HTMLElement && Boolean(target.closest("input, textarea, select"));
      if ((event.key === "Backspace" || event.key === "Delete") && !meta && !inField) {
        const el = editorEl();
        if (el && isEditorVisuallyEmpty(el)) {
          event.preventDefault();
          return;
        }
      }
      if (event.key === "Tab" && !meta && !inField && mode !== "viewing") {
        const el = editorEl();
        if (el && target instanceof Node && !el.contains(target) && target !== el) {
          if (target instanceof HTMLElement && target.closest(".canvas-shell")) {
            event.preventDefault();
            handleTab(el, event.shiftKey);
            afterEdit();
          }
        }
        return;
      }
      if (event.key === "F11") {
        event.preventDefault();
        void handleAction("fullscreen");
        return;
      }
      if (!meta) return;
      const key = event.key.toLowerCase();
      if (key === "f") {
        event.preventDefault();
        setDialog("search");
      }
      if (key === "j" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        if (mode !== "viewing") void handleAction("ask-inline");
      }
      if (key === "k" && !event.shiftKey && !event.altKey && !inField) {
        event.preventDefault();
        openLinkDialog();
      }
      if (key === "v" && event.shiftKey) {
        event.preventDefault();
        void handleAction("paste-plain");
      }
      if (key === "m" && event.altKey) {
        event.preventDefault();
        addComment();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest("[data-agent-action]");
      if (!(button instanceof HTMLElement)) return;
      const wrap = button.closest(".agent-edit");
      const id = wrap instanceof HTMLElement ? wrap.dataset.editId : "";
      const action = button.dataset.agentAction;
      if (!id || (action !== "accept" && action !== "reject")) return;
      event.preventDefault();
      reviewEdit(id, action);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  });

  const scaledWidth = PAGE_WIDTH * zoom;
  const scaledHeight =
    (metrics.pageCount * PAGE_HEIGHT + Math.max(0, metrics.pageCount - 1) * PAGE_GAP) * zoom;

  return (
    <div className="app">
      <header className="header">
        <div className="logo" aria-hidden="true">
          <DocsLogo />
        </div>
        <div className="header-main">
        <div className="header-row">
          <input
            className="title-input"
            value={title}
            aria-label="Document title"
            onChange={(event) => setTitle(event.target.value)}
          />
          {mode !== "editing" && (
            <span className={`mode-pill mode-${mode}`}>
              {mode === "suggesting" ? "Suggesting" : "Viewing"}
            </span>
          )}
          <div className="header-meta">Letter · 1&quot; margins</div>
        </div>
        <MenuBar
          mode={mode}
          readOnly={mode === "viewing"}
          commentsOpen={commentsOpen}
          commentsMinimized={commentsMinimized}
          showInvisibles={showInvisibles}
          isFullscreen={isFullscreen}
          showHeader={showHeader}
          showFooter={showFooter}
          showPageNumbers={showPageNumbers}
          substitutions={substitutions}
          screenReader={screenReader}
          darkMode={Boolean(darkMode)}
          columns={columns}
          lineSpacing={lineSpacing}
          onAction={(action, value) => void handleAction(action, value)}
        />
        </div>
      </header>

      <div className="toolbar-wrap">
        <div className="toolbar" role="toolbar" aria-label="Formatting">
          <button className="tool" type="button" title="Undo" onClick={() => void handleAction("undo")}>
            <UndoIcon />
          </button>
          <button className="tool" type="button" title="Redo" onClick={() => void handleAction("redo")}>
            <RedoIcon />
          </button>
          <span className="toolbar-sep" />
          <FontFamilyPicker
            value={font}
            onPick={(next) => {
              restoreSelection();
              setFont(next);
              editorRef.current?.setFontFamily(next);
            }}
          />
          <FontSizePicker
            value={Number.parseInt(fontSize, 10) || 11}
            onPick={(size) => {
              restoreSelection();
              const next = `${size}pt`;
              setFontSize(next);
              editorRef.current?.setFontSize(next);
            }}
          />
          <span className="toolbar-sep" />
          <button
            className="tool"
            type="button"
            title="Bold"
            data-active={active.bold}
            onClick={() => void handleAction("bold")}
          >
            <BoldIcon />
          </button>
          <button
            className="tool"
            type="button"
            title="Italic"
            data-active={active.italic}
            onClick={() => void handleAction("italic")}
          >
            <ItalicIcon />
          </button>
          <button
            className="tool"
            type="button"
            title="Underline"
            data-active={active.underline}
            onClick={() => void handleAction("underline")}
          >
            <UnderlineIcon />
          </button>
          <ColorPicker
            label="Text color"
            kind="text"
            value={textColor}
            onPick={(color) => void handleAction("text-color", color)}
          />
          <ColorPicker
            label="Highlight color"
            kind="highlight"
            value={highlightColor}
            onPick={(color) => void handleAction("highlight-color", color)}
          />
          <span className="toolbar-sep" />
          <button className="tool" type="button" title="Insert link" onClick={() => void handleAction("link")}>
            <LinkIcon />
          </button>
          <button className="tool" type="button" title="Insert image" onClick={() => void handleAction("image")}>
            <ImageIcon />
          </button>
          <span className="toolbar-sep" />
          <button
            className="tool"
            type="button"
            title="Align left"
            data-active={active.align === "left"}
            onClick={() => void handleAction("align", "left")}
          >
            <AlignLeftIcon />
          </button>
          <button
            className="tool"
            type="button"
            title="Align center"
            data-active={active.align === "center"}
            onClick={() => void handleAction("align", "center")}
          >
            <AlignCenterIcon />
          </button>
          <button
            className="tool"
            type="button"
            title="Align right"
            data-active={active.align === "right"}
            onClick={() => void handleAction("align", "right")}
          >
            <AlignRightIcon />
          </button>
          <button
            className="tool"
            type="button"
            title="Justify"
            data-active={active.align === "justify"}
            onClick={() => void handleAction("align", "justify")}
          >
            <AlignJustifyIcon />
          </button>
          <LineSpacingPicker
            value={lineSpacing}
            onPick={(next) => void handleAction("spacing", next)}
          />
          <span className="toolbar-sep" />
          <button
            className="tool"
            type="button"
            title="Bulleted list"
            data-active={active.list === "ul"}
            onClick={() => void handleAction("ul")}
          >
            <BulletListIcon />
          </button>
          <button
            className="tool"
            type="button"
            title="Numbered list"
            aria-label="Numbered list"
            data-active={active.list === "ol"}
            onClick={() => void handleAction("ol")}
          >
            <NumberedListIcon />
          </button>
          <button className="tool" type="button" title="Decrease indent" onClick={() => void handleAction("outdent")}>
            <OutdentIcon />
          </button>
          <button className="tool" type="button" title="Increase indent" onClick={() => void handleAction("indent")}>
            <IndentIcon />
          </button>
          <button className="tool" type="button" title="Clear formatting" onClick={() => void handleAction("clear-format")}>
            <MdOutlineFormatClear />
          </button>
          <span className="toolbar-sep" />
          <button
            className="tool"
            type="button"
            title="Ask Inline"
            aria-label="Ask Inline"
            data-active={agentOpen}
            disabled={mode === "viewing"}
            onClick={() => void handleAction("ask-inline")}
          >
            <AskIcon />
          </button>
          <span className="toolbar-sep" />
          <select
            className="toolbar-select zoom"
            aria-label="Zoom"
            value={zoomMode === "fit" ? "fit" : String(zoomMode)}
            onChange={(event) => {
              const next = event.target.value;
              setZoomMode(next === "fit" ? "fit" : Number(next));
            }}
          >
            <option value="fit">Fit</option>
            <option value="0.75">75%</option>
            <option value="1">100%</option>
            <option value="1.25">125%</option>
            <option value="1.5">150%</option>
          </select>
        </div>
      </div>

      <div className="workspace-body">
        <div
          className="canvas-shell"
          onContextMenu={(event) => {
            if (mode === "viewing") return;
            event.preventDefault();
            const el = editorEl();
            const selection = window.getSelection();
            const hasSelection = Boolean(
              el &&
                selection &&
                !selection.isCollapsed &&
                selection.toString() &&
                selection.anchorNode &&
                el.contains(selection.anchorNode),
            );
            setContextMenu({
              x: Math.min(event.clientX, window.innerWidth - 260),
              y: Math.min(event.clientY, window.innerHeight - 280),
              hasSelection,
            });
          }}
        >
        <main className="canvas" ref={canvasRef} onScroll={updateCurrentPage}>
          <div className="document-scale" style={{ width: scaledWidth, height: scaledHeight }}>
            <div className="document" style={{ transform: `scale(${zoom})` }}>
              <div className="papers">
                {Array.from({ length: metrics.pageCount }, (_, index) => (
                  <div className="paper" key={index}>
                    {showHeader && (
                      <div className="paper-header">
                        <input
                          className="paper-chrome"
                          value={headerText}
                          placeholder="Header"
                          onChange={(event) => setHeaderText(event.target.value)}
                        />
                      </div>
                    )}
                    {(showFooter || showPageNumbers) && (
                      <div className="paper-footer">
                        {showFooter ? (
                          <input
                            className="paper-chrome"
                            value={footerText}
                            placeholder="Footer"
                            onChange={(event) => setFooterText(event.target.value)}
                          />
                        ) : (
                          <span />
                        )}
                        {showPageNumbers && <span className="page-num">{index + 1}</span>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <EditorSurface
                ref={editorRef}
                mode={mode}
                showInvisibles={showInvisibles}
                substitutions={substitutions}
                columns={columns}
                lineSpacing={lineSpacing}
                onMetricsChange={onMetricsChange}
                onActiveChange={refreshActive}
              />
            </div>
          </div>
        </main>
        <div className="canvas-meta canvas-meta-page">
          Page {Math.min(currentPage, metrics.pageCount)} of {metrics.pageCount}
        </div>
        <div className="canvas-meta canvas-meta-words">
          {metrics.wordCount} {metrics.wordCount === 1 ? "word" : "words"}
        </div>
        </div>
        <AgentPanel
          open={agentOpen}
          minimized={agentMinimized}
          busy={askBusy}
          error={askError}
          prompt={askPrompt}
          context={agentContext}
          turns={agentTurns}
          onPromptChange={setAskPrompt}
          onSubmit={() => void submitAsk()}
          onClearContext={() => setAgentContext(null)}
          onMinimizedChange={setAgentMinimized}
          onClose={() => setAgentOpen(false)}
          onNewChat={() => {
            setAgentTurns([]);
            setAskPrompt("");
            setAskError(null);
            setAgentContext(null);
          }}
          onJump={(id) => {
            const el = editorEl();
            if (el) jumpToAgentEdit(el, id);
          }}
          onAccept={(id) => reviewEdit(id, "accept")}
          onReject={(id) => reviewEdit(id, "reject")}
          onAcceptAll={() => reviewAll("accept")}
          onRejectAll={() => reviewAll("reject")}
        />
        {commentsOpen && (
          <CommentsPanel
            comments={comments}
            minimized={commentsMinimized}
            onMinimizedChange={setCommentsMinimized}
            onChange={(id, body) =>
              setComments((list) => list.map((comment) => (comment.id === id ? { ...comment, body } : comment)))
            }
            onDelete={(id) => {
              const el = editorEl();
              el?.querySelectorAll(`mark[data-comment-id="${id}"]`).forEach((mark) => {
                mark.replaceWith(...mark.childNodes);
              });
              setComments((list) => list.filter((comment) => comment.id !== id));
              afterEdit();
            }}
            onJump={(id) => {
              const mark = editorEl()?.querySelector(`mark[data-comment-id="${id}"]`);
              mark?.scrollIntoView({ block: "center" });
            }}
          />
        )}
        {screenReader && (
          <aside className="sr-panel">
            <div className="comments-head">
              <strong>Screen reader</strong>
              <button type="button" className="dialog-text-btn" onClick={() => setScreenReader(false)}>
                Hide
              </button>
            </div>
            <p>{editorRef.current?.getText() || "Empty document."}</p>
            <div className="dialog-actions">
              <button type="button" onClick={() => speak(editorRef.current?.getText() || "Empty document.")}>
                Read document
              </button>
              <button type="button" onClick={() => window.speechSynthesis?.cancel()}>
                Stop
              </button>
            </div>
          </aside>
        )}
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            const el = editorEl();
            if (el && typeof reader.result === "string") insertImage(el, reader.result);
            afterEdit();
          };
          reader.readAsDataURL(file);
        }}
      />

      {dialog === "search" && (
        <SearchReplaceDialog
          onClose={() => setDialog(null)}
          onFind={(query) => {
            const el = editorEl();
            return el ? findNext(el, query) : false;
          }}
          onReplace={(query, replacement) => {
            const el = editorEl();
            if (!el) return false;
            const ok = replaceCurrent(el, query, replacement);
            afterEdit();
            return ok;
          }}
          onReplaceAll={(query, replacement) => {
            const el = editorEl();
            if (!el) return 0;
            const count = replaceAll(el, query, replacement);
            afterEdit();
            return count;
          }}
        />
      )}
      {dialog === "word-count" && (
        <WordCountDialog
          words={metrics.wordCount}
          chars={metrics.charCount}
          paragraphs={editorEl() ? paragraphCount(editorEl()!) : 0}
          pages={metrics.pageCount}
          selectionWords={countWords(selectedText())}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "link" && (
        <LinkDialog
          initialText={linkText}
          onClose={() => setDialog(null)}
          onInsert={(url, text) => {
            restoreSelection();
            const el = editorEl();
            if (el) insertLink(el, url, text);
            setDialog(null);
            afterEdit();
          }}
        />
      )}
      {dialog === "table" && (
        <TableDialog
          onClose={() => setDialog(null)}
          onInsert={(rows, cols) => {
            const el = editorEl();
            if (el) insertTable(el, rows, cols);
            setDialog(null);
            afterEdit();
          }}
        />
      )}
      {dialog === "emoji" && (
        <EmojiDialog
          onClose={() => setDialog(null)}
          onInsert={(value) => {
            const el = editorEl();
            if (el) insertText(el, value);
            afterEdit();
          }}
        />
      )}
      {dialog === "special" && (
        <SpecialCharsDialog
          onClose={() => setDialog(null)}
          onInsert={(value) => {
            const el = editorEl();
            if (el) insertText(el, value);
            setDialog(null);
            afterEdit();
          }}
        />
      )}
      {dialog === "compare" && (
        <CompareDialog currentText={editorRef.current?.getText() ?? ""} onClose={() => setDialog(null)} />
      )}
      {dialog === "citation" && (
        <CitationDialog
          onClose={() => setDialog(null)}
          onInsert={({ author, title: work, year, url }) => {
            const el = editorEl();
            if (!el) return;
            const cite = `(${author || "Author"}, ${year || "n.d."})`;
            insertText(el, ` ${cite} `);
            const bib = [author, work, year, url].filter(Boolean).join(". ");
            if (!el.querySelector(".bibliography")) {
              insertHtml(el, `<h3 class="bibliography">Bibliography</h3><div class="bib-item">${bib}</div>`);
            } else {
              const item = document.createElement("div");
              item.className = "bib-item";
              item.textContent = bib;
              el.querySelector(".bibliography")?.after(item);
            }
            setDialog(null);
            afterEdit();
          }}
        />
      )}
      {dialog === "signature" && (
        <SignatureDialog
          onClose={() => setDialog(null)}
          onInsert={(dataUrl) => {
            const el = editorEl();
            if (el) insertImage(el, dataUrl);
            setDialog(null);
            afterEdit();
          }}
        />
      )}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onAction={(action) => void handleAction(action)}
          items={[
            { label: "Cut", action: "cut", shortcut: "⌘X", disabled: !contextMenu.hasSelection },
            { label: "Copy", action: "copy", shortcut: "⌘C", disabled: !contextMenu.hasSelection },
            { label: "Paste", action: "paste", shortcut: "⌘V" },
            { label: "Paste without formatting", action: "paste-plain", shortcut: "⌘⇧V" },
            { label: "Delete", action: "delete", disabled: !contextMenu.hasSelection },
            { label: "Comment", action: "comment", shortcut: "⌘⌥M", disabled: !contextMenu.hasSelection },
            { label: "Add text to AI chat", action: "add-to-chat", disabled: !contextMenu.hasSelection },
            { label: "Clear formatting", action: "clear-format", disabled: !contextMenu.hasSelection },
          ]}
        />
      )}

      <div className="sr-live" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

function AskIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.5 13.2 8.2 18 9.4 13.2 10.6 12 15.3 10.8 10.6 6 9.4l4.8-1.2L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M18.5 14.5 19.2 16.8 21.5 17.5 19.2 18.2 18.5 20.5 17.8 18.2 15.5 17.5l2.3-.7.7-2.3Z" fill="currentColor" />
    </svg>
  );
}

function DocsLogo() {
  return (
    <svg viewBox="7.5 3.5 23 33" width="28" height="40" aria-hidden="true">
      <rect x="8" y="4" width="22" height="32" rx="2.5" fill="#1e293b" />
      <circle cx="25.5" cy="8.5" r="2.15" fill="var(--doc-mark)" />
      <rect x="13" y="18" width="12" height="2" rx="1" fill="#e5e7eb" />
      <rect x="13" y="23" width="12" height="2" rx="1" fill="#e5e7eb" />
      <rect x="13" y="28" width="8" height="2" rx="1" fill="#e5e7eb" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 8 4 12l4 4"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 12h11.2a5.3 5.3 0 1 1 0 10.6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M16 8 20 12l-4 4"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 12H8.8a5.3 5.3 0 1 0 0 10.6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BoldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M7.5 5h6.1c2.2 0 3.9 1.5 3.9 3.5 0 1.4-.8 2.5-2 3.1 1.6.5 2.7 1.8 2.7 3.5 0 2.3-1.8 3.9-4.3 3.9H7.5V5Zm3 5.7h2.6c.9 0 1.5-.6 1.5-1.4s-.6-1.4-1.5-1.4H10.5v2.8Zm0 5.6h3c1 0 1.7-.6 1.7-1.6s-.7-1.6-1.7-1.6h-3v3.2Z" />
    </svg>
  );
}

function ItalicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M10 4h9v3h-2.7l-3.5 10H16v3H6v-3h2.8l3.5-10H10V4Z" />
    </svg>
  );
}

function UnderlineIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M7 5v7.2c0 2.8 1.9 4.8 5 4.8s5-2 5-4.8V5h-2.6v7.1c0 1.5-1 2.6-2.4 2.6s-2.4-1.1-2.4-2.6V5H7Zm-1 14v1.8h12V19H6Z" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M9.6 13.8a3.6 3.6 0 0 1 0-5.1l2.5-2.5a3.6 3.6 0 0 1 5.1 5.1l-1.1 1.1-1.3-1.3 1.1-1.1a1.8 1.8 0 1 0-2.5-2.5l-2.5 2.5a1.8 1.8 0 0 0 0 2.5l.4.4-1.3 1.3-.4-.4Zm4.8-3.6a3.6 3.6 0 0 1 0 5.1l-2.5 2.5a3.6 3.6 0 1 1-5.1-5.1l1.1-1.1 1.3 1.3-1.1 1.1a1.8 1.8 0 1 0 2.5 2.5l2.5-2.5a1.8 1.8 0 0 0 0-2.5l-.4-.4 1.3-1.3.4.4Z" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm0 11.2 3.4-3.4 2.4 2.4 4.4-4.4L19 14.4V7H5v9.2ZM8.2 10.1a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Z" />
    </svg>
  );
}

function AlignLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 6h16v1.8H4V6Zm0 5.1h11v1.8H4v-1.8Zm0 5.1h16V18H4v-1.8Z" />
    </svg>
  );
}

function AlignCenterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 6h16v1.8H4V6Zm2.5 5.1h11v1.8h-11v-1.8ZM4 16.2h16V18H4v-1.8Z" />
    </svg>
  );
}

function AlignRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 6h16v1.8H4V6Zm5 5.1h11v1.8H9v-1.8ZM4 16.2h16V18H4v-1.8Z" />
    </svg>
  );
}

function AlignJustifyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 6h16v1.8H4V6Zm0 5.1h16v1.8H4v-1.8ZM4 16.2h16V18H4v-1.8Z" />
    </svg>
  );
}

function BulletListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="5" cy="6.5" r="1.45" fill="currentColor" />
      <circle cx="5" cy="12" r="1.45" fill="currentColor" />
      <circle cx="5" cy="17.5" r="1.45" fill="currentColor" />
      <path
        d="M9.2 6.5h11M9.2 12h11M9.2 17.5h11"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NumberedListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M10 6.5h10.2M10 12h10.2M10 17.5h10.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <g
        fill="currentColor"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize="6.5"
        fontWeight="700"
        textAnchor="middle"
      >
        <text x="5.15" y="8.45">
          1
        </text>
        <text x="5.15" y="13.95">
          2
        </text>
        <text x="5.15" y="19.45">
          3
        </text>
      </g>
    </svg>
  );
}

function OutdentIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 6h16v1.7H4V6Zm8 5.15h8v1.7h-8v-1.7ZM4 16.3h16V18H4v-1.7Zm3.6-7.4L4 12.5l3.6 3.6V13.8H11v-2.6H7.6V8.9Z" />
    </svg>
  );
}

function IndentIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 6h16v1.7H4V6Zm8 5.15h8v1.7h-8v-1.7ZM4 16.3h16V18H4v-1.7ZM4 8.9v3.6h3.4v2.6L11 12.5 7.4 8.9v2.6H4V8.9Z" />
    </svg>
  );
}

