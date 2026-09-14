"use client";

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import {
  applyFontFamily,
  applyFontSize,
  applySubstitutionsNearCaret,
  handleTab,
  maybeConvertMarkdownList,
  sanitizeCopiedHtml,
  selectionBlockStyle,
  selectionFontMetrics,
  suggestionDelete,
  suggestionInsert,
  toggleList,
  writeClipboardFromSelection,
} from "@/lib/editorApi";
import { constrainImage, normalizeImages, selectImage, selectedImage } from "@/lib/images";
import { sanitizeStoredHtml, serializeEditorHtml } from "@/lib/documentStore";
import {
  countWords,
  DEFAULT_PAGE_LAYOUT,
  getPlainText,
  isEditorVisuallyEmpty,
  needsReflow,
  pageBreakHeight,
  pageContentHeight,
  pageContentWidth,
  preserveCaret,
  reflowPages,
  visualScale,
  type PageLayout,
} from "@/lib/pagination";
import type { ViewMode } from "@/components/MenuBar";

export type EditorMetrics = {
  pageCount: number;
  wordCount: number;
  charCount: number;
};

export type EditorHandle = {
  focus: () => void;
  getElement: () => HTMLDivElement | null;
  format: (command: string, value?: string) => void;
  setFontFamily: (family: string) => void;
  setFontSize: (size: string) => void;
  queryActive: () => {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    font: string;
    fontSize: string;
    blockStyle: "normal" | "title" | "subtitle" | "h1" | "h2" | "h3";
    align: "left" | "center" | "right" | "justify";
    list: "ul" | "ol" | null;
  };
  reflow: () => void;
  getText: () => string;
  getHtml: () => string;
  setHtml: (html: string) => void;
};

type Props = {
  mode: ViewMode;
  showInvisibles: boolean;
  substitutions: boolean;
  columns: number;
  lineSpacing: string;
  pageLayout: PageLayout;
  initialHtml?: string;
  onMetricsChange: (metrics: EditorMetrics) => void;
  onActiveChange?: () => void;
  onContentChange?: (html?: string) => void;
  onSlashQuery?: (query: string | null, rect: DOMRect | null) => void;
  onReady?: () => void;
};

function applyEditorMinHeight(editor: HTMLElement, pageCount: number, layout: PageLayout) {
  const minHeight =
    pageCount * pageContentHeight(layout) + Math.max(0, pageCount - 1) * pageBreakHeight(layout);
  editor.style.minHeight = `${minHeight}px`;
}

export const EditorSurface = memo(forwardRef<EditorHandle, Props>(function EditorSurface(
  {
    mode,
    showInvisibles,
    substitutions,
    columns,
    lineSpacing,
    pageLayout = DEFAULT_PAGE_LAYOUT,
    initialHtml,
    onMetricsChange,
    onActiveChange,
    onContentChange,
    onSlashQuery,
    onReady,
  },
  ref,
) {
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const rafRef = useRef<number>(0);
  const metricsTimerRef = useRef(0);
  const lastPagesRef = useRef(1);
  const lastWordsRef = useRef(0);
  const lastCharsRef = useRef(0);
  const restoredRef = useRef(false);
  const focusedOnReadyRef = useRef(false);
  const initialHtmlRef = useRef(initialHtml);
  const onContentChangeRef = useRef(onContentChange);
  const onSlashQueryRef = useRef(onSlashQuery);
  const onReadyRef = useRef(onReady);
  onContentChangeRef.current = onContentChange;
  onSlashQueryRef.current = onSlashQuery;
  onReadyRef.current = onReady;
  const dragRef = useRef<{
    img: HTMLImageElement;
    handle: string;
    startX: number;
    startW: number;
  } | null>(null);
  const selectingRef = useRef<{ node: Node; offset: number } | null>(null);
  const modeRef = useRef(mode);
  const substitutionsRef = useRef(substitutions);
  modeRef.current = mode;
  substitutionsRef.current = substitutions;

  const publishPageCount = useCallback(
    (pageCount: number) => {
      const editor = editorRef.current;
      if (!editor) return;
      applyEditorMinHeight(editor, pageCount, pageLayout);
      if (pageCount === lastPagesRef.current) return;
      lastPagesRef.current = pageCount;
      onMetricsChange({
        pageCount,
        wordCount: lastWordsRef.current,
        charCount: lastCharsRef.current,
      });
    },
    [onMetricsChange, pageLayout],
  );

  const scheduleWordMetrics = useCallback(
    (pageCount: number) => {
      lastPagesRef.current = pageCount;
      window.clearTimeout(metricsTimerRef.current);
      metricsTimerRef.current = window.setTimeout(() => {
        const editor = editorRef.current;
        if (!editor) return;
        const text = getPlainText(editor, true);
        lastWordsRef.current = countWords(text);
        lastCharsRef.current = text.length;
        onMetricsChange({
          pageCount: lastPagesRef.current,
          wordCount: lastWordsRef.current,
          charCount: lastCharsRef.current,
        });
      }, 160);
    },
    [onMetricsChange],
  );

  const reflow = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.querySelector("img")) normalizeImages(editor, pageLayout);

    if (!needsReflow(editor, pageLayout)) {
      publishPageCount(1);
      scheduleWordMetrics(1);
    } else {
      const pageCount = preserveCaret(editor, () => reflowPages(editor, pageLayout));
      publishPageCount(pageCount);
      scheduleWordMetrics(pageCount);
    }
    onContentChangeRef.current?.();
  }, [pageLayout, publishPageCount, scheduleWordMetrics]);

  const scheduleReflow = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      if (composingRef.current) return;
      reflow();
    });
  }, [reflow]);

  useEffect(() => {
    document.execCommand("defaultParagraphSeparator", false, "div");
    const editor = editorRef.current;
    if (editor) {
      if (!restoredRef.current && initialHtmlRef.current) {
        editor.innerHTML = sanitizeStoredHtml(initialHtmlRef.current);
        restoredRef.current = true;
      }
      if (!focusedOnReadyRef.current) {
        focusedOnReadyRef.current = true;
        editor.focus();
        onReadyRef.current?.();
      }
      reflow();
    }
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.clearTimeout(metricsTimerRef.current);
    };
  }, [reflow]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.style.lineHeight = lineSpacing;
    editor.style.columnCount = columns > 1 ? String(columns) : "";
    editor.style.columnGap = columns > 1 ? "0.4in" : "";
    scheduleReflow();
  }, [columns, lineSpacing, scheduleReflow]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const editor = editorRef.current;
      if (!editor || modeRef.current === "viewing" || event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Node) || editor.contains(target)) return;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest("input, textarea, button, .paper-chrome, .paper-chrome-hit, .paper-header-stack, .paper-footer-stack")) return;
      if (!target.closest(".paper, .document")) return;
      event.preventDefault();
      editor.focus({ preventScroll: true });
      const rect = editor.getBoundingClientRect();
      const caret =
        rangeFromPoint(
          clampPoint(event.clientX, rect.left + 1, rect.right - 1),
          clampPoint(event.clientY, rect.top + 1, rect.bottom - 1),
        ) ?? rangeFromPoint(rect.left + 1, clampPoint(event.clientY, rect.top + 1, rect.bottom - 1));
      if (!caret || !editor.contains(caret.startContainer)) return;
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
      selectingRef.current = { node: caret.startContainer, offset: caret.startOffset };
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const editor = editorRef.current;
      if (!editor) return;
      const drag = dragRef.current;
      if (drag) {
        const scale = visualScale(editor);
        const dx = (event.clientX - drag.startX) / scale;
        const signed = drag.handle.includes("w") ? -dx : dx;
        const ratio = (drag.img.naturalHeight || 1) / (drag.img.naturalWidth || 1);
        const maxW = Math.min(pageContentWidth(pageLayout), editor.clientWidth || pageContentWidth(pageLayout));
        const maxH = pageContentHeight(pageLayout);
        const nextW = Math.min(maxW, Math.max(48, drag.startW + signed));
        const nextH = nextW * ratio;
        const width = nextH > maxH ? maxH / ratio : nextW;
        drag.img.style.width = `${Math.round(width)}px`;
        return;
      }
      if (event.buttons !== 1 || !selectingRef.current) return;
      extendEditorSelection(editor, selectingRef.current, event.clientX, event.clientY);
    };
    const onUp = () => {
      selectingRef.current = null;
      if (!dragRef.current) return;
      const img = dragRef.current.img;
      dragRef.current = null;
      constrainImage(img);
      scheduleReflow();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [pageLayout, scheduleReflow]);

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    getElement: () => editorRef.current,
    format: (command, value) => {
      editorRef.current?.focus();
      document.execCommand(command, false, value);
      scheduleReflow();
      onActiveChange?.();
    },
    setFontFamily: (family) => {
      const editor = editorRef.current;
      if (!editor) return;
      applyFontFamily(editor, family);
      scheduleReflow();
      onActiveChange?.();
    },
    setFontSize: (size) => {
      const editor = editorRef.current;
      if (!editor) return;
      applyFontSize(editor, size);
      scheduleReflow();
      onActiveChange?.();
    },
    queryActive: () => {
      const editor = editorRef.current;
      const metrics = editor ? selectionFontMetrics(editor) : { family: "Arial", sizePt: 11 };
      return {
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        underline: document.queryCommandState("underline"),
        font: metrics.family,
        fontSize: `${metrics.sizePt}pt`,
        blockStyle: editor ? selectionBlockStyle(editor) : "normal",
        align: document.queryCommandState("justifyCenter")
          ? "center"
          : document.queryCommandState("justifyRight")
            ? "right"
            : document.queryCommandState("justifyFull")
              ? "justify"
              : "left",
        list: document.queryCommandState("insertOrderedList")
          ? "ol"
          : document.queryCommandState("insertUnorderedList")
            ? "ul"
            : null,
      };
    },
    reflow: scheduleReflow,
    getText: () => {
      const editor = editorRef.current;
      return editor ? getPlainText(editor, true) : "";
    },
    getHtml: () => {
      const editor = editorRef.current;
      return editor ? serializeEditorHtml(editor) : "";
    },
    setHtml: (html) => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.innerHTML = sanitizeStoredHtml(html);
      scheduleReflow();
    },
  }));

  const className = [
    "editor",
    showInvisibles ? "show-invisibles" : "",
    mode === "viewing" ? "is-viewing" : "",
    mode === "suggesting" ? "is-suggesting" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={editorRef}
      className={className}
      contentEditable={mode !== "viewing"}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Document"
      aria-readonly={mode === "viewing"}
      spellCheck
      onLoadCapture={(event) => {
        const img = event.target;
        if (!(img instanceof HTMLImageElement)) return;
        constrainImage(img, pageLayout);
        scheduleReflow();
      }}
      onMouseDown={(event) => {
        const editor = editorRef.current;
        if (!editor || modeRef.current === "viewing") return;
        const target = event.target as HTMLElement;
        const wrap = target.closest(".doc-image");
        selectImage(editor, wrap instanceof HTMLElement ? wrap : null);
        const handle = target.closest(".img-handle");
        const img = wrap?.querySelector("img");
        if (handle instanceof HTMLElement && img instanceof HTMLImageElement) {
          event.preventDefault();
          const scale = visualScale(editor);
          dragRef.current = {
            img,
            handle: handle.dataset.handle || "se",
            startX: event.clientX,
            startW: img.getBoundingClientRect().width / scale,
          };
          return;
        }
        window.requestAnimationFrame(() => {
          const selection = window.getSelection();
          if (!selection?.anchorNode || !editor.contains(selection.anchorNode)) return;
          selectingRef.current = { node: selection.anchorNode, offset: selection.anchorOffset };
        });
      }}
      onBeforeInput={(event) => {
        if (modeRef.current !== "suggesting") return;
        const input = event.nativeEvent as InputEvent;
        const inputType = typeof input.inputType === "string" ? input.inputType : "";
        const editor = editorRef.current;
        if (!editor) return;
        if (inputType === "insertText" && input.data) {
          event.preventDefault();
          suggestionInsert(editor, input.data);
          scheduleReflow();
          return;
        }
        if (inputType.startsWith("delete")) {
          event.preventDefault();
          suggestionDelete(editor);
          scheduleReflow();
        }
      }}
      onInput={() => {
        const editor = editorRef.current;
        if (editor && substitutionsRef.current) {
          applySubstitutionsNearCaret(editor);
        }
        const selection = window.getSelection();
        const block = blockText(selection);
        if (block.startsWith("/")) {
          const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
          onSlashQueryRef.current?.(block.slice(1), rect);
        } else {
          onSlashQueryRef.current?.(null, null);
        }
        scheduleReflow();
      }}
      onCopy={(event) => {
        const editor = editorRef.current;
        if (editor) writeClipboardFromSelection(event.nativeEvent, editor, false);
      }}
      onCut={(event) => {
        const editor = editorRef.current;
        if (editor && writeClipboardFromSelection(event.nativeEvent, editor, true)) {
          scheduleReflow();
        }
      }}
      onPaste={(event) => {
        const editor = editorRef.current;
        if (!editor || modeRef.current === "viewing") return;
        const html = event.clipboardData?.getData("text/html");
        if (!html) {
          scheduleReflow();
          return;
        }
        event.preventDefault();
        document.execCommand("insertHTML", false, sanitizeCopiedHtml(html));
        scheduleReflow();
      }}
      onKeyDown={(event) => {
        const editor = editorRef.current;
        if (!editor || modeRef.current === "viewing") return;
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "Digit8") {
          event.preventDefault();
          toggleList(editor, "ul");
          scheduleReflow();
          return;
        }
        if (modeRef.current === "suggesting" && (event.key === "Backspace" || event.key === "Delete")) {
          event.preventDefault();
          suggestionDelete(editor);
          scheduleReflow();
          return;
        }
        if (event.key === "Backspace" || event.key === "Delete") {
          if (selectedImage(editor)) {
            event.preventDefault();
            selectedImage(editor)?.remove();
            scheduleReflow();
            return;
          }
          if (isEditorVisuallyEmpty(editor)) {
            event.preventDefault();
            return;
          }
        }
        if (event.key === "Tab") {
          event.preventDefault();
          handleTab(editor, event.shiftKey);
          scheduleReflow();
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          if (maybeConvertMarkdownList(editor, event.key)) {
            event.preventDefault();
            scheduleReflow();
          }
        }
      }}
      onKeyUp={() => onActiveChange?.()}
      onMouseUp={() => onActiveChange?.()}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
        scheduleReflow();
      }}
    />
  );
}));

function extendEditorSelection(
  editor: HTMLElement,
  anchor: { node: Node; offset: number },
  clientX: number,
  clientY: number,
) {
  const over = document.elementFromPoint(clientX, clientY);
  if (over && editor.contains(over)) return;
  const rect = editor.getBoundingClientRect();
  if (!anchor.node.isConnected) return;
  const x = clampPoint(clientX, rect.left + 1, rect.right - 1);
  const y = clampPoint(clientY, rect.top + 1, rect.bottom - 1);
  const caret = rangeFromPoint(x, y) ?? rangeFromPoint(x, y - 12) ?? rangeFromPoint(x, y + 12);
  if (!caret || !editor.contains(caret.startContainer)) return;
  const selection = window.getSelection();
  if (!selection) return;
  try {
    selection.setBaseAndExtent(anchor.node, anchor.offset, caret.startContainer, caret.startOffset);
  } catch {
    /* The editor may have reflowed mid-drag. */
  }
}

function rangeFromPoint(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === "function") {
    return doc.caretRangeFromPoint(x, y);
  }
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (!pos) return null;
  const range = document.createRange();
  try {
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
  } catch {
    return null;
  }
  return range;
}

function clampPoint(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function blockText(selection: Selection | null) {
  if (!selection?.anchorNode) return "";
  const node = selection.anchorNode;
  const el = node instanceof Element ? node : node.parentElement;
  const block = el?.closest("div, p, h1, h2, h3, li") ?? el;
  return (block?.textContent ?? "").trim();
}
