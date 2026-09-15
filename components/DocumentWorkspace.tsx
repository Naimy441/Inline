"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type MutableRefObject, type Ref } from "react";
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
  BLOCK_STYLES,
  DOCUMENT_FONTS,
  FontFamilyPicker,
  FontSizePicker,
  LineSpacingPicker,
  ToolbarSelect,
  ZOOM_OPTIONS,
  type ZoomValue,
} from "@/components/FontControls";
import { ContextMenu } from "@/components/ContextMenu";
import { FindBar } from "@/components/FindBar";
import {
  CitationDialog,
  CompareDialog,
  EmojiDialog,
  LinkDialog,
  PageSetupDialog,
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
  applyParagraphIndent,
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
import { applyClientTools, type ClientToolIO } from "@/lib/agent/clientTools";
import { estimateContextUsage } from "@/lib/agent/context";
import { documentFingerprint } from "@/lib/agent/continuation";
import { acceptMissingEdits, createChat, loadChats, patchChat, pendingEditIds, removeTurnsFrom, saveChats, setEditStatus, titleFromPrompt } from "@/lib/agent/chats";
import { InlineMark } from "@/components/InlineMark";
import { duplicateDocument, loadDocument, saveDocument, trashDocument, type HeaderAlign, type PageNumberLocation } from "@/lib/documentStore";
import { downloadDocument } from "@/lib/documentExport";
import { acceptAgentEdit, appendAgentEdits, applyAgentEdits, applySilentEdits, captureAgentSelection, clearGrammarFlash, documentEditIds, jumpToAgentEdit, rejectAgentEdit, sameAgentSelection, selectionFromOffsets, settleAgentEdits } from "@/lib/agent/edits";
import { AGENT_MODELS, DEFAULT_MODEL } from "@/lib/agent/models";
import { collectDocumentPages } from "@/lib/agent/pages";
import { isAbortError, isRateLimitError, isRateLimitText, isRetryableError, publicModelError, retryAfterMsFromError, retryDelayMs, sleep } from "@/lib/agent/retry";
import { runAgentJob } from "@/lib/agent/runJob";
import { pushThinking, sealOpenThinking, upsertStep } from "@/lib/agent/timeline";
import type { AgentAttachment, AgentChat, AgentCitation, AgentEditDraft, AgentLiveTurn, AgentMode, AgentQueueItem, AgentSelection, AgentStep, AgentTask, AgentTimelineItem, PendingEdit, ThinkingLevel } from "@/lib/agent/types";
import { loadHistory, pushSnapshot, saveHistory, snapshotLabel, type HistorySnapshot } from "@/lib/historyStore";
import { createUndoStack } from "@/lib/editorUndo";
import { ignoreSpellingRange, spellingTargetAtPoint } from "@/lib/editorSpell";
import { listLockedRanges, wrapLockedRegion } from "@/lib/locks";
import { lintWriting } from "@/lib/writing/lint";
import { PROMPT_TEMPLATES, QUICK_PROMPTS, templateById } from "@/lib/writing/templates";
import { cleanAiArtifactsInEditor, detectAiTropes } from "@/lib/writing/tropes";
import { IS_DEV } from "@/lib/debug/isDev";
import { copyText, formatInlineDebugSnapshot } from "@/lib/debug/snapshot";
import { useInlineTheme } from "@/lib/theme";
import {
  countWords,
  cssInches,
  DEFAULT_PAGE_LAYOUT,
  DPI,
  getPlainText,
  isEditorVisuallyEmpty,
  PAGE_GAP,
  restoreSelectionRange,
  saveSelectionRange,
  type PageLayout,
  type TextRange,
} from "@/lib/pagination";

type DialogName =
  | "word-count"
  | "link"
  | "table"
  | "emoji"
  | "special"
  | "compare"
  | "citation"
  | "signature"
  | "page-setup"
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

function emptyLive(phase: AgentLiveTurn["phase"] = "thinking"): AgentLiveTurn {
  return {
    phase,
    thinking: "",
    prompt: "",
    selection: null,
    message: "",
    edits: [],
    citations: [],
    tools: [],
    steps: [],
    timeline: [],
  };
}

function queuedSnapshot(items: Array<AgentJobOptions & { queueId: string; selection?: string | null }>): AgentQueueItem[] {
  return items.map((item) => ({
    id: item.queueId,
    prompt: item.prompt,
    selection: item.selection,
    chatId: item.chatId,
  }));
}

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

const TOOLBAR_OVERFLOW_GROUPS = ["style", "font", "insert", "align", "lists"] as const;
type ToolbarOverflowId = (typeof TOOLBAR_OVERFLOW_GROUPS)[number];

const TOOLBAR_GROUP_FALLBACK: Record<ToolbarOverflowId, number> = {
  font: 176,
  style: 276,
  insert: 58,
  align: 172,
  lists: 144,
};

const CHROME_FROM_PX = 0.5 * DPI;
const CHROME_LINE_PX = 20;
const CHROME_BAR_PX = 36;

type DocumentWorkspaceProps = {
  documentId?: string;
  onGoHome?: () => void;
};

type DocUndoState = {
  html: string;
  title: string;
  chats: AgentChat[];
  activeChatId: string;
  headerText: string;
  footerText: string;
  firstHeaderText: string;
  firstFooterText: string;
  showHeader: boolean;
  showFooter: boolean;
  showPageNumbers: boolean;
  differentFirstPage: boolean;
  pageNumberLocation: PageNumberLocation;
  headerAlign: HeaderAlign;
  footerAlign: HeaderAlign;
  fontFamily: string;
  fontSize: string;
  columns: number;
  lineSpacing: string;
  pageLayout: PageLayout;
  comments: DocComment[];
};

export function DocumentWorkspace({ documentId, onGoHome }: DocumentWorkspaceProps = {}) {
  const workspaceId = documentId || "doc-legacy";
  const editorRef = useRef<EditorHandle>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const savedSelectionRef = useRef<TextRange | null>(null);
  const expandedSelectionRef = useRef<TextRange | null>(null);
  const liveSelectionRef = useRef<{
    startNode: Node;
    startOffset: number;
    endNode: Node;
    endOffset: number;
    collapsed: boolean;
  } | null>(null);
  const liveExpandedRef = useRef<{
    startNode: Node;
    startOffset: number;
    endNode: Node;
    endOffset: number;
  } | null>(null);
  const selectionOffsetTimer = useRef(0);
  const [linkText, setLinkText] = useState("");
  const [title, setTitle] = useState("Untitled document");
  const [metrics, setMetrics] = useState<EditorMetrics>({
    pageCount: 1,
    wordCount: 0,
    charCount: 0,
  });
  const canvasRef = useRef<HTMLElement>(null);
  const [zoomMode, setZoomMode] = useState<"fit" | number>(1);
  const [fitZoom, setFitZoom] = useState(1);
  const [font, setFont] = useState("Arial");
  const [fontSize, setFontSize] = useState("11pt");
  const [active, setActive] = useState({
    blockStyle: "normal" as "normal" | "title" | "subtitle" | "h1" | "h2" | "h3",
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
  const [pageLayout, setPageLayout] = useState<PageLayout>(DEFAULT_PAGE_LAYOUT);
  const [showHeader, setShowHeader] = useState(false);
  const [showFooter, setShowFooter] = useState(false);
  const [showPageNumbers, setShowPageNumbers] = useState(false);
  const [pageNumberLocation, setPageNumberLocation] = useState<PageNumberLocation>("footer");
  const [headerAlign, setHeaderAlign] = useState<HeaderAlign>("center");
  const [footerAlign, setFooterAlign] = useState<HeaderAlign>("center");
  const [docFont, setDocFont] = useState("Arial, Helvetica, sans-serif");
  const [docFontSize, setDocFontSize] = useState("11pt");
  const [headerText, setHeaderText] = useState("");
  const [footerText, setFooterText] = useState("");
  const [firstHeaderText, setFirstHeaderText] = useState("");
  const [firstFooterText, setFirstFooterText] = useState("");
  const [differentFirstPage, setDifferentFirstPage] = useState(false);
  const [chromeFocus, setChromeFocus] = useState<null | "header" | "footer">(null);
  const [chromePage, setChromePage] = useState(0);
  const headerFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const footerFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const headerMeasureRef = useRef<HTMLDivElement | null>(null);
  const firstHeaderMeasureRef = useRef<HTMLDivElement | null>(null);
  const footerMeasureRef = useRef<HTMLDivElement | null>(null);
  const firstFooterMeasureRef = useRef<HTMLDivElement | null>(null);
  const headerStackRef = useRef<HTMLDivElement | null>(null);
  const footerStackRef = useRef<HTMLDivElement | null>(null);
  const [chromeSize, setChromeSize] = useState({ header: 0, firstHeader: 0, footer: 0, firstFooter: 0 });
  const [liveStackH, setLiveStackH] = useState(0);
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
  const [askError, setAskError] = useState<string | null>(null);
  const [lives, setLives] = useState<Record<string, AgentLiveTurn>>({});
  const [queuedJobs, setQueuedJobs] = useState<AgentQueueItem[]>([]);
  const [agentContext, setAgentContext] = useState<AgentSelection[]>([]);
  const [chats, setChats] = useState<AgentChat[]>([]);
  const [activeChatId, setActiveChatId] = useState("");
  const [openChatIds, setOpenChatIds] = useState<string[]>([]);
  const [chatsReady, setChatsReady] = useState(false);
  const [modelCatalog, setModelCatalog] = useState(AGENT_MODELS);
  const [availableProviders, setAvailableProviders] = useState({ openai: true, anthropic: false });
  const [dialog, setDialog] = useState<DialogName>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
    spelling?: { word: string; ignored: boolean };
  } | null>(null);
  const { darkMode, toggleTheme } = useInlineTheme();
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
  const toastTimer = useRef(0);
  const chatPersistTimer = useRef(0);
  const jobAbortsRef = useRef<Record<string, AbortController>>({});
  const runningRef = useRef(new Set<string>());
  const applyingAgentRef = useRef(false);
  const mutateChainRef = useRef(Promise.resolve());
  const agentReflowTimer = useRef(0);
  const grammarBusyRef = useRef(false);
  const grammarDoneTimer = useRef(0);
  const grammarFlashTimer = useRef(0);
  const [grammarPhase, setGrammarPhase] = useState<"idle" | "running" | "done">("idle");
  const [grammarNote, setGrammarNote] = useState("");
  const jobQueueRef = useRef<Array<AgentJobOptions & { queueId: string; selection?: string | null }>>([]);
  const pendingRevertRef = useRef<string | null>(null);
  const nativeDirtyRef = useRef(false);
  const docUndoRef = useRef(createUndoStack<DocUndoState>());
  const undoDocRef = useRef<() => void>(() => {});
  const redoDocRef = useRef<() => void>(() => {});
  const inlineContextRef = useRef<AgentSelection | null>(null);
  const spellRangeRef = useRef<Range | null>(null);
  const suppressContextSyncRef = useRef(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarWidths = useRef<Partial<Record<ToolbarOverflowId, number>>>({});
  const [toolbarOverflow, setToolbarOverflow] = useState<ToolbarOverflowId[]>([]);
  const [toolbarMoreOpen, setToolbarMoreOpen] = useState(false);

  useEffect(() => {
    if (!docReady) return;
    const next = `${title.trim() || "Untitled document"} - Inline`;
    const apply = () => {
      if (document.title !== next) document.title = next;
      const tag = document.querySelector("title");
      if (tag && tag.textContent !== next) tag.textContent = next;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    const stop = window.setTimeout(() => observer.disconnect(), 2500);
    return () => {
      observer.disconnect();
      window.clearTimeout(stop);
    };
  }, [docReady, title]);

  useEffect(() => {
    if (agentOpen && !agentMinimized && !focusMode) {
      document.documentElement.dataset.chat = "open";
    } else if (agentOpen && agentMinimized && !focusMode) {
      document.documentElement.dataset.chat = "min";
    } else {
      delete document.documentElement.dataset.chat;
    }
  }, [agentOpen, agentMinimized, focusMode]);

  useLayoutEffect(() => {
    const storedDoc = loadDocument(workspaceId);
    if (storedDoc) {
      setTitle(storedDoc.title);
      setInitialHtml(storedDoc.html);
      setHeaderText(storedDoc.headerText);
      setFooterText(storedDoc.footerText);
      setFirstHeaderText(storedDoc.firstHeaderText);
      setFirstFooterText(storedDoc.firstFooterText);
      setShowHeader(storedDoc.showHeader);
      setShowFooter(storedDoc.showFooter);
      setShowPageNumbers(storedDoc.showPageNumbers);
      setDifferentFirstPage(storedDoc.differentFirstPage);
      setPageNumberLocation(storedDoc.pageNumberLocation);
      setHeaderAlign(storedDoc.headerAlign);
      setFooterAlign(storedDoc.footerAlign);
      setDocFont(storedDoc.fontFamily);
      setDocFontSize(storedDoc.fontSize);
      setFont(storedDoc.fontFamily.split(",")[0]?.replace(/["']/g, "") || "Arial");
      setFontSize(storedDoc.fontSize);
      setColumnCount(storedDoc.columns);
      setSpacing(storedDoc.lineSpacing);
      setPageLayout(storedDoc.pageLayout ?? DEFAULT_PAGE_LAYOUT);
      setComments(storedDoc.comments);
    }
    setDocReady(true);
  }, [workspaceId]);

  useLayoutEffect(() => {
    const stored = loadChats(workspaceId);
    if (stored) {
      setChats(stored.chats);
      setActiveChatId(stored.activeId);
      setAgentOpen(stored.open);
      setAgentMinimized(stored.minimized);
      setChatDrafts(stored.drafts);
      setAskPrompt(stored.drafts[stored.activeId] ?? "");
      setOpenChatIds(stored.openIds);
    } else {
      const chat = createChat();
      setChats([chat]);
      setActiveChatId(chat.id);
      setOpenChatIds([chat.id]);
      setAgentOpen(false);
      setAgentMinimized(false);
      setChatDrafts({});
      setAskPrompt("");
    }
    setChatsReady(true);
    const storedHistory = loadHistory();
    historyRef.current = storedHistory;
    setHistory(storedHistory);
    const storedFocus = window.localStorage.getItem("inline-focus");
    const storedTone = window.localStorage.getItem("inline-preserve-tone");
    if (storedFocus === "1") setFocusMode(true);
    if (storedTone === "0") setPreserveTone(false);
  }, [workspaceId]);

  useEffect(() => {
    if (!chatsReady || !chats.length || !activeChatId) return;
    window.clearTimeout(chatPersistTimer.current);
    chatPersistTimer.current = window.setTimeout(() => {
      saveChats(workspaceId, {
        chats,
        activeId: activeChatId,
        open: agentOpen,
        minimized: agentMinimized,
        drafts: { ...chatDrafts, [activeChatId]: askPrompt },
        openIds: openChatIds,
      });
      chatPersistTimer.current = 0;
    }, 180);
    return () => window.clearTimeout(chatPersistTimer.current);
  }, [activeChatId, agentMinimized, agentOpen, askPrompt, chatDrafts, chats, chatsReady, openChatIds, workspaceId]);

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
        firstHeaderText,
        firstFooterText,
        showHeader,
        showFooter,
        showPageNumbers,
        differentFirstPage,
        pageNumberLocation,
        headerAlign,
        footerAlign,
        fontFamily: docFont,
        fontSize: docFontSize,
        columns,
        lineSpacing,
        pageLayout,
        comments,
      }, workspaceId);
    },
    [
      comments,
      columns,
      docReady,
      editorReady,
      docFont,
      docFontSize,
      differentFirstPage,
      firstFooterText,
      firstHeaderText,
      footerAlign,
      footerText,
      headerAlign,
      headerText,
      initialHtml,
      lineSpacing,
      pageLayout,
      pageNumberLocation,
      showFooter,
      showHeader,
      showPageNumbers,
      title,
      workspaceId,
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
    docFont,
    docFontSize,
    differentFirstPage,
    firstFooterText,
    firstHeaderText,
    footerAlign,
    footerText,
    headerAlign,
    headerText,
    lineSpacing,
    pageNumberLocation,
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

  useEffect(
    () => () => {
      window.clearTimeout(persistTimer.current);
      window.clearTimeout(grammarDoneTimer.current);
      window.clearTimeout(grammarFlashTimer.current);
    },
    [],
  );

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
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selection.anchorNode || !el.contains(selection.anchorNode)) return;
      const range = selection.getRangeAt(0);
      if (range.collapsed && document.activeElement !== el && liveSelectionRef.current) return;
      const live = {
        startNode: range.startContainer,
        startOffset: range.startOffset,
        endNode: range.endContainer,
        endOffset: range.endOffset,
        collapsed: range.collapsed,
      };
      liveSelectionRef.current = live;
      window.clearTimeout(selectionOffsetTimer.current);
      if (!range.collapsed) {
        liveExpandedRef.current = live;
        selectionOffsetTimer.current = window.setTimeout(() => {
          const next = editorRef.current?.getElement();
          if (!next) return;
          const stored = saveSelectionRange(next);
          if (!stored) return;
          savedSelectionRef.current = stored;
          expandedSelectionRef.current = stored;
        }, 120);
        return;
      }
      if (document.activeElement === el) {
        liveExpandedRef.current = null;
        expandedSelectionRef.current = null;
      }
    };
    document.addEventListener("selectionchange", saveSelection);
    return () => {
      document.removeEventListener("selectionchange", saveSelection);
      window.clearTimeout(selectionOffsetTimer.current);
    };
  }, []);

  const restoreSelection = (preferExpanded = false) => {
    const el = editorRef.current?.getElement();
    if (!el) return;
    el.focus({ preventScroll: true });
    const liveCollapsed = Boolean(liveSelectionRef.current?.collapsed);
    const live =
      preferExpanded && liveCollapsed && liveExpandedRef.current
        ? liveExpandedRef.current
        : liveSelectionRef.current;
    if (live && live.startNode.isConnected && live.endNode.isConnected) {
      try {
        const next = document.createRange();
        next.setStart(live.startNode, live.startOffset);
        next.setEnd(live.endNode, live.endOffset);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(next);
        return;
      } catch {
        /* Fall back to text offsets if the live nodes were split. */
      }
    }
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
      const next = Math.min(1, (canvas.clientWidth - 80) / pageLayout.width);
      setFitZoom(Number.isFinite(next) && next > 0.2 ? next : 1);
    };
    updateFit();
    const observer = new ResizeObserver(updateFit);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [pageLayout.width]);

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
    const editor = editorRef.current?.getElement();
    if (editor && document.activeElement === editor) setChromeFocus(null);
    const next = editorRef.current?.queryActive();
    if (!next) return;
    setActive((prev) =>
      prev.blockStyle === next.blockStyle &&
      prev.bold === next.bold &&
      prev.italic === next.italic &&
      prev.underline === next.underline &&
      prev.align === next.align &&
      prev.list === next.list
        ? prev
        : {
            blockStyle: next.blockStyle,
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

  const withAgentMutation = <T,>(fn: () => T) => {
    const run = async () => {
      applyingAgentRef.current = true;
      try {
        return fn();
      } finally {
        window.setTimeout(() => {
          applyingAgentRef.current = false;
        }, 0);
      }
    };
    const next = mutateChainRef.current.then(run, run);
    mutateChainRef.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  useEffect(() => {
    const el = editorEl();
    if (!el) return;
    const onBeforeInput = () => {
      if (applyingAgentRef.current) return;
      nativeDirtyRef.current = true;
      if (!runningRef.current.size) return;
      for (const controller of Object.values(jobAbortsRef.current)) controller.abort();
    };
    el.addEventListener("beforeinput", onBeforeInput);
    return () => el.removeEventListener("beforeinput", onBeforeInput);
  }, [editorEl, editorReady]);

  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? chats[0];
  const reviewIds = pendingEditIds(chats);
  const activeLive = lives[activeChat?.id ?? activeChatId];
  const anyBusy = Object.keys(lives).length > 0;

  const patchLive = (
    id: string,
    patch: Partial<AgentLiveTurn> | ((prev: AgentLiveTurn) => Partial<AgentLiveTurn>),
  ) => {
    setLives((current) => {
      const prev = current[id] ?? emptyLive();
      const nextPatch = typeof patch === "function" ? patch(prev) : patch;
      return { ...current, [id]: { ...prev, ...nextPatch } };
    });
  };

  const clearLive = (id: string) => {
    setLives((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

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
    const id = activeChat?.id;
    if (id) jobAbortsRef.current[id]?.abort();
  };

  const captureSnapshot = (label: string) => {
    const el = editorEl();
    const result = pushSnapshot(historyRef.current, {
      label,
      title,
      html: el ? el.innerHTML : initialHtml,
      headerText,
      footerText,
      firstHeaderText,
      firstFooterText,
      showHeader,
      showFooter,
      showPageNumbers,
      differentFirstPage,
      pageNumberLocation,
      headerAlign,
      footerAlign,
      fontFamily: docFont,
      fontSize: docFontSize,
      columns,
      lineSpacing,
      pageLayout,
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
    setFirstHeaderText(snap.firstHeaderText ?? "");
    setFirstFooterText(snap.firstFooterText ?? "");
    setShowHeader(snap.showHeader);
    setShowFooter(snap.showFooter);
    setShowPageNumbers(snap.showPageNumbers);
    setDifferentFirstPage(Boolean(snap.differentFirstPage));
    setPageNumberLocation(snap.pageNumberLocation ?? "footer");
    setHeaderAlign(snap.headerAlign ?? "center");
    setFooterAlign(snap.footerAlign ?? "center");
    setDocFont(snap.fontFamily ?? "Arial, Helvetica, sans-serif");
    setDocFontSize(snap.fontSize ?? "11pt");
    setFont((snap.fontFamily ?? "Arial").split(",")[0]?.replace(/["']/g, "") || "Arial");
    setFontSize(snap.fontSize ?? "11pt");
    setColumnCount(snap.columns);
    setSpacing(snap.lineSpacing);
    setPageLayout(snap.pageLayout ?? DEFAULT_PAGE_LAYOUT);
    setComments(snap.comments);
    afterEdit();
    if (options?.announce !== "") {
      speak(options?.announce ?? "Restored previous version.");
    }
    return true;
  };

  const captureLiveDoc = (): DocUndoState => ({
    html: editorEl()?.innerHTML ?? initialHtml,
    title,
    chats: structuredClone(chats),
    activeChatId,
    headerText,
    footerText,
    firstHeaderText,
    firstFooterText,
    showHeader,
    showFooter,
    showPageNumbers,
    differentFirstPage,
    pageNumberLocation,
    headerAlign,
    footerAlign,
    fontFamily: docFont,
    fontSize: docFontSize,
    columns,
    lineSpacing,
    pageLayout,
    comments,
  });

  const restoreLiveDoc = (snap: DocUndoState) => {
    editorRef.current?.setHtml(snap.html);
    setTitle(snap.title);
    setChats(snap.chats);
    setActiveChatId(snap.activeChatId);
    setHeaderText(snap.headerText);
    setFooterText(snap.footerText);
    setFirstHeaderText(snap.firstHeaderText);
    setFirstFooterText(snap.firstFooterText);
    setShowHeader(snap.showHeader);
    setShowFooter(snap.showFooter);
    setShowPageNumbers(snap.showPageNumbers);
    setDifferentFirstPage(snap.differentFirstPage);
    setPageNumberLocation(snap.pageNumberLocation);
    setHeaderAlign(snap.headerAlign);
    setFooterAlign(snap.footerAlign);
    setDocFont(snap.fontFamily);
    setDocFontSize(snap.fontSize);
    setFont((snap.fontFamily ?? "Arial").split(",")[0]?.replace(/["']/g, "") || "Arial");
    setFontSize(snap.fontSize);
    setColumnCount(snap.columns);
    setSpacing(snap.lineSpacing);
    setPageLayout(snap.pageLayout);
    setComments(snap.comments);
    afterEdit();
  };

  const pushDocUndo = () => {
    docUndoRef.current.push(captureLiveDoc());
    nativeDirtyRef.current = false;
  };

  const undoDoc = () => {
    if (mode === "viewing") return;
    const el = editorEl();
    if (!el) return;
    if (nativeDirtyRef.current) {
      const before = el.innerHTML;
      runCommand(el, "undo");
      afterEdit();
      if (el.innerHTML !== before) return;
      nativeDirtyRef.current = false;
    }
    const prev = docUndoRef.current.undo(captureLiveDoc());
    if (!prev) {
      runCommand(el, "undo");
      afterEdit();
      return;
    }
    restoreLiveDoc(prev);
  };

  const redoDoc = () => {
    if (mode === "viewing") return;
    const next = docUndoRef.current.redo(captureLiveDoc());
    if (!next) {
      const el = editorEl();
      if (el) runCommand(el, "redo");
      afterEdit();
      return;
    }
    restoreLiveDoc(next);
  };
  undoDocRef.current = undoDoc;
  redoDocRef.current = redoDoc;

  const showToast = (text: string, action?: () => void) => {
    window.clearTimeout(toastTimer.current);
    setToast({ text, action });
    toastTimer.current = window.setTimeout(() => setToast(null), 7000);
  };

  const copyDebugSnapshot = async () => {
    const el = editorEl();
    const text = formatInlineDebugSnapshot({
      capturedAt: new Date().toISOString(),
      url: typeof window === "undefined" ? "" : window.location.href,
      documentId: workspaceId,
      title,
      pages: metrics.pageCount,
      words: metrics.wordCount,
      chars: metrics.charCount,
      chrome: {
        fontFamily: docFont,
        fontSize: docFontSize,
        lineSpacing,
        columns,
        pageLayout,
        header: { show: showHeader, text: headerText, align: headerAlign, firstPageText: firstHeaderText },
        footer: { show: showFooter, text: footerText, align: footerAlign, firstPageText: firstFooterText },
        pageNumbers: { show: showPageNumbers, location: pageNumberLocation },
        differentFirstPage,
      },
      comments: comments.map((comment) => ({ id: comment.id, quote: comment.quote, body: comment.body })),
      text: el ? getPlainText(el, true) : editorRef.current?.getText() || "",
      html: editorRef.current?.getHtml() || initialHtml,
      chats,
      activeChatId: activeChat?.id || activeChatId,
      composerDraft: askPrompt,
      attachments: attachments.map((item) => ({ name: item.name, chars: item.text.length })),
      live: {
        busy: Boolean(activeLive),
        phase: activeLive?.phase ?? null,
        prompt: activeLive?.prompt ?? "",
        thinking: activeLive?.thinking ?? "",
        message: activeLive?.message ?? "",
        tools: activeLive?.tools ?? [],
        error: askError,
        timeline: activeLive?.timeline,
      },
    });
    try {
      await copyText(text);
      showToast("Copied document and chat snapshot.");
      speak("Copied debug snapshot.");
    } catch {
      showToast("Could not copy the snapshot. Check clipboard permission.");
    }
  };

  const clientToolIo = (): ClientToolIO => ({
    print: () => window.print(),
    setHeader: setHeaderText,
    showHeader: () => setShowHeader(true),
    setFooter: setFooterText,
    showFooter: () => setShowFooter(true),
    showPageNumbers: () => setShowPageNumbers(true),
    setPageNumberLocation,
    setHeaderAlign,
    setDocumentChrome: (patch) => {
      if (patch.fontFamily) setDocFont(patch.fontFamily);
      if (patch.fontSize) setDocFontSize(patch.fontSize);
      if (patch.lineSpacing) setSpacing(patch.lineSpacing);
    },
  });

  const executeJob = async (options: AgentJobOptions) => {
    const el = editorEl();
    const prompt = options.prompt.trim();
    const listed = chats.find((item) => item.id === options.chatId) ?? activeChat;
    const chat = listed ?? createChat({
      mode: options.mode,
      model: activeChat?.model,
      thinkingLevel: activeChat?.thinkingLevel,
    });
    if (!listed) {
      setChats((list) => (list.some((item) => item.id === chat.id) ? list : [chat, ...list]));
      setActiveChatId(chat.id);
      setOpenChatIds((ids) => (ids.includes(chat.id) ? ids : [...ids, chat.id]));
    }
    if (!el || !prompt || mode === "viewing") return false;
    if (pendingRevertRef.current) {
      const revertId = pendingRevertRef.current;
      pendingRevertRef.current = null;
      restoreSnapshot(revertId, { announce: "" });
    }
    const contexts = options.context === undefined ? agentContext : options.context;
    const primaryContext = contexts[contexts.length - 1] ?? null;
    const combinedSelectionText = contexts.map((item) => item.text).join("\n\n");
    const jobMode = options.mode ?? chat.mode;
    const snapshotId = captureSnapshot(snapshotLabel("agent"));
    if (jobMode === "agent") pushDocUndo();
    const controller = new AbortController();
    runningRef.current.add(chat.id);
    jobAbortsRef.current[chat.id] = controller;
    setAskError(null);
    patchLive(chat.id, {
      ...emptyLive((options.mode ?? chat.mode) === "plan" ? "planning" : "thinking"),
      prompt,
      selection: combinedSelectionText || null,
    });
    setOpenChatIds((ids) => (ids.includes(chat.id) ? ids : [...ids, chat.id]));
    if (options.clearPrompt !== false) {
      setAskPrompt("");
      setChatDrafts((drafts) => {
        const next = { ...drafts };
        delete next[chat.id];
        return next;
      });
    }
    const started = Date.now();
    let appliedEdits: PendingEdit[] | null = null;
    const appliedClientIds = new Set<string>();
    let wroteDocument = false;
    let streamedMessage = "";
    let streamedThinking = "";
    let streamedTimeline: AgentTimelineItem[] = [];
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
    let queueDelayMs = 0;
    const persistTurn = (data: {
      message: string;
      thinking?: string;
      edits: PendingEdit[];
      mock?: boolean;
      chatTitle?: string;
      tasks?: AgentTask[];
      tools?: { name: string; hidden?: boolean }[];
      timeline?: AgentTimelineItem[];
      citations?: AgentCitation[];
      continuation?: AgentChat["continuation"];
      error?: string;
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
                continuation: data.error ? item.continuation : data.continuation,
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
                    timeline: data.timeline ? sealOpenThinking(data.timeline) : data.timeline,
                    citations: data.citations,
                    snapshotId,
                    error: data.error,
                  },
                ],
              }
            : item,
        );
      });
    };
    try {
      const clientAttempts = 3;
      let data: Awaited<ReturnType<typeof runAgentJob>> | undefined;
      for (let attempt = 1; attempt <= clientAttempts; attempt += 1) {
        try {
          data = await runAgentJob(
        {
          title,
          prompt,
          document: getPlainText(el, true),
          pages: collectDocumentPages(el),
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
          chatId: chat.id,
          continuation: chat.continuation,
          recentTools: chat.turns.at(-1)?.tools?.map((tool) => tool.name),
        },
        {
          signal: controller.signal,
          onPhase: (phase) => patchLive(chat.id, { phase }),
          onThinking: (text) => {
            streamedThinking = text;
            streamedTimeline = pushThinking(streamedTimeline, text);
            patchLive(chat.id, { thinking: text, timeline: streamedTimeline });
          },
          onMessage: (text) => {
            streamedMessage = text;
            if (streamedTimeline.at(-1)?.kind === "thinking") {
              streamedTimeline = sealOpenThinking(streamedTimeline);
            }
            patchLive(chat.id, { message: text, timeline: streamedTimeline });
          },
          onEdits: async (drafts) => {
            if (jobMode !== "agent") return;
            appliedEdits = await withAgentMutation(() =>
              appendAgentEdits(
                el,
                suppressRepeatedEdits(drafts, priorEditLedger, prompt),
                primaryContext,
                appliedEdits ?? [],
              ),
            );
            wroteDocument = Boolean(appliedEdits?.length);
            patchLive(chat.id, { edits: appliedEdits, phase: "editing" });
            setChats((list) => acceptMissingEdits(list, documentEditIds(el)));
            collapseEditorSelection(el);
            window.clearTimeout(agentReflowTimer.current);
            agentReflowTimer.current = window.setTimeout(() => afterEdit(), 90);
          },
          onTool: (name) => {
            patchLive(chat.id, (prev) => ({
              tools: prev.tools.includes(name) ? prev.tools : [...prev.tools, name],
            }));
          },
          onClientTool: async (call) => {
            appliedClientIds.add(call.id);
            wroteDocument = true;
            await withAgentMutation(() =>
              applyClientTools(el, [call], clientToolIo()),
            );
            window.clearTimeout(agentReflowTimer.current);
            agentReflowTimer.current = window.setTimeout(() => afterEdit(), 90);
          },
          onStep: (step) => {
            streamedTimeline = upsertStep(streamedTimeline, step);
            patchLive(chat.id, (prev) => {
              const index = prev.steps.findIndex((item) => item.id === step.id);
              const steps = index < 0 ? [...prev.steps, step] : prev.steps.map((item, itemIndex) => (itemIndex === index ? step : item));
              return { timeline: streamedTimeline, steps };
            });
          },
          onUsage: (usage) => patchLive(chat.id, { usage }),
          onCitations: (citations) => patchLive(chat.id, { citations }),
        },
      );
          break;
        } catch (error) {
          if (isAbortError(error)) throw error;
          const canRetry =
            isRetryableError(error) &&
            !wroteDocument &&
            attempt < clientAttempts;
          if (!canRetry) throw error;
          const delayMs = retryDelayMs(attempt, retryAfterMsFromError(error), isRateLimitError(error));
          const seconds = Math.max(1, Math.ceil(delayMs / 1000));
          const retryStep: AgentStep = {
            id: `client-retry-${attempt}`,
            name: "retry",
            title: isRateLimitError(error)
              ? `Rate limited — waiting ${seconds}s (try ${attempt + 1}/${clientAttempts})`
              : `Retrying in ${seconds}s (try ${attempt + 1}/${clientAttempts})`,
            status: "active",
          };
          streamedTimeline = upsertStep(streamedTimeline, retryStep);
          patchLive(chat.id, (prev) => {
            const index = prev.steps.findIndex((item) => item.id === retryStep.id);
            const steps = index < 0 ? [...prev.steps, retryStep] : prev.steps.map((item, itemIndex) => (itemIndex === index ? retryStep : item));
            return { timeline: streamedTimeline, steps };
          });
          await sleep(delayMs, controller.signal);
          streamedTimeline = upsertStep(streamedTimeline, {
            ...retryStep,
            title: "Resumed after retry",
            status: "complete",
          });
          patchLive(chat.id, { timeline: streamedTimeline });
        }
      }
      if (!data) throw new Error("The agent could not propose edits.");
      const edits =
        appliedEdits ??
        (jobMode === "agent"
          ? await withAgentMutation(() =>
              applyAgentEdits(el, suppressRepeatedEdits(data.edits ?? [], priorEditLedger, prompt), primaryContext),
            )
          : []);
      collapseEditorSelection(el);
      const pendingClient = (data.tools ?? []).filter((tool) => !appliedClientIds.has(tool.id));
      if (pendingClient.length) {
        await withAgentMutation(() =>
          applyClientTools(el, pendingClient, clientToolIo()),
        );
      }
      persistTurn({
        message: data.message || "Review the proposed edits.",
        thinking: data.thinking,
        edits,
        mock: data.mock,
        chatTitle: data.chatTitle,
        tasks: data.tasks,
        tools: data.tools?.map((tool) => ({ name: tool.name, hidden: tool.hidden })),
        timeline: streamedTimeline,
        citations: data.citations,
        continuation: data.continuation,
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
        persistTurn({
          message: streamedMessage,
          thinking: streamedThinking,
          timeline: streamedTimeline.length ? sealOpenThinking(streamedTimeline) : streamedTimeline,
          edits: appliedEdits ?? [],
          continuation: chat.continuation,
        });
        afterEdit();
        return false;
      }
      const raw = error instanceof Error ? error.message : "The agent could not propose edits.";
      const message = publicModelError(raw);
      persistTurn({
        message: streamedMessage,
        thinking: streamedThinking,
        timeline: streamedTimeline,
        edits: appliedEdits ?? [],
        error: message,
      });
      setAskError(message);
      queueDelayMs = retryAfterMsFromError(raw) ?? (isRateLimitText(raw) ? 8_000 : 0);
      setAskPrompt(prompt);
      setChatDrafts((drafts) => ({ ...drafts, [chat.id]: prompt }));
      if (!options.silent) {
        setAgentOpen(true);
        setAgentMinimized(false);
      } else {
        showToast(message);
      }
      return false;
    } finally {
      if (jobAbortsRef.current[chat.id] === controller) delete jobAbortsRef.current[chat.id];
      runningRef.current.delete(chat.id);
      clearLive(chat.id);
      const nextIndex = jobQueueRef.current.findIndex((item) => item.chatId === chat.id);
      const next = nextIndex >= 0 ? jobQueueRef.current.splice(nextIndex, 1)[0] : undefined;
      setQueuedJobs(queuedSnapshot(jobQueueRef.current));
      if (next) {
        window.setTimeout(() => {
          void executeJob(next);
        }, queueDelayMs);
      }
    }
  };

  const runJob = async (options: AgentJobOptions) => {
    const prompt = options.prompt.trim();
    const el = editorEl();
    if (!el || !prompt || mode === "viewing") return false;
    const context = options.context === undefined ? agentContext : options.context;
    const chatId = options.chatId ?? activeChat?.id;
    if (chatId && runningRef.current.has(chatId)) {
      const queued = {
        ...options,
        prompt,
        context,
        chatId,
        queueId: crypto.randomUUID(),
        selection: context.map((item) => item.text).join("\n\n") || null,
      };
      jobQueueRef.current.push(queued);
      setQueuedJobs(queuedSnapshot(jobQueueRef.current));
      setAskError(null);
      speak("Instruction queued.");
      return true;
    }
    return executeJob({ ...options, prompt, context, chatId });
  };

  const finishGrammar = (note: string) => {
    setGrammarNote(note);
    setGrammarPhase("done");
    window.clearTimeout(grammarDoneTimer.current);
    grammarDoneTimer.current = window.setTimeout(() => {
      setGrammarPhase("idle");
      setGrammarNote("");
    }, 3800);
    window.clearTimeout(grammarFlashTimer.current);
    grammarFlashTimer.current = window.setTimeout(() => {
      const editor = editorEl();
      if (editor) clearGrammarFlash(editor);
    }, 2400);
  };

  const runGrammarFix = async () => {
    if (mode === "viewing") {
      finishGrammar("Can't edit in view mode");
      return;
    }
    const el = editorEl();
    if (!el) {
      finishGrammar("Couldn't check");
      return;
    }
    if (grammarBusyRef.current) return;
    const selected = captureAgentSelection(el);
    const source = (selected?.text || getPlainText(el, true)).replace(/\u00a0/g, " ");
    if (!source.trim()) {
      speak("Nothing to proofread.");
      finishGrammar("Nothing to check");
      return;
    }
    grammarBusyRef.current = true;
    window.clearTimeout(grammarDoneTimer.current);
    window.clearTimeout(grammarFlashTimer.current);
    clearGrammarFlash(el);
    setGrammarPhase("running");
    setGrammarNote("Checking grammar");
    const started = performance.now();
    try {
      const response = await fetch("/api/agent/grammar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: source }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        edits?: Array<{ find: string; replace: string }>;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "Grammar request failed.");
      const edits = Array.isArray(data.edits) ? data.edits.filter((edit) => edit.find && edit.replace !== undefined) : [];
      if (!edits.length) {
        speak("Grammar looks clean.");
        await holdGrammarLoad(started);
        finishGrammar("Looks clean");
        return;
      }
      captureSnapshot(snapshotLabel("agent"));
      pushDocUndo();
      const applied = applySilentEdits(el, edits, selected);
      afterEdit();
      const note = applied ? `Fixed ${applied}` : "No changes applied";
      speak(applied ? `Fixed ${applied} ${applied === 1 ? "issue" : "issues"}.` : "Could not apply grammar fixes.");
      await holdGrammarLoad(started);
      finishGrammar(note);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not fix grammar.";
      speak(message);
      await holdGrammarLoad(started);
      finishGrammar("Couldn't check");
    } finally {
      grammarBusyRef.current = false;
    }
  };

  const cancelQueuedJob = (id: string) => {
    jobQueueRef.current = jobQueueRef.current.filter((item) => item.queueId !== id);
    setQueuedJobs(queuedSnapshot(jobQueueRef.current));
  };

  const insertAgentCitation = (citation: AgentCitation) => {
    const el = editorEl();
    if (!el || mode === "viewing") return;
    insertText(el, ` ${citation.inline}`);
    afterEdit();
    speak(`Inserted citation for ${citation.title}.`);
  };

  const contextUsage = estimateContextUsage({
    model: activeChat?.model,
    prompt: activeLive?.prompt || askPrompt,
    documentChars: metrics.charCount,
    history: (activeChat?.turns ?? []).flatMap((turn) => [
      { role: "user" as const, content: turn.prompt },
      { role: "assistant" as const, content: turn.message },
    ]),
    attachments,
    previousEdits: (activeChat?.turns ?? [])
      .flatMap((turn) => turn.edits)
      .filter((edit) => edit.status === "pending" || edit.status === "accepted")
      .slice(-8),
    continuing: Boolean(activeChat?.continuation),
    sameDraft: Boolean(
      activeChat?.continuation?.documentFingerprint &&
        activeChat.continuation.documentFingerprint === documentFingerprint(editorRef.current?.getText() ?? ""),
    ),
    liveThinking: activeLive?.thinking,
    liveMessage: activeLive?.message,
    usage: activeLive?.usage,
  });

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
    pushDocUndo();
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
    pushDocUndo();
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
      action !== "palette" &&
      action !== "copy-debug-snapshot" &&
      action !== "ignore-spelling"
    ) {
      restoreSelection(true);
    }
    const el = editorEl();
    const readOnly = mode === "viewing";

    switch (action) {
      case "print":
        window.print();
        return;
      case "home":
        onGoHome?.();
        return;
      case "make-copy": {
        const copy = duplicateDocument(workspaceId);
        if (copy) window.location.href = `/?doc=${encodeURIComponent(copy.id)}`;
        return;
      }
      case "trash":
        if (!window.confirm(`Move “${title || "Untitled document"}” to trash?`)) return;
        trashDocument(workspaceId);
        onGoHome?.();
        return;
      case "download-text":
      case "download-markdown":
      case "download-html":
      case "download-docx":
        if (el) {
          const format = action === "download-docx"
            ? "docx"
            : action === "download-html"
              ? "html"
              : action === "download-markdown"
                ? "md"
                : "txt";
          downloadDocument(el, title, format);
          speak(`Downloaded ${format === "docx" ? "Word" : format.toUpperCase()} document.`);
        }
        return;
      case "undo":
        if (readOnly) return;
        undoDoc();
        return;
      case "redo":
        if (readOnly) return;
        redoDoc();
        return;
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
      case "ignore-spelling":
        if (el && !readOnly && spellRangeRef.current) {
          ignoreSpellingRange(el, spellRangeRef.current);
          spellRangeRef.current = null;
          afterEdit();
        }
        return;
      case "indent":
        if (el && !readOnly) indentBlocks(el, 1);
        afterEdit();
        return;
      case "outdent":
        if (el && !readOnly) indentBlocks(el, -1);
        afterEdit();
        return;
      case "indent-first":
        if (el && !readOnly) applyParagraphIndent(el, "first-line");
        afterEdit();
        return;
      case "indent-hanging":
        if (el && !readOnly) applyParagraphIndent(el, "hanging");
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
        setFindReplaceOpen(true);
        setFindOpen(true);
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
        toggleTheme();
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
      case "align": {
        const nextAlign = (value as HeaderAlign) ?? "left";
        if (chromeFocus === "header") {
          setHeaderAlign(nextAlign);
          afterEdit();
          return;
        }
        if (chromeFocus === "footer") {
          setFooterAlign(nextAlign);
          afterEdit();
          return;
        }
        if (el && !readOnly) setAlignment(el, nextAlign);
        afterEdit();
        return;
      }
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
      case "page-setup":
        setDialog("page-setup");
        return;
      case "header":
        setShowHeader((on) => {
          const next = !on;
          if (next) {
            setChromeFocus("header");
            setChromePage(0);
          } else if (chromeFocus === "header") {
            setChromeFocus(null);
          }
          return next;
        });
        return;
      case "footer":
        setShowFooter((on) => {
          const next = !on;
          if (next) {
            setChromeFocus("footer");
            setChromePage(0);
          } else if (chromeFocus === "footer") {
            setChromeFocus(null);
          }
          return next;
        });
        return;
      case "page-numbers":
        setShowPageNumbers((on) => !on);
        return;
      case "page-numbers-header":
        setPageNumberLocation("header");
        setShowPageNumbers(true);
        return;
      case "page-numbers-footer":
        setPageNumberLocation("footer");
        setShowPageNumbers(true);
        return;
      case "different-first-page":
        setDifferentFirstPage((on) => !on);
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
      case "copy-debug-snapshot":
        await copyDebugSnapshot();
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
        setToolbarMoreOpen(false);
        if (!readOnly) void runGrammarFix();
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
      if (key === "z" && !inField) {
        event.preventDefault();
        if (event.shiftKey) redoDocRef.current();
        else undoDocRef.current();
        return;
      }
      if (key === "f" && !event.shiftKey) {
        event.preventDefault();
        setFindReplaceOpen(false);
        setFindOpen(true);
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
    const onClick = (event: globalThis.MouseEvent) => {
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
      if (toolbar.clientWidth < 160) return;
      for (const id of TOOLBAR_OVERFLOW_GROUPS) {
        const el = toolbar.querySelector(`:scope > [data-toolbar-group="${id}"]`);
        if (el instanceof HTMLElement) toolbarWidths.current[id] = el.offsetWidth;
      }
      const history = toolbar.querySelector(':scope > [data-toolbar-group="history"]');
      const more = toolbar.querySelector(":scope > .toolbar-more");
      const sepEl = toolbar.querySelector(":scope > .toolbar-sep");
      const historyW = history instanceof HTMLElement ? history.offsetWidth : 56;
      const moreW = more instanceof HTMLElement ? more.offsetWidth : 28;
      const gap = Number.parseFloat(getComputedStyle(toolbar).gap) || 1;
      let sepW = 9;
      if (sepEl instanceof HTMLElement) {
        const styles = getComputedStyle(sepEl);
        sepW = sepEl.offsetWidth + Number.parseFloat(styles.marginLeft) + Number.parseFloat(styles.marginRight);
      }
      const aiGroup = toolbar.querySelector(':scope > [data-toolbar-group="ai"]');
      const aiW = aiGroup instanceof HTMLElement ? aiGroup.offsetWidth : 58;
      const budget = toolbar.clientWidth - aiW - sepW - gap;
      if (budget < 80) return;
      let best = 0;
      for (let count = TOOLBAR_OVERFLOW_GROUPS.length; count >= 0; count -= 1) {
        const hasMore = count < TOOLBAR_OVERFLOW_GROUPS.length;
        let content = historyW + (hasMore ? moreW : 0);
        for (let i = 0; i < count; i += 1) {
          const id = TOOLBAR_OVERFLOW_GROUPS[i];
          content += toolbarWidths.current[id] ?? TOOLBAR_GROUP_FALLBACK[id];
        }
        const leftParts = 1 + count + (hasMore ? 1 : 0);
        const seps = Math.max(0, leftParts - 1);
        const children = leftParts + seps;
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
    const frame = window.requestAnimationFrame(update);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [font, fontSize, agentOpen, agentMinimized, focusMode]);

  useEffect(() => {
    if (!toolbarMoreOpen) return;
    const onDown = (event: globalThis.MouseEvent) => {
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

  const headerHasNumber = showPageNumbers && pageNumberLocation === "header";
  const footerHasNumber = showPageNumbers && pageNumberLocation === "footer";

  const openChrome = useCallback((kind: "header" | "footer", page: number) => {
    if (kind === "header") setShowHeader(true);
    else setShowFooter(true);
    setChromeFocus(kind);
    setChromePage(page);
  }, []);

  useLayoutEffect(() => {
    const update = () => {
      const next = {
        header: headerText ? headerMeasureRef.current?.offsetHeight ?? 0 : 0,
        firstHeader: firstHeaderText ? firstHeaderMeasureRef.current?.offsetHeight ?? 0 : 0,
        footer: footerText ? footerMeasureRef.current?.offsetHeight ?? 0 : 0,
        firstFooter: firstFooterText ? firstFooterMeasureRef.current?.offsetHeight ?? 0 : 0,
      };
      setChromeSize((prev) =>
        prev.header === next.header &&
        prev.firstHeader === next.firstHeader &&
        prev.footer === next.footer &&
        prev.firstFooter === next.firstFooter
          ? prev
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    for (const node of [headerMeasureRef.current, firstHeaderMeasureRef.current, footerMeasureRef.current, firstFooterMeasureRef.current]) {
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [headerText, firstHeaderText, footerText, firstFooterText, headerHasNumber, footerHasNumber, pageLayout.width, pageLayout.marginLeft, pageLayout.marginRight]);

  useEffect(() => {
    if (chromeFocus === "header") headerFieldRef.current?.focus({ preventScroll: true });
    if (chromeFocus === "footer") footerFieldRef.current?.focus({ preventScroll: true });
  }, [chromeFocus, chromePage, showHeader, showFooter]);

  useLayoutEffect(() => {
    const el = chromeFocus === "header" ? headerStackRef.current : chromeFocus === "footer" ? footerStackRef.current : null;
    if (!el) {
      setLiveStackH(0);
      return;
    }
    const update = () => setLiveStackH(el.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [chromeFocus, chromePage, headerText, footerText, firstHeaderText, firstFooterText]);

  const flowLayout = useMemo(() => {
    const headerTextH =
      showHeader || chromeFocus === "header"
        ? Math.max(chromeSize.header, differentFirstPage ? chromeSize.firstHeader : 0)
        : 0;
    const footerTextH =
      showFooter || chromeFocus === "footer"
        ? Math.max(chromeSize.footer, differentFirstPage ? chromeSize.firstFooter : 0)
        : 0;
    const headerBlock =
      chromeFocus === "header"
        ? Math.max(liveStackH, headerTextH + CHROME_BAR_PX, CHROME_LINE_PX + CHROME_BAR_PX)
        : headerTextH;
    const footerBlock =
      chromeFocus === "footer"
        ? Math.max(liveStackH, footerTextH + CHROME_BAR_PX, CHROME_LINE_PX + CHROME_BAR_PX)
        : footerTextH;
    const marginTop = Math.max(pageLayout.marginTop, CHROME_FROM_PX + headerBlock);
    const marginBottom = Math.max(pageLayout.marginBottom, CHROME_FROM_PX + footerBlock);
    if (marginTop === pageLayout.marginTop && marginBottom === pageLayout.marginBottom) return pageLayout;
    return { ...pageLayout, marginTop, marginBottom };
  }, [pageLayout, chromeSize, differentFirstPage, showHeader, showFooter, chromeFocus, liveStackH]);

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
            <ToolbarSelect
              variant="style"
              ariaLabel="Paragraph style"
              value={active.blockStyle}
              options={BLOCK_STYLES}
              onPick={(next) => void handleAction("style", next)}
            />
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
              data-active={chromeAlign === "left"}
              onMouseDown={(event: ReactMouseEvent<HTMLButtonElement>) => {
                if (chromeFocus) event.preventDefault();
              }}
              onClick={() => void handleAction("align", "left")}
            >
              <AlignLeftIcon />
            </button>
            <button
              className="tool"
              type="button"
              title="Align center"
              data-active={chromeAlign === "center"}
              onMouseDown={(event: ReactMouseEvent<HTMLButtonElement>) => {
                if (chromeFocus) event.preventDefault();
              }}
              onClick={() => void handleAction("align", "center")}
            >
              <AlignCenterIcon />
            </button>
            <button
              className="tool"
              type="button"
              title="Align right"
              data-active={chromeAlign === "right"}
              onMouseDown={(event: ReactMouseEvent<HTMLButtonElement>) => {
                if (chromeFocus) event.preventDefault();
              }}
              onClick={() => void handleAction("align", "right")}
            >
              <AlignRightIcon />
            </button>
            <button
              className="tool"
              type="button"
              title="Justify"
              data-active={chromeAlign === "justify"}
              onMouseDown={(event: ReactMouseEvent<HTMLButtonElement>) => {
                if (chromeFocus) event.preventDefault();
              }}
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
    }
  };

  const renderAiTools = () => (
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
        className="tool ai-tool grammar-tool"
        type="button"
        title={
          grammarPhase === "running"
            ? "Fixing grammar…"
            : grammarNote || "Fix grammar"
        }
        aria-label="Fix grammar"
        aria-busy={grammarPhase === "running"}
        data-grammar={grammarPhase}
        disabled={mode === "viewing"}
        onClick={() => {
          setToolbarMoreOpen(false);
          void handleAction("fix-grammar");
        }}
      >
        {grammarPhase === "running" ? (
          <GrammarSpinner />
        ) : grammarPhase === "done" ? (
          <GrammarCheckIcon />
        ) : (
          <GrammarIcon />
        )}
      </button>
    </>
  );

  const scaledWidth = pageLayout.width * zoom;
  const scaledHeight =
    (metrics.pageCount * pageLayout.height + Math.max(0, metrics.pageCount - 1) * PAGE_GAP) * zoom;
  const documentStyle = {
    transform: `scale(${zoom})`,
    "--page-width": cssInches(pageLayout.width),
    "--page-height": cssInches(pageLayout.height),
    "--page-margin-top": cssInches(flowLayout.marginTop),
    "--page-margin-right": cssInches(flowLayout.marginRight),
    "--page-margin-bottom": cssInches(flowLayout.marginBottom),
    "--page-margin-left": cssInches(flowLayout.marginLeft),
    "--page-content-width": cssInches(flowLayout.width - flowLayout.marginLeft - flowLayout.marginRight),
    "--page-content-height": cssInches(flowLayout.height - flowLayout.marginTop - flowLayout.marginBottom),
    "--page-break-height": cssInches(flowLayout.marginTop + flowLayout.marginBottom + PAGE_GAP),
    "--doc-font": docFont,
    "--doc-size": docFontSize,
    "--header-from": "0.5in",
    "--footer-from": "0.5in",
  } as CSSProperties;
  const chromeAlign = chromeFocus === "header" ? headerAlign : chromeFocus === "footer" ? footerAlign : active.align;

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
      {docReady ? <title>{`${title.trim() || "Untitled document"} - Inline`}</title> : null}
      <header className="header">
        <button className="logo logo-button" type="button" aria-label="Inline home" onClick={onGoHome}>
          <InlineMark />
        </button>
        <div className="header-main">
        <div className="header-row">
          <input
            className="title-input"
            value={title}
            size={Math.max(10, title.length + 2)}
            aria-label="Document title"
            onChange={(event) => setTitle(event.target.value)}
          />
          {mode !== "editing" && (
            <span className={`mode-pill mode-${mode}`}>
              {mode === "suggesting" ? "Suggesting" : "Viewing"}
            </span>
          )}
          {IS_DEV ? (
            <button
              className="debug-copy-btn"
              type="button"
              title="Copy document and chat snapshot"
              onClick={() => void handleAction("copy-debug-snapshot")}
            >
              Copy debug
            </button>
          ) : null}
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
          pageNumberLocation={pageNumberLocation}
          differentFirstPage={differentFirstPage}
          substitutions={substitutions}
          screenReader={screenReader}
          darkMode={Boolean(darkMode)}
          columns={columns}
          lineSpacing={lineSpacing}
          focusMode={focusMode}
          preserveTone={preserveTone}
          showDevTools={IS_DEV}
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
            <button className="tool" type="button" title="Search" aria-label="Search" onClick={() => void handleAction("search")}>
              <SearchIcon />
            </button>
            <button className="tool" type="button" title="Print" aria-label="Print" onClick={() => void handleAction("print")}>
              <PrintIcon />
            </button>
            <ToolbarSelect
              variant="zoom"
              ariaLabel="Zoom"
              value={zoomMode === "fit" ? "fit" : (String(zoomMode) as ZoomValue)}
              options={ZOOM_OPTIONS}
              onPick={(next) => setZoomMode(next === "fit" ? "fit" : Number(next))}
            />
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
          <span className="toolbar-sep" />
          <span className="toolbar-group" data-toolbar-group="ai">
            {renderAiTools()}
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
            const target = el ? spellingTargetAtPoint(el, event.clientX, event.clientY) : null;
            const spelling = target && !target.hit.inSuggestion ? target.hit : undefined;
            spellRangeRef.current = spelling && target ? target.range.cloneRange() : null;
            setContextMenu({
              x: Math.min(event.clientX, window.innerWidth - 260),
              y: Math.min(event.clientY, window.innerHeight - 280),
              hasSelection,
              spelling: spelling ? { word: spelling.word, ignored: spelling.ignored } : undefined,
            });
          }}
        >
        <FindBar
          open={findOpen}
          replaceOpen={findReplaceOpen}
          getEditor={editorEl}
          onClose={() => {
            setFindOpen(false);
            setFindReplaceOpen(false);
          }}
          onReplaceOpenChange={setFindReplaceOpen}
          onMutate={afterEdit}
        />
        <main className="canvas" ref={canvasRef} onScroll={updateCurrentPage}>
          <div className="document-scale" style={{ width: scaledWidth, height: scaledHeight }}>
            <div className="document" style={documentStyle}>
              <div className="papers">
                {Array.from({ length: metrics.pageCount }, (_, index) => (
                  <div className="paper" key={index} />
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
                  pageLayout={flowLayout}
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
              <div className="chrome-layer">
                {Array.from({ length: metrics.pageCount }, (_, index) => (
                  <PaperChromePage
                    key={index}
                    index={index}
                    readOnly={mode === "viewing"}
                    chromeFocus={chromeFocus}
                    chromePage={chromePage}
                    differentFirstPage={differentFirstPage}
                    showHeader={showHeader}
                    showFooter={showFooter}
                    headerText={headerText}
                    footerText={footerText}
                    firstHeaderText={firstHeaderText}
                    firstFooterText={firstFooterText}
                    headerAlign={headerAlign}
                    footerAlign={footerAlign}
                    headerHasNumber={headerHasNumber}
                    footerHasNumber={footerHasNumber}
                    pageNumberLocation={pageNumberLocation}
                    showPageNumbers={showPageNumbers}
                    headerFieldRef={headerFieldRef}
                    footerFieldRef={footerFieldRef}
                    headerStackRef={chromeFocus === "header" && chromePage === index ? headerStackRef : undefined}
                    footerStackRef={chromeFocus === "footer" && chromePage === index ? footerStackRef : undefined}
                    onOpen={openChrome}
                    onHeaderChange={(page, next) => {
                      if (differentFirstPage && page === 0) setFirstHeaderText(next);
                      else setHeaderText(next);
                    }}
                    onFooterChange={(page, next) => {
                      if (differentFirstPage && page === 0) setFirstFooterText(next);
                      else setFooterText(next);
                    }}
                    onDifferentFirstPage={setDifferentFirstPage}
                    onPageNumbersHeader={() => {
                      setPageNumberLocation("header");
                      setShowPageNumbers(true);
                    }}
                    onPageNumbersFooter={() => {
                      setPageNumberLocation("footer");
                      setShowPageNumbers(true);
                    }}
                    onRemovePageNumbers={() => setShowPageNumbers(false)}
                  />
                ))}
              </div>
              <div className="paper-chrome-probes" aria-hidden>
                <div ref={headerMeasureRef} className={`paper-chrome-measure${headerHasNumber ? " has-page-num" : ""}`}>
                  {headerText}
                </div>
                <div ref={firstHeaderMeasureRef} className={`paper-chrome-measure${headerHasNumber ? " has-page-num" : ""}`}>
                  {firstHeaderText}
                </div>
                <div ref={footerMeasureRef} className={`paper-chrome-measure${footerHasNumber ? " has-page-num" : ""}`}>
                  {footerText}
                </div>
                <div ref={firstFooterMeasureRef} className={`paper-chrome-measure${footerHasNumber ? " has-page-num" : ""}`}>
                  {firstFooterText}
                </div>
              </div>
            </div>
          </div>
        </main>
        <div className="canvas-meta canvas-meta-page">
          Page {Math.min(currentPage, metrics.pageCount)} of {metrics.pageCount}
        </div>
        <div className="canvas-meta canvas-meta-words">
          {metrics.wordCount} {metrics.wordCount === 1 ? "word" : "words"}
        </div>
        {grammarPhase !== "idle" ? (
          <div className="grammar-pip" data-state={grammarPhase} role="status" aria-live="polite">
            {grammarPhase === "running" ? <GrammarSpinner /> : <GrammarCheckIcon />}
            <span>{grammarNote || (grammarPhase === "running" ? "Checking grammar" : "Done")}</span>
          </div>
        ) : null}
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
            busy={anyBusy}
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
        busy={Boolean(activeLive)}
        livePhase={activeLive?.phase ?? null}
        liveThinking={activeLive?.thinking ?? ""}
        livePrompt={activeLive?.prompt ?? ""}
        liveSelection={activeLive?.selection ?? null}
        liveMessage={activeLive?.message ?? ""}
        liveEdits={activeLive?.edits ?? []}
        liveCitations={activeLive?.citations ?? []}
        error={askError}
        prompt={askPrompt}
        context={agentContext}
        chats={chats}
        activeChatId={activeChat?.id ?? activeChatId}
        openChatIds={openChatIds}
        runningChatIds={Object.keys(lives)}
        queued={queuedJobs.filter((item) => !item.chatId || item.chatId === (activeChat?.id ?? activeChatId))}
        contextUsage={contextUsage}
        liveSteps={activeLive?.steps.length ? activeLive.steps : undefined}
        liveTimeline={activeLive?.timeline.length ? activeLive.timeline : undefined}
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
          setOpenChatIds((ids) => [...ids, chat.id]);
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
          setOpenChatIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
          setActiveChatId(id);
          setAskError(null);
        }}
        onCloseTab={(id) => {
          const remaining = openChatIds.filter((item) => item !== id);
          if (id === activeChatId) {
            const index = openChatIds.indexOf(id);
            const fallback = remaining[index] ?? remaining[index - 1] ?? remaining[0];
            if (fallback) {
              setChatDrafts((drafts) => ({ ...drafts, [activeChatId]: askPrompt }));
              setActiveChatId(fallback);
              setAskPrompt(chatDrafts[fallback] ?? "");
              setAskError(null);
              setOpenChatIds(remaining);
              return;
            }
            const chat = createChat({
              mode: activeChat?.mode,
              model: activeChat?.model,
              thinkingLevel: activeChat?.thinkingLevel,
            });
            setChats((list) => [chat, ...list]);
            setActiveChatId(chat.id);
            setAskPrompt("");
            setAskError(null);
            setAgentContext([]);
            setOpenChatIds([chat.id]);
            return;
          }
          setOpenChatIds(remaining);
        }}
        onDeleteChat={(id) => {
          setChatDrafts((drafts) => {
            const next = { ...drafts };
            delete next[id];
            return next;
          });
          setOpenChatIds((ids) => ids.filter((item) => item !== id));
          setChats((list) => {
            const next = list.filter((chat) => chat.id !== id);
            if (!next.length) {
              const chat = createChat({
                mode: activeChat?.mode,
                model: activeChat?.model,
                thinkingLevel: activeChat?.thinkingLevel,
              });
              setActiveChatId(chat.id);
              setOpenChatIds([chat.id]);
              setAskPrompt("");
              return [chat];
            }
            if (id === activeChatId) {
              setActiveChatId(next[0].id);
              setAskPrompt(chatDrafts[next[0].id] ?? "");
              setOpenChatIds((ids) => (ids.includes(next[0].id) ? ids.filter((item) => item !== id) : [next[0].id, ...ids.filter((item) => item !== id)]));
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
        liveTools={activeLive?.tools ?? []}
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
      {dialog === "page-setup" && (
        <PageSetupDialog
          layout={pageLayout}
          onClose={() => setDialog(null)}
          onApply={(next) => {
            setPageLayout(next);
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
          busy={anyBusy}
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
            ...(contextMenu.spelling
              ? [
                  {
                    label: contextMenu.spelling.ignored
                      ? `Stop ignoring “${contextMenu.spelling.word}”`
                      : `Ignore “${contextMenu.spelling.word}”`,
                    action: "ignore-spelling",
                  },
                ]
              : []),
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

function holdGrammarLoad(started: number) {
  const wait = Math.max(0, 650 - (performance.now() - started));
  return wait ? new Promise<void>((resolve) => window.setTimeout(resolve, wait)) : Promise.resolve();
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
  ...(IS_DEV
    ? [{ id: "copy-debug-snapshot", label: "Copy document and chat snapshot", group: "Dev", hint: "Clipboard dump for debugging" }]
    : []),
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

function GrammarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 18 10.2 6h1.7L17 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M7.2 13.4h8.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function GrammarSpinner() {
  return (
    <svg className="grammar-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="7.2" stroke="currentColor" strokeWidth="1.8" opacity="0.28" />
      <path d="M12 4.8a7.2 7.2 0 0 1 7.2 7.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function GrammarCheckIcon() {
  return (
    <svg className="grammar-check" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6.4 12.4 10.2 16.2 17.6 8.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.1" stroke="currentColor" strokeWidth="2.2" />
      <path d="m15.8 15.8 4.2 4.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function PrintIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7.2 8V4.8h9.6V8" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path
        d="M6.2 15H5.1A2.1 2.1 0 0 1 3 12.9V10a1.8 1.8 0 0 1 1.8-1.8h14.4A1.8 1.8 0 0 1 21 10v2.9a2.1 2.1 0 0 1-2.1 2.1h-1.1"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <rect x="6.2" y="13.2" width="11.6" height="6.6" rx="1.2" stroke="currentColor" strokeWidth="2.2" />
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

function chromePageText(differentFirstPage: boolean, index: number, first: string, rest: string) {
  return differentFirstPage && index === 0 ? first : rest;
}

function PaperChromePage({
  index,
  readOnly,
  chromeFocus,
  chromePage,
  differentFirstPage,
  showHeader,
  showFooter,
  headerText,
  footerText,
  firstHeaderText,
  firstFooterText,
  headerAlign,
  footerAlign,
  headerHasNumber,
  footerHasNumber,
  pageNumberLocation,
  showPageNumbers,
  headerFieldRef,
  footerFieldRef,
  headerStackRef,
  footerStackRef,
  onOpen,
  onHeaderChange,
  onFooterChange,
  onDifferentFirstPage,
  onPageNumbersHeader,
  onPageNumbersFooter,
  onRemovePageNumbers,
}: {
  index: number;
  readOnly: boolean;
  chromeFocus: null | "header" | "footer";
  chromePage: number;
  differentFirstPage: boolean;
  showHeader: boolean;
  showFooter: boolean;
  headerText: string;
  footerText: string;
  firstHeaderText: string;
  firstFooterText: string;
  headerAlign: HeaderAlign;
  footerAlign: HeaderAlign;
  headerHasNumber: boolean;
  footerHasNumber: boolean;
  pageNumberLocation: PageNumberLocation;
  showPageNumbers: boolean;
  headerFieldRef: Ref<HTMLTextAreaElement>;
  footerFieldRef: Ref<HTMLTextAreaElement>;
  headerStackRef?: Ref<HTMLDivElement>;
  footerStackRef?: Ref<HTMLDivElement>;
  onOpen: (kind: "header" | "footer", page: number) => void;
  onHeaderChange: (page: number, value: string) => void;
  onFooterChange: (page: number, value: string) => void;
  onDifferentFirstPage: (value: boolean) => void;
  onPageNumbersHeader: () => void;
  onPageNumbersFooter: () => void;
  onRemovePageNumbers: () => void;
}) {
  const headerValue = chromePageText(differentFirstPage, index, firstHeaderText, headerText);
  const footerValue = chromePageText(differentFirstPage, index, firstFooterText, footerText);
  const editingHeader = chromeFocus === "header" && chromePage === index;
  const editingFooter = chromeFocus === "footer" && chromePage === index;
  const showHeaderStack = editingHeader || (showHeader && Boolean(headerValue));
  const showFooterStack = editingFooter || (showFooter && Boolean(footerValue));
  return (
    <div className="chrome-page">
      <div
        className="paper-chrome-hit paper-chrome-hit-header"
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          if (readOnly) return;
          event.preventDefault();
          event.stopPropagation();
          onOpen("header", index);
        }}
      />
      <div
        className="paper-chrome-hit paper-chrome-hit-footer"
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          if (readOnly) return;
          event.preventDefault();
          event.stopPropagation();
          onOpen("footer", index);
        }}
      />
      {showHeaderStack ? (
        <div ref={headerStackRef} className={`paper-header-stack${editingHeader ? " is-active" : ""}`}>
          <div className={`paper-header${headerHasNumber ? " has-page-num" : ""}`} data-align={headerAlign}>
            {editingHeader ? (
              <ChromeField
                fieldRef={headerFieldRef}
                value={headerValue}
                ariaLabel="Header"
                onChange={(next) => onHeaderChange(index, next)}
                onActivate={() => onOpen("header", index)}
              />
            ) : (
              <span className="paper-chrome paper-chrome-static">{headerValue}</span>
            )}
          </div>
          <ChromeBar
            kind="header"
            firstPage={index === 0}
            differentFirstPage={differentFirstPage}
            pageNumberLocation={pageNumberLocation}
            showPageNumbers={showPageNumbers}
            onDifferentFirstPage={onDifferentFirstPage}
            onPageNumbersHeader={onPageNumbersHeader}
            onPageNumbersFooter={onPageNumbersFooter}
            onRemovePageNumbers={onRemovePageNumbers}
          />
        </div>
      ) : null}
      {headerHasNumber ? <span className="page-num page-num-header">{index + 1}</span> : null}
      {showFooterStack ? (
        <div ref={footerStackRef} className={`paper-footer-stack${editingFooter ? " is-active" : ""}`}>
          <ChromeBar
            kind="footer"
            firstPage={index === 0}
            differentFirstPage={differentFirstPage}
            pageNumberLocation={pageNumberLocation}
            showPageNumbers={showPageNumbers}
            onDifferentFirstPage={onDifferentFirstPage}
            onPageNumbersHeader={onPageNumbersHeader}
            onPageNumbersFooter={onPageNumbersFooter}
            onRemovePageNumbers={onRemovePageNumbers}
          />
          <div className={`paper-footer${footerHasNumber ? " has-page-num" : ""}`} data-align={footerAlign}>
            {editingFooter ? (
              <ChromeField
                fieldRef={footerFieldRef}
                value={footerValue}
                ariaLabel="Footer"
                onChange={(next) => onFooterChange(index, next)}
                onActivate={() => onOpen("footer", index)}
              />
            ) : (
              <span className="paper-chrome paper-chrome-static">{footerValue}</span>
            )}
          </div>
        </div>
      ) : null}
      {footerHasNumber ? <span className="page-num page-num-footer">{index + 1}</span> : null}
    </div>
  );
}

function ChromeField({
  value,
  ariaLabel,
  onChange,
  onActivate,
  fieldRef,
}: {
  value: string;
  ariaLabel: string;
  onChange: (value: string) => void;
  onActivate: () => void;
  fieldRef?: Ref<HTMLTextAreaElement>;
}) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const setRefs = (node: HTMLTextAreaElement | null) => {
    innerRef.current = node;
    if (typeof fieldRef === "function") fieldRef(node);
    else if (fieldRef) (fieldRef as MutableRefObject<HTMLTextAreaElement | null>).current = node;
  };
  const grow = () => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(grow, [value]);
  return (
    <textarea
      ref={setRefs}
      className="paper-chrome"
      rows={1}
      value={value}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      onMouseDown={onActivate}
      onFocus={onActivate}
      onKeyDown={(event) => event.stopPropagation()}
      onInput={grow}
    />
  );
}

function ChromeBar({
  kind,
  firstPage,
  differentFirstPage,
  pageNumberLocation,
  showPageNumbers,
  onDifferentFirstPage,
  onPageNumbersHeader,
  onPageNumbersFooter,
  onRemovePageNumbers,
}: {
  kind: "header" | "footer";
  firstPage: boolean;
  differentFirstPage: boolean;
  pageNumberLocation: PageNumberLocation;
  showPageNumbers: boolean;
  onDifferentFirstPage: (value: boolean) => void;
  onPageNumbersHeader: () => void;
  onPageNumbersFooter: () => void;
  onRemovePageNumbers: () => void;
}) {
  const label = differentFirstPage && firstPage ? `First page ${kind}` : kind === "header" ? "Header" : "Footer";
  return (
    <div className="paper-chrome-bar">
      <strong>{label}</strong>
      <label className="paper-chrome-check">
        <input
          type="checkbox"
          checked={differentFirstPage}
          onChange={(event) => onDifferentFirstPage(event.target.checked)}
        />
        Different first page
      </label>
      <details className="paper-chrome-options">
        <summary>Options</summary>
        <div className="paper-chrome-options-menu">
          <button type="button" onClick={onPageNumbersHeader}>
            {showPageNumbers && pageNumberLocation === "header" ? "✓ " : ""}Page number in header
          </button>
          <button type="button" onClick={onPageNumbersFooter}>
            {showPageNumbers && pageNumberLocation === "footer" ? "✓ " : ""}Page number in footer
          </button>
          {showPageNumbers ? (
            <button type="button" onClick={onRemovePageNumbers}>
              Remove page numbers
            </button>
          ) : null}
        </div>
      </details>
    </div>
  );
}
