"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MdOutlineFormatClear } from "react-icons/md";
import { AgentPanel } from "@/components/AgentPanel";
import { AgentToast } from "@/components/AgentToast";
import { CommandPalette, type PaletteCommand } from "@/components/CommandPalette";
import { DiffReviewBar } from "@/components/DiffReviewBar";
import { CommentsPanel, type DocComment } from "@/components/CommentsPanel";
import { HistoryPanel } from "@/components/HistoryPanel";
import { InlineComposer } from "@/components/InlineComposer";
import { LintPanel } from "@/components/LintPanel";
import { SlashMenu } from "@/components/SlashMenu";
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
import { applyClientTools } from "@/lib/agent/clientTools";
import { acceptMissingEdits, createChat, loadChats, patchChat, pendingEditIds, removeTurnsFrom, saveChats, setEditStatus, titleFromPrompt } from "@/lib/agent/chats";
import { loadDocument, saveDocument } from "@/lib/documentStore";
import { acceptAgentEdit, applyAgentEdits, captureAgentSelection, documentEditIds, jumpToAgentEdit, rejectAgentEdit, replaceAgentEdits, sameAgentSelection, selectionFromOffsets, settleAgentEdits } from "@/lib/agent/edits";
import { AGENT_MODELS, DEFAULT_MODEL } from "@/lib/agent/models";
import { runAgentJob } from "@/lib/agent/runJob";
import type { AgentAttachment, AgentChat, AgentCitation, AgentEditDraft, AgentMode, AgentQueueItem, AgentSelection, AgentTask, PendingEdit, ThinkingLevel } from "@/lib/agent/types";
import { loadHistory, pushSnapshot, saveHistory, snapshotLabel, type HistorySnapshot } from "@/lib/historyStore";
import { listLockedRanges, wrapLockedRegion } from "@/lib/locks";
import { lintWriting } from "@/lib/writing/lint";
import { PROMPT_TEMPLATES, QUICK_PROMPTS, templateById } from "@/lib/writing/templates";
import { cleanAiArtifactsInEditor, detectAiTropes } from "@/lib/writing/tropes";
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

type AgentJobOptions = {
  prompt: string;
  context?: AgentSelection[];
  comments?: DocComment[];
  mode?: AgentMode;
  openPanel?: boolean;
  silent?: boolean;
  clearPrompt?: boolean;
  chatId?: string;
};

function editFingerprint(edit: Pick<AgentEditDraft, "find" | "replace" | "operation" | "occurrence">) {
  const operation = edit.operation ?? (edit.replace === "" ? "delete" : edit.find === "" ? "insert" : "replace");
  return JSON.stringify([operation, edit.find, edit.replace, edit.occurrence ?? 0]);
}

function suppressRepeatedEdits(
  drafts: AgentEditDraft[],
  previousEdits: Array<Pick<AgentEditDraft, "find" | "replace" | "operation" | "occurrence">>,
  prompt: string,
) {
  if (!previousEdits.length || /\b(again|repeat|redo|reapply|re-?do)\b/i.test(prompt)) return drafts;
  const prior = new Set(previousEdits.map(editFingerprint));
  return drafts.filter((draft) => !prior.has(editFingerprint(draft)));
}

const TOOLBAR_OVERFLOW_GROUPS = ["font", "style", "insert", "align", "lists", "ai"] as const;
type ToolbarOverflowId = (typeof TOOLBAR_OVERFLOW_GROUPS)[number];

const TOOLBAR_GROUP_FALLBACK: Record<ToolbarOverflowId, number> = {
  font: 176,
  style: 144,
  insert: 58,
  align: 172,
  lists: 144,
  ai: 116,
};

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
  const [docReady, setDocReady] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [initialHtml, setInitialHtml] = useState("");
  const persistTimer = useRef(0);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentMinimized, setAgentMinimized] = useState(false);
  const [askPrompt, setAskPrompt] = useState("");
  const [chatDrafts, setChatDrafts] = useState<Record<string, string>>({});
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [livePhase, setLivePhase] = useState<"thinking" | "planning" | "editing" | "reviewing" | null>(null);
  const [liveThinking, setLiveThinking] = useState("");
  const [livePrompt, setLivePrompt] = useState("");
  const [liveSelection, setLiveSelection] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState("");
  const [liveEdits, setLiveEdits] = useState<PendingEdit[]>([]);
  const [liveCitations, setLiveCitations] = useState<AgentCitation[]>([]);
  const [queuedJobs, setQueuedJobs] = useState<AgentQueueItem[]>([]);
  const [agentContext, setAgentContext] = useState<AgentSelection[]>([]);
  const [chats, setChats] = useState<AgentChat[]>([]);
  const [activeChatId, setActiveChatId] = useState("");
  const [chatsReady, setChatsReady] = useState(false);
  const [modelCatalog, setModelCatalog] = useState(AGENT_MODELS);
  const [availableProviders, setAvailableProviders] = useState({ openai: true, anthropic: false });
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
  const [focusMode, setFocusMode] = useState(false);
  const [preserveTone, setPreserveTone] = useState(true);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [history, setHistory] = useState<HistorySnapshot[]>([]);
  const historyRef = useRef<HistorySnapshot[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [lintOpen, setLintOpen] = useState(false);
  const [inlineOpen, setInlineOpen] = useState(false);
  const [inlinePrompt, setInlinePrompt] = useState("");
  const [inlineBox, setInlineBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const [slash, setSlash] = useState<{ query: string; top: number; left: number } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; action?: () => void } | null>(null);
  const [liveTools, setLiveTools] = useState<string[]>([]);
  const toastTimer = useRef(0);
  const chatPersistTimer = useRef(0);
  const jobAbortRef = useRef<AbortController | null>(null);
  const jobRunningRef = useRef(false);
  const jobQueueRef = useRef<Array<AgentJobOptions & { queueId: string; selection?: string | null }>>([]);
  const pendingRevertRef = useRef<string | null>(null);
  const inlineContextRef = useRef<AgentSelection | null>(null);
  const suppressContextSyncRef = useRef(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarWidths = useRef<Partial<Record<ToolbarOverflowId, number>>>({});
  const [toolbarOverflow, setToolbarOverflow] = useState<ToolbarOverflowId[]>([]);
  const [toolbarMoreOpen, setToolbarMoreOpen] = useState(false);

  useEffect(() => {
    const next = `${title || "Untitled document"} - Inline`;
    document.title = next;
    const frame = window.requestAnimationFrame(() => {
      document.title = next;
    });
    return () => window.cancelAnimationFrame(frame);
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
    const storedDoc = loadDocument();
    if (storedDoc) {
      setTitle(storedDoc.title);
      setInitialHtml(storedDoc.html);
      setHeaderText(storedDoc.headerText);
      setFooterText(storedDoc.footerText);
      setShowHeader(storedDoc.showHeader);
      setShowFooter(storedDoc.showFooter);
      setShowPageNumbers(storedDoc.showPageNumbers);
      setColumnCount(storedDoc.columns);
      setSpacing(storedDoc.lineSpacing);
      setComments(storedDoc.comments);
    }
    setDocReady(true);
  }, []);

  useEffect(() => {
    const stored = loadChats();
    if (stored) {
      setChats(stored.chats);
      setActiveChatId(stored.activeId);
      setAgentOpen(stored.open);
      setAgentMinimized(stored.minimized);
      setChatDrafts(stored.drafts);
      setAskPrompt(stored.drafts[stored.activeId] ?? "");
    } else {
      const chat = createChat();
      setChats([chat]);
      setActiveChatId(chat.id);
    }
    setChatsReady(true);
    const storedHistory = loadHistory();
    historyRef.current = storedHistory;
    setHistory(storedHistory);
    const storedFocus = window.localStorage.getItem("inline-focus");
    const storedTone = window.localStorage.getItem("inline-preserve-tone");
    if (storedFocus === "1") setFocusMode(true);
    if (storedTone === "0") setPreserveTone(false);
  }, []);

  useEffect(() => {
    if (!chatsReady || !chats.length || !activeChatId) return;
    window.clearTimeout(chatPersistTimer.current);
    chatPersistTimer.current = window.setTimeout(() => {
      saveChats({
        chats,
        activeId: activeChatId,
        open: agentOpen,
        minimized: agentMinimized,
        drafts: { ...chatDrafts, [activeChatId]: askPrompt },
      });
      chatPersistTimer.current = 0;
    }, 180);
    return () => window.clearTimeout(chatPersistTimer.current);
  }, [activeChatId, agentMinimized, agentOpen, askPrompt, chatDrafts, chats, chatsReady]);

  useEffect(() => {
    window.localStorage.setItem("inline-focus", focusMode ? "1" : "0");
  }, [focusMode]);

  useEffect(() => {
    window.localStorage.setItem("inline-preserve-tone", preserveTone ? "1" : "0");
  }, [preserveTone]);

  useEffect(() => {
    saveHistory(history);
  }, [history]);

  const persistDocument = useCallback(
    (html?: string) => {
      if (!docReady || !editorReady) return;
      const nextHtml = html ?? editorRef.current?.getHtml() ?? initialHtml;
      saveDocument({
        title,
        html: nextHtml,
        headerText,
        footerText,
        showHeader,
        showFooter,
        showPageNumbers,
        columns,
        lineSpacing,
        comments,
      });
    },
    [
      comments,
      columns,
      docReady,
      editorReady,
      footerText,
      headerText,
      initialHtml,
      lineSpacing,
      showFooter,
      showHeader,
      showPageNumbers,
      title,
    ],
  );

  const schedulePersist = useCallback(
    (html?: string) => {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = window.setTimeout(() => persistDocument(html), 400);
    },
    [persistDocument],
  );

  useEffect(() => {
    if (!docReady || !editorReady) return;
    schedulePersist();
  }, [
    comments,
    columns,
    docReady,
    editorReady,
    footerText,
    headerText,
    lineSpacing,
    schedulePersist,
    showFooter,
    showHeader,
    showPageNumbers,
    title,
  ]);

  useEffect(() => {
    const flush = () => persistDocument();
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [persistDocument]);

  useEffect(() => () => window.clearTimeout(persistTimer.current), []);

  useEffect(() => {
    void fetch("/api/agent/models")
      .then((response) => response.json())
      .then((data: {
        defaultModel?: string;
        models?: typeof AGENT_MODELS;
        providers?: { openai?: boolean; anthropic?: boolean };
      }) => {
        if (Array.isArray(data.models) && data.models.length) setModelCatalog(data.models);
        setAvailableProviders({
          openai: Boolean(data.providers?.openai),
          anthropic: Boolean(data.providers?.anthropic),
        });
        const nextModel = data.defaultModel || DEFAULT_MODEL;
        setChats((list) =>
          list.map((chat) =>
            !chat.titled && chat.turns.length === 0 && chat.model === DEFAULT_MODEL
              ? { ...chat, model: nextModel }
              : chat,
          ),
        );
      })
      .catch(() => undefined);
  }, []);

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
      if (range.start !== range.end) {
        expandedSelectionRef.current = range;
        if (!suppressContextSyncRef.current && !inlineOpen) {
          const captured = captureAgentSelection(el);
          if (captured) {
            setAgentContext((current) => {
              if (current.length > 0) return current;
              return [captured];
            });
          }
        }
      } else if (document.activeElement === el) {
        expandedSelectionRef.current = null;
      }
    };
    document.addEventListener("selectionchange", saveSelection);
    return () => document.removeEventListener("selectionchange", saveSelection);
  }, [inlineOpen]);

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

  const editorEl = useCallback(() => editorRef.current?.getElement() ?? null, []);
  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? chats[0];
  const reviewIds = pendingEditIds(chats);

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

  const selectionContext = (el: HTMLElement | null): AgentSelection[] => {
    const selected = el ? captureAgentSelection(el) : null;
    return selected ? [selected] : [];
  };

  const openAsk = () => {
    if (mode === "viewing") return;
    setAgentOpen(true);
    setAgentMinimized(false);
    setAskError(null);
  };

  const addSelectionToChat = () => {
    if (mode === "viewing") return;
    const el = editorEl();
    const live = el ? captureAgentSelection(el) : null;
    const stored = el && expandedSelectionRef.current
      ? selectionFromOffsets(el, expandedSelectionRef.current.start, expandedSelectionRef.current.end)
      : null;
    const selected = live ?? stored;
    if (!selected && agentContext.length === 0) {
      speak("Select text to add to chat.");
      return;
    }
    if (selected) {
      setAgentContext((current) =>
        current.some((item) => sameAgentSelection(item, selected)) ? current : [...current, selected],
      );
    }
    openAsk();
  };

  const revealAgentContext = (context?: AgentSelection) => {
    const el = editorEl();
    if (!el || !context) return;
    suppressContextSyncRef.current = true;
    restoreSelectionRange(el, { start: context.start, end: context.end });
    const selection = window.getSelection();
    const node = selection?.rangeCount ? selection.getRangeAt(0).startContainer : null;
    const host = node instanceof Element ? node : node?.parentElement;
    host?.scrollIntoView({ block: "center", behavior: "smooth" });
    window.setTimeout(() => {
      suppressContextSyncRef.current = false;
    }, 0);
  };

  const collapseEditorSelection = (el: HTMLElement) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    if (!selection.anchorNode || !el.contains(selection.anchorNode)) return;
    suppressContextSyncRef.current = true;
    selection.collapseToEnd();
    window.setTimeout(() => {
      suppressContextSyncRef.current = false;
    }, 0);
  };

  const stopJob = () => {
    jobAbortRef.current?.abort();
  };

  const captureSnapshot = (label: string) => {
    const el = editorEl();
    const result = pushSnapshot(historyRef.current, {
      label,
      title,
      html: el ? el.innerHTML : initialHtml,
      headerText,
      footerText,
      showHeader,
      showFooter,
      showPageNumbers,
      columns,
      lineSpacing,
      comments,
    });
    historyRef.current = result.list;
    setHistory(result.list);
    return result.snapshot.id;
  };

  const restoreSnapshot = (id: string, options?: { announce?: string }) => {
    const snap = historyRef.current.find((item) => item.id === id);
    if (!snap) return false;
    captureSnapshot(snapshotLabel("restore"));
    editorRef.current?.setHtml(snap.html);
    setTitle(snap.title);
    setHeaderText(snap.headerText);
    setFooterText(snap.footerText);
    setShowHeader(snap.showHeader);
    setShowFooter(snap.showFooter);
    setShowPageNumbers(snap.showPageNumbers);
    setColumnCount(snap.columns);
    setSpacing(snap.lineSpacing);
    setComments(snap.comments);
    afterEdit();
    if (options?.announce !== "") {
      speak(options?.announce ?? "Restored previous version.");
    }
    return true;
  };

  const showToast = (text: string, action?: () => void) => {
    window.clearTimeout(toastTimer.current);
    setToast({ text, action });
    toastTimer.current = window.setTimeout(() => setToast(null), 7000);
  };

  const executeJob = async (options: AgentJobOptions) => {
    const el = editorEl();
    const prompt = options.prompt.trim();
    const chat = chats.find((item) => item.id === options.chatId) ?? activeChat ?? createChat();
    if (!el || !prompt || mode === "viewing") return false;
    if (pendingRevertRef.current) {
      const revertId = pendingRevertRef.current;
      pendingRevertRef.current = null;
      restoreSnapshot(revertId, { announce: "" });
    }
    const contexts = options.context === undefined ? agentContext : options.context;
    const primaryContext = contexts[contexts.length - 1] ?? null;
    const combinedSelectionText = contexts.map((item) => item.text).join("\n\n");
    const snapshotId = captureSnapshot(snapshotLabel("agent"));
    const controller = new AbortController();
    jobAbortRef.current = controller;
    setAskBusy(true);
    setAskError(null);
    setLiveTools([]);
    setLivePhase((options.mode ?? chat.mode) === "plan" ? "planning" : "thinking");
    setLiveThinking("");
    setLivePrompt(prompt);
    setLiveSelection(combinedSelectionText || null);
    setLiveMessage("");
    setLiveEdits([]);
    setLiveCitations([]);
    if (options.clearPrompt !== false) {
      setAskPrompt("");
      setChatDrafts((drafts) => {
        const next = { ...drafts };
        delete next[chat.id];
        return next;
      });
    }
    const started = Date.now();
    const jobMode = options.mode ?? chat.mode;
    let appliedEdits: PendingEdit[] | null = null;
    let streamedMessage = "";
    let streamedThinking = "";
    const priorEditLedger = chat.turns
      .flatMap((turn) => turn.edits)
      .filter((edit) => edit.status === "pending" || edit.status === "accepted")
      .slice(-16)
    const previousEdits = priorEditLedger
      .slice(-8)
      .map(({ find, replace, operation, occurrence, status }) => ({
        find: find.slice(0, 1_500),
        replace: replace.slice(0, 1_500),
        operation,
        occurrence,
        status: status as "pending" | "accepted",
      }));
    const persistTurn = (data: {
      message: string;
      thinking?: string;
      edits: PendingEdit[];
      mock?: boolean;
      chatTitle?: string;
      tasks?: AgentTask[];
      tools?: { name: string; hidden?: boolean }[];
      citations?: AgentCitation[];
    }) => {
      const nextTitle = data.chatTitle?.trim() || (chat.titled ? chat.title : titleFromPrompt(prompt));
      const nextTasks: AgentTask[] = data.tasks?.length ? data.tasks : chat.tasks;
      setChats((list) => {
        const exists = list.some((item) => item.id === chat.id);
        const base = acceptMissingEdits(exists ? list : [chat, ...list], documentEditIds(el));
        return base.map((item) =>
          item.id === chat.id
            ? {
                ...item,
                title: nextTitle,
                titled: true,
                updatedAt: Date.now(),
                tasks: nextTasks,
                turns: [
                  ...item.turns,
                  {
                    id: crypto.randomUUID(),
                    prompt,
                    selection: combinedSelectionText || null,
                    selections: contexts.map((item) => item.text),
                    message: data.message,
                    thinking: data.thinking,
                    durationMs: Date.now() - started,
                    mock: Boolean(data.mock),
                    mode: jobMode,
                    model: item.model,
                    edits: data.edits,
                    tasks: data.tasks,
                    tools: data.tools,
                    citations: data.citations,
                    snapshotId,
                  },
                ],
              }
            : item,
        );
      });
      setActiveChatId(chat.id);
    };
    try {
      const data = await runAgentJob(
        {
          title,
          prompt,
          document: getPlainText(el, true),
          selection: primaryContext
            ? { text: primaryContext.text, before: primaryContext.before, after: primaryContext.after }
            : null,
          selections: contexts.map(({ text, before, after }) => ({ text, before, after })),
          mode: jobMode,
          model: chat.model,
          thinkingLevel: chat.thinkingLevel,
          nameChat: !chat.titled,
          history: chat.turns.flatMap((turn) => [
            { role: "user" as const, content: turn.prompt },
            { role: "assistant" as const, content: turn.message },
          ]),
          comments: options.comments?.map((comment) => ({
            id: comment.id,
            quote: comment.quote,
            body: comment.body,
          })),
          attachments,
          lockedRanges: listLockedRanges(el),
          previousEdits,
          preserveTone,
          pageCount: metrics.pageCount,
        },
        {
          signal: controller.signal,
          onPhase: setLivePhase,
          onThinking: (text) => {
            streamedThinking = text;
            setLiveThinking(text);
          },
          onMessage: (text) => {
            streamedMessage = text;
            setLiveMessage(text);
          },
          onEdits: (drafts) => {
            if (jobMode !== "agent") return;
            appliedEdits = replaceAgentEdits(
              el,
              suppressRepeatedEdits(drafts, priorEditLedger, prompt),
              primaryContext,
              appliedEdits ?? [],
            );
            setLiveEdits(appliedEdits);
            setLivePhase("editing");
            setChats((list) => acceptMissingEdits(list, documentEditIds(el)));
            collapseEditorSelection(el);
            afterEdit();
          },
          onTool: (name) => {
            setLiveTools((list) => (list.includes(name) ? list : [...list, name]));
          },
          onCitations: (citations) => setLiveCitations(citations),
        },
      );
      const edits =
        appliedEdits ??
        (jobMode === "agent"
          ? applyAgentEdits(el, suppressRepeatedEdits(data.edits ?? [], priorEditLedger, prompt), primaryContext)
          : []);
      collapseEditorSelection(el);
      if (data.tools?.length) {
        applyClientTools(el, data.tools, {
          print: () => window.print(),
          setHeader: setHeaderText,
          showHeader: () => setShowHeader(true),
          showPageNumbers: () => {
            setShowFooter(true);
            setShowPageNumbers(true);
          },
        });
      }
      persistTurn({
        message: data.message || "Review the proposed edits.",
        thinking: data.thinking,
        edits,
        mock: data.mock,
        chatTitle: data.chatTitle,
        tasks: data.tasks,
        tools: data.tools?.map((tool) => ({ name: tool.name, hidden: tool.hidden })),
        citations: data.citations,
      });
      if (options.openPanel) {
        setAgentOpen(true);
        setAgentMinimized(false);
      }
      setInlineOpen(false);
      afterEdit();
      const pending = edits.filter((edit) => edit.status === "pending").length;
      const summary = pending
        ? `${pending} ${pending === 1 ? "edit" : "edits"} ready to keep or undo.`
        : data.message || "Done.";
      speak(summary);
      if (options.silent) {
        showToast(summary, () => {
          setAgentOpen(true);
          setAgentMinimized(false);
        });
      }
      return true;
    } catch (error) {
      if (isAbortError(error)) {
        pendingRevertRef.current = snapshotId;
        afterEdit();
        return false;
      }
      const message = error instanceof Error ? error.message : "The agent could not propose edits.";
      setAskError(message);
      if (!options.silent) {
        setAgentOpen(true);
        setAgentMinimized(false);
      } else {
        showToast(message);
      }
      return false;
    } finally {
      if (jobAbortRef.current === controller) jobAbortRef.current = null;
      setAskBusy(false);
      setLivePhase(null);
      setLiveThinking("");
      setLivePrompt("");
      setLiveSelection(null);
      setLiveMessage("");
      setLiveEdits([]);
      setLiveCitations([]);
      setLiveTools([]);
      jobRunningRef.current = false;
      const next = jobQueueRef.current.shift();
      setQueuedJobs(jobQueueRef.current.map((item) => ({ id: item.queueId, prompt: item.prompt, selection: item.selection })));
      if (next) {
        window.setTimeout(() => {
          jobRunningRef.current = true;
          void executeJob(next);
        }, 0);
      }
    }
  };

  const runJob = async (options: AgentJobOptions) => {
    const prompt = options.prompt.trim();
    const el = editorEl();
    if (!el || !prompt || mode === "viewing") return false;
    const context = options.context === undefined ? agentContext : options.context;
    const chatId = options.chatId ?? activeChat?.id;
    if (jobRunningRef.current || askBusy) {
      const queued = {
        ...options,
        prompt,
        context,
        chatId,
        queueId: crypto.randomUUID(),
        selection: context.map((item) => item.text).join("\n\n") || null,
      };
      jobQueueRef.current.push(queued);
      setQueuedJobs(jobQueueRef.current.map((item) => ({ id: item.queueId, prompt: item.prompt, selection: item.selection })));
      setAskError(null);
      speak("Instruction queued.");
      return true;
    }
    jobRunningRef.current = true;
    return executeJob({ ...options, prompt, context, chatId });
  };

  const cancelQueuedJob = (id: string) => {
    jobQueueRef.current = jobQueueRef.current.filter((item) => item.queueId !== id);
    setQueuedJobs(jobQueueRef.current.map((item) => ({ id: item.queueId, prompt: item.prompt, selection: item.selection })));
  };

  const insertAgentCitation = (citation: AgentCitation) => {
    const el = editorEl();
    if (!el || mode === "viewing") return;
    insertText(el, ` ${citation.inline}`);
    afterEdit();
    speak(`Inserted citation for ${citation.title}.`);
  };

  const contextLimit = activeChat?.model.includes("nano") ? 32_000 : 128_000;
  const contextUsed = Math.ceil(
    (metrics.charCount + askPrompt.length + attachments.reduce((sum, item) => sum + item.text.length, 0) + 2_000) / 4,
  );

  const submitAsk = async () => {
    const prompt = askPrompt;
    const context = agentContext;
    if (!prompt.trim()) return;
    setAskPrompt("");
    if (activeChatId) {
      setChatDrafts((drafts) => {
        const next = { ...drafts };
        delete next[activeChatId];
        return next;
      });
    }
    setAgentContext([]);
    const ok = await runJob({
      prompt,
      context,
      openPanel: true,
      clearPrompt: false,
    });
    if (!ok) return;
  };

  const openInlineEdit = () => {
    if (mode === "viewing" || focusMode) return;
    restoreSelection(true);
    const el = editorEl();
    const context = el ? captureAgentSelection(el) : null;
    if (!context) {
      openLinkDialog();
      return;
    }
    inlineContextRef.current = context;
    const selection = window.getSelection();
    const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    setInlineBox(rect ? { top: rect.bottom, left: rect.left, width: rect.width } : { top: 120, left: 24, width: 320 });
    setInlinePrompt("");
    setInlineOpen(true);
  };

  const refreshLint = () => {
    const el = editorEl();
    const text = el ? getPlainText(el) : "";
    return {
      lint: lintWriting(text, metrics.pageCount),
      tropes: detectAiTropes(text),
    };
  };

  const addressComments = (target: DocComment[]) => {
    if (!target.length) return;
    void runJob({
      prompt: "Address these comments in the document. Make a targeted edit for each quote. Do not invent new claims.",
      comments: target,
      mode: "agent",
      openPanel: true,
    });
  };

  const applyTemplate = (id: string) => {
    const template = templateById(id);
    if (!template) return;
    const el = editorEl();
    if (el) {
      const selection = window.getSelection();
      const node = selection?.anchorNode;
      const block = (node instanceof Element ? node : node?.parentElement)?.closest("div, p, h1, h2, h3, li");
      if (block && (block.textContent || "").trim().startsWith("/")) {
        block.textContent = "";
      }
      const empty = !getPlainText(el).trim();
      if (template.skeleton && empty) {
        insertHtml(el, template.skeleton);
        afterEdit();
      }
    }
    setAskPrompt(template.prompt);
    setAgentOpen(true);
    setAgentMinimized(false);
    setSlash(null);
  };

  const revertTurn = (turnId: string) => {
    const chat = activeChat;
    const turn = chat?.turns.find((item) => item.id === turnId);
    if (!chat || !turn?.snapshotId) return;
    if (!restoreSnapshot(turn.snapshotId, { announce: "Reverted to before that message." })) {
      speak("That version is no longer available.");
      return;
    }
    pendingRevertRef.current = null;
    setChats((list) => removeTurnsFrom(list, chat.id, turnId));
    setAskPrompt(turn.prompt);
    setAskError(null);
    if (turn.selection) {
      setAgentContext([]);
    }
  };

  const addAttachments = (files: FileList | null) => {
    if (!files?.length) return;
    void Promise.all(
      [...files].map(
        (file) =>
          new Promise<AgentAttachment>((resolve) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                id: crypto.randomUUID(),
                name: file.name,
                text: String(reader.result ?? ""),
              });
            reader.readAsText(file);
          }),
      ),
    ).then((next) => setAttachments((list) => [...list, ...next]));
  };

  const reviewEdit = (id: string, action: "accept" | "reject") => {
    const el = editorEl();
    if (!el) return;
    if (action === "accept") acceptAgentEdit(el, id);
    else rejectAgentEdit(el, id);
    settleAgentEdits(el);
    setChats((list) => setEditStatus(list, id, action === "accept" ? "accepted" : "rejected"));
    afterEdit();
    speak(action === "accept" ? "Edit accepted." : "Edit rejected.");
  };

  const reviewAll = (action: "accept" | "reject") => {
    const el = editorEl();
    if (!el) return;
    const ids = reviewIds;
    for (const id of ids) {
      if (action === "accept") acceptAgentEdit(el, id);
      else rejectAgentEdit(el, id);
    }
    settleAgentEdits(el);
    setChats((list) =>
      ids.reduce((next, id) => setEditStatus(next, id, action === "accept" ? "accepted" : "rejected"), list),
    );
    afterEdit();
  };

  const handleAction = async (action: string, value?: string) => {
    if (
      action !== "text-color" &&
      action !== "highlight-color" &&
      action !== "ask-inline" &&
      action !== "agent-panel" &&
      action !== "add-to-chat" &&
      action !== "inline-edit" &&
      action !== "palette"
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
        if (!readOnly) openAsk();
        return;
      case "add-to-chat":
        if (!readOnly) addSelectionToChat();
        return;
      case "inline-edit":
        if (!readOnly) openInlineEdit();
        return;
      case "palette":
        setPaletteOpen(true);
        return;
      case "focus-mode":
        setFocusMode((on) => !on);
        return;
      case "preserve-tone":
        setPreserveTone((on) => !on);
        return;
      case "writing-lint":
        setLintOpen((on) => !on);
        return;
      case "history":
        setHistoryOpen((on) => !on);
        return;
      case "fix-grammar":
        if (!readOnly) {
          void runJob({
            prompt: QUICK_PROMPTS.find((item) => item.id === "grammar")!.prompt,
            context: selectionContext(editorEl()),
            mode: "agent",
            silent: true,
            clearPrompt: false,
          });
        }
        return;
      case "clean-ai":
        if (!readOnly && el) {
          const local = cleanAiArtifactsInEditor(el);
          afterEdit();
          void runJob({
            prompt: QUICK_PROMPTS.find((item) => item.id === "tropes")!.prompt,
            context: selectionContext(el),
            mode: "agent",
            silent: true,
            clearPrompt: false,
          });
          if (local) speak(`Removed ${local} hidden token ${local === 1 ? "span" : "spans"}.`);
        }
        return;
      case "suggest-tone":
        void runJob({
          prompt: QUICK_PROMPTS.find((item) => item.id === "tone")!.prompt,
          mode: "ask",
          openPanel: true,
          clearPrompt: false,
        });
        return;
      case "summarize":
        void runJob({
          prompt: QUICK_PROMPTS.find((item) => item.id === "summarize")!.prompt,
          mode: "ask",
          openPanel: true,
          clearPrompt: false,
        });
        return;
      case "address-comments":
        addressComments(comments);
        return;
      case "lock-region":
        if (el && !readOnly) {
          wrapLockedRegion(el, crypto.randomUUID());
          afterEdit();
        }
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
      if (key === "f" && !event.shiftKey) {
        event.preventDefault();
        setDialog("search");
      }
      if (key === "j" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        if (mode !== "viewing") void handleAction("ask-inline");
      }
      if (key === "k" && !event.shiftKey && !event.altKey && !inField) {
        event.preventDefault();
        if (mode !== "viewing" && selectedText().trim()) openInlineEdit();
        else openLinkDialog();
      }
      if (key === "p" && event.shiftKey) {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (key === "g" && event.shiftKey) {
        event.preventDefault();
        void handleAction("fix-grammar");
      }
      if (key === "l" && event.shiftKey) {
        event.preventDefault();
        void handleAction("writing-lint");
      }
      if (key === "h" && event.shiftKey) {
        event.preventDefault();
        void handleAction("history");
      }
      if (key === "f" && event.shiftKey) {
        event.preventDefault();
        void handleAction("focus-mode");
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

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const update = () => {
      for (const id of TOOLBAR_OVERFLOW_GROUPS) {
        const el = toolbar.querySelector(`:scope > [data-toolbar-group="${id}"]`);
        if (el instanceof HTMLElement) toolbarWidths.current[id] = el.offsetWidth;
      }
      const history = toolbar.querySelector(':scope > [data-toolbar-group="history"]');
      const zoomEl = toolbar.querySelector(':scope > [data-toolbar-group="zoom"]');
      const more = toolbar.querySelector(":scope > .toolbar-more");
      const sepEl = toolbar.querySelector(":scope > .toolbar-sep");
      const historyW = history instanceof HTMLElement ? history.offsetWidth : 56;
      const zoomW = zoomEl instanceof HTMLElement ? zoomEl.offsetWidth : 76;
      const moreW = more instanceof HTMLElement ? more.offsetWidth : 28;
      const gap = Number.parseFloat(getComputedStyle(toolbar).gap) || 1;
      let sepW = 9;
      if (sepEl instanceof HTMLElement) {
        const styles = getComputedStyle(sepEl);
        sepW = sepEl.offsetWidth + Number.parseFloat(styles.marginLeft) + Number.parseFloat(styles.marginRight);
      }
      const budget = toolbar.clientWidth;
      let best = 0;
      for (let count = TOOLBAR_OVERFLOW_GROUPS.length; count >= 0; count -= 1) {
        const hasMore = count < TOOLBAR_OVERFLOW_GROUPS.length;
        let content = historyW + zoomW + (hasMore ? moreW : 0);
        for (let i = 0; i < count; i += 1) {
          const id = TOOLBAR_OVERFLOW_GROUPS[i];
          content += toolbarWidths.current[id] ?? TOOLBAR_GROUP_FALLBACK[id];
        }
        const leftParts = 1 + count + (hasMore ? 1 : 0);
        const seps = Math.max(0, leftParts - 1);
        const children = leftParts + seps + 1;
        const used = content + seps * sepW + (children - 1) * gap;
        if (used <= budget - 2) {
          best = count;
          break;
        }
      }
      const next = TOOLBAR_OVERFLOW_GROUPS.slice(best);
      setToolbarOverflow((current) =>
        current.length === next.length && current.every((id, index) => id === next[index]) ? current : [...next],
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(toolbar);
    update();
    return () => observer.disconnect();
  }, [font, fontSize, agentOpen, agentMinimized, focusMode]);

  useEffect(() => {
    if (!toolbarMoreOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("[data-toolbar-more]")) return;
      setToolbarMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setToolbarMoreOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [toolbarMoreOpen]);

  useEffect(() => {
    if (toolbarOverflow.length === 0) setToolbarMoreOpen(false);
  }, [toolbarOverflow.length]);

  useLayoutEffect(() => {
    if (!toolbarMoreOpen) return;
    const pop = toolbarRef.current?.querySelector("[data-toolbar-more-pop]");
    if (!(pop instanceof HTMLElement)) return;
    pop.classList.toggle("is-start", pop.getBoundingClientRect().left < 8);
  }, [toolbarMoreOpen, toolbarOverflow]);

  const renderOverflowGroup = (id: ToolbarOverflowId) => {
    switch (id) {
      case "font":
        return (
          <>
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
          </>
        );
      case "style":
        return (
          <>
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
          </>
        );
      case "insert":
        return (
          <>
            <button className="tool" type="button" title="Insert link" onClick={() => void handleAction("link")}>
              <LinkIcon />
            </button>
            <button className="tool" type="button" title="Insert image" onClick={() => void handleAction("image")}>
              <ImageIcon />
            </button>
          </>
        );
      case "align":
        return (
          <>
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
          </>
        );
      case "lists":
        return (
          <>
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
          </>
        );
      case "ai":
        return (
          <>
            <button
              className="tool ai-tool"
              type="button"
              title="Chat"
              aria-label="Chat"
              data-active={agentOpen}
              disabled={mode === "viewing"}
              onClick={() => void handleAction("ask-inline")}
            >
              <ChatIcon />
            </button>
            <button
              className="tool ai-tool"
              type="button"
              title="Fix grammar"
              disabled={mode === "viewing"}
              onClick={() => void handleAction("fix-grammar")}
            >
              <GrammarIcon />
            </button>
            <button
              className="tool ai-tool"
              type="button"
              title="Writing lint"
              data-active={lintOpen}
              onClick={() => void handleAction("writing-lint")}
            >
              <LintIcon />
            </button>
            <button
              className="tool"
              type="button"
              title="Focus mode"
              data-active={focusMode}
              onClick={() => void handleAction("focus-mode")}
            >
              <FocusIcon />
            </button>
          </>
        );
    }
  };

  const scaledWidth = PAGE_WIDTH * zoom;
  const scaledHeight =
    (metrics.pageCount * PAGE_HEIGHT + Math.max(0, metrics.pageCount - 1) * PAGE_GAP) * zoom;

  return (
    <div
      className={[
        "app",
        agentOpen && !agentMinimized && !focusMode ? "is-chat-open" : "",
        agentOpen && agentMinimized && !focusMode ? "is-chat-min" : "",
        focusMode ? "is-focus" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
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
          <div className="header-meta">Letter - 1&quot; margins</div>
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
          focusMode={focusMode}
          preserveTone={preserveTone}
          onAction={(action, value) => void handleAction(action, value)}
        />
        </div>
      </header>

      <div className="toolbar-wrap">
        <div className="toolbar" ref={toolbarRef} role="toolbar" aria-label="Formatting">
          <span className="toolbar-group" data-toolbar-group="history">
            <button className="tool" type="button" title="Undo" onClick={() => void handleAction("undo")}>
              <UndoIcon />
            </button>
            <button className="tool" type="button" title="Redo" onClick={() => void handleAction("redo")}>
              <RedoIcon />
            </button>
          </span>
          {TOOLBAR_OVERFLOW_GROUPS.map((id) =>
            toolbarOverflow.includes(id) ? null : (
              <Fragment key={id}>
                <span className="toolbar-sep" />
                <span className="toolbar-group" data-toolbar-group={id}>
                  {renderOverflowGroup(id)}
                </span>
              </Fragment>
            ),
          )}
          {toolbarOverflow.length > 0 && (
            <>
              <span className="toolbar-sep" />
              <div className="toolbar-more" data-toolbar-more>
                <button
                  className="tool"
                  type="button"
                  title="More"
                  aria-label="More"
                  aria-expanded={toolbarMoreOpen}
                  data-active={toolbarMoreOpen}
                  onClick={() => setToolbarMoreOpen((value) => !value)}
                >
                  <MoreIcon />
                </button>
                {toolbarMoreOpen && (
                  <div className="toolbar-more-pop" data-toolbar-more-pop aria-label="More formatting tools">
                    {toolbarOverflow.map((id) => (
                      <div key={id} className="toolbar-more-row">
                        {renderOverflowGroup(id)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          <span className="toolbar-group is-zoom" data-toolbar-group="zoom">
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
          </span>
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
              {docReady ? (
                <EditorSurface
                  ref={editorRef}
                  mode={mode}
                  showInvisibles={showInvisibles}
                  substitutions={substitutions}
                  columns={columns}
                  lineSpacing={lineSpacing}
                  initialHtml={initialHtml}
                  onMetricsChange={onMetricsChange}
                  onActiveChange={refreshActive}
                  onContentChange={schedulePersist}
                  onReady={() => setEditorReady(true)}
                  onSlashQuery={(query, rect) => {
                    if (focusMode || mode === "viewing") {
                      setSlash(null);
                      return;
                    }
                    setSlash(query != null && rect ? { query, top: rect.bottom + 6, left: rect.left } : null);
                  }}
                />
              ) : null}
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
        <DiffReviewBar
          getEditor={editorEl}
          pendingIds={reviewIds}
          onAccept={(id) => reviewEdit(id, "accept")}
          onReject={(id) => reviewEdit(id, "reject")}
        />
        {commentsOpen && !focusMode && (
          <CommentsPanel
            comments={comments}
            minimized={commentsMinimized}
            busy={askBusy}
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
            onAddress={addressComments}
          />
        )}
        {historyOpen && !focusMode && (
          <HistoryPanel
            snapshots={history}
            onRestore={restoreSnapshot}
            onSave={() => captureSnapshot(snapshotLabel("manual"))}
            onClose={() => setHistoryOpen(false)}
          />
        )}
        {lintOpen && !focusMode && (
          <LintPanel
            lint={refreshLint().lint}
            tropes={refreshLint().tropes}
            onClose={() => setLintOpen(false)}
            onJump={(find) => {
              const el = editorEl();
              if (el) findNext(el, find);
            }}
            onGrammar={() => void handleAction("fix-grammar")}
            onClean={() => void handleAction("clean-ai")}
            onTone={() => void handleAction("suggest-tone")}
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

      <AgentPanel
        open={agentOpen}
        minimized={agentMinimized}
        busy={askBusy}
        livePhase={livePhase}
        liveThinking={liveThinking}
        livePrompt={livePrompt}
        liveSelection={liveSelection}
        liveMessage={liveMessage}
        liveEdits={liveEdits}
        liveCitations={liveCitations}
        error={askError}
        prompt={askPrompt}
        context={agentContext}
        chats={chats}
        activeChatId={activeChat?.id ?? activeChatId}
        queued={queuedJobs}
        contextUsage={{ used: contextUsed, limit: contextLimit }}
        models={modelCatalog}
        providers={availableProviders}
        onPromptChange={setAskPrompt}
        onSubmit={() => void submitAsk()}
        onStop={stopJob}
        onRevert={revertTurn}
        onClearContext={() => setAgentContext([])}
        onRevealContext={(context) => revealAgentContext(context)}
        onRemoveContext={(index) => setAgentContext((current) => current.filter((_, itemIndex) => itemIndex !== index))}
        onMinimizedChange={setAgentMinimized}
        onClose={() => setAgentOpen(false)}
        onNewChat={() => {
          const chat = createChat({
            mode: activeChat?.mode,
            model: activeChat?.model,
            thinkingLevel: activeChat?.thinkingLevel,
          });
          if (activeChatId) {
            setChatDrafts((drafts) => ({ ...drafts, [activeChatId]: askPrompt }));
          }
          setChats((list) => [chat, ...list]);
          setActiveChatId(chat.id);
          setAskPrompt("");
          setAskError(null);
          setAgentContext([]);
        }}
        onSelectChat={(id) => {
          setChatDrafts((drafts) => {
            const next = activeChatId ? { ...drafts, [activeChatId]: askPrompt } : { ...drafts };
            setAskPrompt(next[id] ?? "");
            return next;
          });
          setActiveChatId(id);
          setAskError(null);
        }}
        onDeleteChat={(id) => {
          setChatDrafts((drafts) => {
            const next = { ...drafts };
            delete next[id];
            return next;
          });
          setChats((list) => {
            const next = list.filter((chat) => chat.id !== id);
            if (!next.length) {
              const chat = createChat({
                mode: activeChat?.mode,
                model: activeChat?.model,
                thinkingLevel: activeChat?.thinkingLevel,
              });
              setActiveChatId(chat.id);
              setAskPrompt("");
              return [chat];
            }
            if (id === activeChatId) {
              setActiveChatId(next[0].id);
              setAskPrompt(chatDrafts[next[0].id] ?? "");
            }
            return next;
          });
        }}
        onModeChange={(nextMode: AgentMode) => {
          if (activeChat) setChats((list) => patchChat(list, activeChat.id, { mode: nextMode }));
        }}
        onModelChange={(nextModel) => {
          if (activeChat) setChats((list) => patchChat(list, activeChat.id, { model: nextModel }));
        }}
        onThinkingChange={(level: ThinkingLevel) => {
          if (activeChat) setChats((list) => patchChat(list, activeChat.id, { thinkingLevel: level }));
        }}
        onJump={(id) => {
          const el = editorEl();
          if (el) jumpToAgentEdit(el, id);
        }}
        onAccept={(id) => reviewEdit(id, "accept")}
        onReject={(id) => reviewEdit(id, "reject")}
        onAcceptAll={() => reviewAll("accept")}
        onRejectAll={() => reviewAll("reject")}
        attachments={attachments}
        preserveTone={preserveTone}
        liveTools={liveTools}
        onCancelQueued={cancelQueuedJob}
        onInsertCitation={insertAgentCitation}
        onPreserveToneChange={setPreserveTone}
        onAttach={addAttachments}
        onRemoveAttachment={(id) => setAttachments((list) => list.filter((file) => file.id !== id))}
        onTemplate={(prompt) => {
          setAskPrompt(prompt);
          setAgentOpen(true);
          setAgentMinimized(false);
        }}
        onToggleTask={(id) => {
          if (!activeChat) return;
          setChats((list) =>
            patchChat(
              list,
              activeChat.id,
              {
                tasks: (activeChat.tasks ?? []).map((task) =>
                  task.id === id
                    ? { ...task, status: task.status === "done" ? "pending" : "done" }
                    : task,
                ),
              },
            ),
          );
        }}
      />

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

      {inlineOpen && inlineBox && (
        <InlineComposer
          box={inlineBox}
          prompt={inlinePrompt}
          busy={askBusy}
          preserveTone={preserveTone}
          onPromptChange={setInlinePrompt}
          onPreserveToneChange={setPreserveTone}
          onSubmit={() =>
            void runJob({
              prompt: inlinePrompt,
              context: inlineContextRef.current ? [inlineContextRef.current] : [],
              mode: "agent",
              silent: true,
              clearPrompt: false,
            })
          }
          onOpenChat={() => {
            setAskPrompt(inlinePrompt);
            if (inlineContextRef.current) {
              setAgentContext((current) =>
                current.some((item) => sameAgentSelection(item, inlineContextRef.current!))
                  ? current
                  : [...current, inlineContextRef.current!],
              );
            }
            setInlineOpen(false);
            openAsk();
          }}
          onClose={() => setInlineOpen(false)}
        />
      )}
      {slash && !focusMode && (
        <SlashMenu
          query={slash.query}
          box={{ top: slash.top, left: slash.left }}
          onPick={applyTemplate}
          onClose={() => setSlash(null)}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          commands={PALETTE_COMMANDS}
          onPick={(id) => {
            setPaletteOpen(false);
            if (id.startsWith("template:")) {
              applyTemplate(id.slice(9));
              return;
            }
            void handleAction(id);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {toast && (
        <AgentToast
          text={toast.text}
          actionLabel="Open chat"
          onAction={toast.action}
          onDismiss={() => setToast(null)}
        />
      )}
      {focusMode && (
        <button type="button" className="focus-exit" onClick={() => setFocusMode(false)}>
          Exit focus <kbd>⌘⇧F</kbd>
        </button>
      )}

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
            ...(focusMode
              ? []
              : [
                  { label: "Inline edit", action: "inline-edit", shortcut: "⌘K", disabled: !contextMenu.hasSelection },
                  { label: "Add text to AI chat", action: "add-to-chat", disabled: !contextMenu.hasSelection },
                  { label: "Lock from AI", action: "lock-region", disabled: !contextMenu.hasSelection },
                ]),
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

const PALETTE_COMMANDS: PaletteCommand[] = [
  { id: "ask-inline", label: "Open chat", group: "Agent", shortcut: "⌘J" },
  { id: "inline-edit", label: "Inline edit", group: "Agent", shortcut: "⌘K", hint: "Edit the selection without opening chat" },
  { id: "fix-grammar", label: "Fix grammar", group: "Agent", shortcut: "⌘⇧G" },
  { id: "clean-ai", label: "Clean AI writing", group: "Agent", hint: "Tropes, em dashes, watermarks" },
  { id: "writing-lint", label: "Writing lint", group: "Agent", shortcut: "⌘⇧L" },
  { id: "suggest-tone", label: "Suggest tone", group: "Agent" },
  { id: "summarize", label: "Summarize and ideate", group: "Agent" },
  { id: "address-comments", label: "Address all comments", group: "Agent" },
  { id: "history", label: "Version history", group: "Document", shortcut: "⌘⇧H" },
  { id: "focus-mode", label: "Focus mode", group: "Document", shortcut: "⌘⇧F" },
  { id: "preserve-tone", label: "Toggle preserve tone", group: "Agent" },
  { id: "citation", label: "Insert citation", group: "Document" },
  ...PROMPT_TEMPLATES.map((item) => ({
    id: `template:${item.id}`,
    label: item.label,
    hint: item.hint,
    group: "Templates",
  })),
];

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && (error.name === "AbortError" || /aborted|AbortError/i.test(error.message)))
  );
}

function GrammarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 18 10.2 6h1.7L17 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M7.2 13.4h8.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function LintIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 6h14M5 12h9M5 18h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="18.2" cy="12" r="2.1" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function FocusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3.1" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 4.5v2.4M12 17.1v2.4M4.5 12h2.4M17.1 12h2.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6.2 5.5h11.6A2.7 2.7 0 0 1 20.5 8.2v6.2a2.7 2.7 0 0 1-2.7 2.7H11l-3.8 2.8v-2.8H6.2A2.7 2.7 0 0 1 3.5 14.4V8.2A2.7 2.7 0 0 1 6.2 5.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M8 9.6h8M8 12.6h5.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
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
