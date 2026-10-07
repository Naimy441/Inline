"use client";

import { Check, CloudOff, Download, History, ListTree, Loader2, MessageSquare, Moon, MoreHorizontal, PanelRight, Sparkles, Sun } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { EditorState } from "prosemirror-state";
import type { SelectionContext } from "@/lib/agent/types";
import { api, patch, post, uploadFile } from "@/lib/client/api";
import { DocumentSession, geometryFor, type ClientCommand, type DocumentUiState, type EditorMode } from "@/lib/client/documentSession";
import { useTheme } from "@/lib/client/theme";
import { useShortcut } from "@/lib/client/platform";
import { docPlainText, docWordCount, wordCount } from "@/lib/doc/editing";
import type { DocComment, DocumentMeta } from "@/lib/doc/settings";
import { insertImage, insertText } from "@/lib/editor/commands";
import { AgentPanel, type AgentPanelHandle } from "@/components/agent/AgentPanel";
import { Spark } from "@/components/agent/Activity";
import { PanelResizer } from "@/components/ui/PanelResizer";
import { loadServerPlatform, revealOnDisk } from "@/lib/client/fileManager";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ConfirmHost } from "@/components/ui/Confirm";
import { MenuButton, type MenuItem } from "@/components/ui/Menu";
import { toast, Toaster } from "@/components/ui/Toast";
import { InlineLogo } from "@/components/ui/Logo";
import { CommentsPanel } from "@/components/workspace/CommentsPanel";
import { CommentMargin, marginFits } from "@/components/workspace/CommentMargin";
import { FindBar } from "@/components/workspace/FindBar";
import { HistoryPanel, VersionPreview, type VersionSummary } from "@/components/workspace/HistoryPanel";
import { prefetchVersions } from "@/lib/client/versions";
import { acquireChat, releaseChat, rememberedChat } from "@/lib/client/chatSession";
import { addTab, rememberedRoot, takeScroll, useTabs } from "@/lib/client/tabs";
import { documentMenus, MenuBar, type MenuActions } from "@/components/workspace/MenuBar";
import { OutlinePanel } from "@/components/workspace/OutlinePanel";
import { PageCanvas } from "@/components/workspace/PageCanvas";
import { PageSetupDialog } from "@/components/workspace/PageSetupDialog";
import { ReviewBar } from "@/components/workspace/ReviewBar";
import { EDITOR_MODES, modeMenuItems } from "@/components/workspace/modes";
import { COMPACT_QUERY, isCompact, useMediaQuery, useVisualViewportVars } from "@/lib/client/viewport";
import { DEFAULT_PREFERENCES, preferences, setPreference } from "@/lib/client/preferences";
import { SelectionBubble } from "@/components/workspace/SelectionBubble";
import { ShortcutsDialog } from "@/components/workspace/ShortcutsDialog";
import { ContextMenu } from "@/components/workspace/ContextMenu";
import { AgentLocator, OfflineNotice } from "@/components/workspace/CanvasNotices";
import { SpecialCharactersDialog } from "@/components/workspace/SpecialCharactersDialog";
import { Toolbar } from "@/components/workspace/Toolbar";

type Panel = "agent" | "comments" | "history" | null;
type Zoom = number | "fit";

const PANEL_KEY = "inline-panel";
const PANEL_WIDTH_KEY = "inline-panel-width";
const ZOOM_KEY = "inline-zoom";
const OUTLINE_KEY = "inline-outline";
const FOCUS_KEY = "inline-focus-mode";

function readStored<T>(key: string, fallback: T, parse: (raw: string) => T | null): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export function Workspace({ documentId }: { documentId: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const initialAsk = search.get("ask");
  const agentRef = useRef<AgentPanelHandle>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const { dark, toggle: toggleTheme } = useTheme();
  const keys = useShortcut();

  const [panel, setPanelState] = useState<Panel>("agent");
  const [panelWidth, setPanelWidth] = useState(420);
  const [zoom, setZoomState] = useState<Zoom>("fit");
  const [canvasWidth, setCanvasWidth] = useState(0);
  const canvasRef = useRef<HTMLElement>(null);
  // Below this width, or when they don't fit beside the title, the menu bar and labelled buttons fold into a "More" menu.
  const titlebarRef = useRef<HTMLElement>(null);
  const narrow = useMediaQuery(COMPACT_QUERY);
  const crowded = useCrowdedTitlebar(titlebarRef, narrow);
  const compact = narrow || crowded;
  useVisualViewportVars();
  const [outline, setOutline] = useState(false);
  const [find, setFind] = useState<{ replace: boolean } | null>(null);
  const [linkEditing, setLinkEditing] = useState(false);
  const [prompting, setPrompting] = useState(false);
  // The inline ⌘K prompt is open: start Claude Code while the user types.
  useEffect(() => {
    if (prompting) agentRef.current?.warm();
  }, [prompting]);
  /** The text a new comment is being written about. */
  const [draftComment, setDraftComment] = useState<{ from: number; to: number } | null>(null);
  /** A saved version shown in place of the document, from version history. */
  const [versionShown, setVersionShown] = useState<VersionSummary | null>(null);
  const [setup, setSetup] = useState<{ tab: "page" | "text" | "header" } | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [counting, setCounting] = useState(false);
  const [charmap, setCharmap] = useState(false);
  const [focusMode, setFocusMode] = useState(false);

  // Before the first paint, so a panel kept closed doesn't flash open.
  useLayoutEffect(() => {
    // On phones and tablets a panel covers the document, so it only opens when asked for.
    if (isCompact()) setPanelState(initialAsk ? "agent" : null);
    else {
      // "none" is the choice to keep panels closed, so it can't parse to null (which means "not stored").
      const stored = readStored<Panel | "none">(PANEL_KEY, "agent", (raw) => (["none", "agent", "comments", "history"].includes(raw) ? (raw as Panel | "none") : null));
      setPanelState(stored === "none" ? null : stored);
    }
    setPanelWidth(readStored(PANEL_WIDTH_KEY, 420, (raw) => (Number(raw) >= 320 ? Math.min(760, Number(raw)) : null)));
    setZoomState(readStored<Zoom>(ZOOM_KEY, "fit", (raw) => (raw === "fit" ? "fit" : Number(raw) >= 0.5 && Number(raw) <= 2 ? Number(raw) : null)));
    setOutline(!isCompact() && readStored(OUTLINE_KEY, false, (raw) => raw === "1"));
    setFocusMode(readStored(FOCUS_KEY, false, (raw) => raw === "1"));
  }, []);

  const setPanel = useCallback((next: Panel | ((current: Panel) => Panel)) => {
    setPanelState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      store(PANEL_KEY, value ?? "none");
      return value;
    });
  }, []);

  const toggleOutline = useCallback(
    () =>
      setOutline((value) => {
        store(OUTLINE_KEY, value ? "0" : "1");
        return !value;
      }),
    [],
  );

  const setZoom = (value: Zoom) => {
    setZoomState(value);
    store(ZOOM_KEY, String(value));
  };

  // "Fit" zoom shrinks pages that are wider than the canvas (narrow windows, tablets, an open panel).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setCanvasWidth(canvas.clientWidth));
    observer.observe(canvas);
    setCanvasWidth(canvas.clientWidth);
    return () => observer.disconnect();
  }, []);

  const commandHandler = useRef<(command: ClientCommand) => void>(() => undefined);
  const keyHandler = useRef<(name: "link" | "find" | "replace" | "comment" | "askClaude") => boolean>(() => false);

  const session = useMemo(
    () =>
      new DocumentSession(documentId, {
        onCommand: (command) => commandHandler.current(command),
        onKeyCommand: (name) => keyHandler.current(name),
      }),
    [documentId],
  );

  const ui = useWorkspaceUi(session);
  // Warm version history once the document is open, so the panel opens with its list.
  const ready = ui.status === "ready";
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => prefetchVersions(documentId), 2500);
    return () => clearTimeout(timer);
  }, [ready, documentId]);
  // A heading picked in another tab's outline.
  useEffect(() => {
    if (!ready) return;
    const pos = takeScroll(documentId);
    // After the pages are laid out, so the heading is where it will stay.
    if (pos === null) return;
    const timer = setTimeout(() => session.scrollTo(pos, pos, "start"), 120);
    return () => clearTimeout(timer);
  }, [ready, documentId, session]);
  const prefs = useSyncExternalStore(preferences.subscribe, preferences.get, () => DEFAULT_PREFERENCES);
  const meta = ui.meta;
  // A document's tabs share one Claude chat, kept under the first tab's id.
  const [rememberedChatKey] = useState(() => (typeof window === "undefined" ? documentId : rememberedRoot(documentId)));
  const chatKey = meta ? (meta.parentId ?? meta.id) : rememberedChatKey;
  // Keep the document's chat open while the panel is closed, so opening it shows the chat at once.
  useEffect(() => {
    const chatId = rememberedChat(chatKey);
    if (!chatId) return;
    const chat = acquireChat(chatId);
    return () => releaseChat(chat);
  }, [chatKey]);

  const canvasPad = canvasWidth && canvasWidth < 900 ? 16 : 40;
  const pageWidth = geometryFor(meta).pageWidth;
  const fitZoom = canvasWidth ? Math.max(0.25, Math.min(1, Math.floor(((canvasWidth - canvasPad * 2) / pageWidth) * 100) / 100)) : 1;
  const effectiveZoom = zoom === "fit" ? fitZoom : zoom;

  useEffect(() => {
    if (meta) document.title = `${meta.title} · Inline`;
  }, [meta]);

  // Edits that couldn't be merged after the server's copy changed (e.g. a server restart).
  const unmerged = ui.unmerged;
  useEffect(() => {
    if (!unmerged) return;
    toast(`${unmerged.steps === 1 ? "An edit" : "Some edits"} couldn't be merged with the server's copy. Save them as a new document?`, {
      tone: "error",
      duration: 30_000,
      action: {
        label: "Save copy",
        run: () =>
          void session
            .recoverUnmerged()
            .then((id) => id && toast("Saved your edits as a new document.", { action: { label: "Open", run: () => router.push(`/d/${id}`) } }))
            .catch(() => toast("Couldn't save the recovered edits.", { tone: "error" })),
      },
    });
  }, [unmerged, session, router]);

  const askClaude = useCallback(
    (prompt?: string) => {
      const selection: SelectionContext | null = session.selection();
      // Focus the composer in the same tick when the panel is already open, so
      // keystrokes typed right after the shortcut never land in the document.
      if (agentRef.current) {
        agentRef.current.ask(selection, prompt);
        return;
      }
      session.view?.dom.blur();
      setPanel("agent");
      requestAnimationFrame(() => agentRef.current?.ask(selection, prompt));
    },
    [session, setPanel],
  );

  /** The inline ⌘K prompt: sends straight to Claude about the selection, or the cursor when nothing is selected. */
  const inlineAsk = useCallback(
    (text: string, only?: SelectionContext) => {
      const view = session.view;
      const selection: SelectionContext | null =
        only ??
        session.selection() ?? (view ? { documentId: session.id, text: "", from: view.state.selection.from, to: view.state.selection.from } : null);
      const deliver = (tries: number) => {
        if (agentRef.current) void agentRef.current.send(selection, text).catch(() => toast("Couldn't send that to Claude.", { tone: "error" }));
        else if (tries > 0) requestAnimationFrame(() => deliver(tries - 1));
      };
      setPanel("agent");
      deliver(60);
    },
    [session, setPanel],
  );

  /** Spelling and grammar for the selection, or the paragraph at the cursor (⌘⌥X). */
  const checkSpelling = useCallback(() => {
    const view = session.view;
    if (!view) return;
    let selection = session.selection();
    if (!selection) {
      const { $from } = view.state.selection;
      const from = $from.start();
      const to = $from.end();
      const text = view.state.doc.textBetween(from, to, "\n");
      if (!text.trim()) {
        toast("Put the cursor in a paragraph or select some text to check.");
        return;
      }
      selection = { documentId: session.id, text, from, to };
    }
    inlineAsk("Fix spelling, grammar and punctuation in the selected text only. Don't change the meaning, voice or wording beyond what's needed. If it's already correct, say so and don't edit.", selection);
  }, [session, inlineAsk]);

  const startComment = useCallback(() => {
    if (!session.view || session.view.state.selection.empty) {
      toast("Select the text you want to comment on.");
      return;
    }
    const { from, to } = session.view.state.selection;
    // With no side panel open and room beside the page, the comment is written in the margin next to its text.
    if (panel !== null || !marginFits(canvasRef.current)) setPanel("comments");
    setDraftComment({ from, to });
    session.setCommentDraft({ from, to });
  }, [session, setPanel, panel]);
  const endDraft = useCallback(() => {
    setDraftComment(null);
    session.setCommentDraft(null);
  }, [session]);
  const askAboutComment = useCallback(
    (comment: DocComment) => {
      setPanel("agent");
      requestAnimationFrame(() =>
        agentRef.current?.ask(null, `Address this comment (id ${comment.id}) on “${comment.quote}”: ${comment.body}\nThen reply to the comment saying what you changed and resolve it.`),
      );
    },
    [setPanel],
  );

  keyHandler.current = (name) => {
    if (name === "find" || name === "replace") setFind({ replace: name === "replace" });
    else if (name === "link") setLinkEditing(true);
    else if (name === "comment") startComment();
    else if (name === "askClaude") askClaude();
    return true;
  };

  const [exporting, setExporting] = useState<{ format: "docx" | "md" | "html" | "txt"; scope: "all" | "tab" } | null>(null);
  const tabs = useTabs(documentId);
  const download = useCallback(
    async (format: "docx" | "pdf" | "md" | "html" | "txt", changes?: "with" | "without", scope: "all" | "tab" = "all") => {
      // A document with tabs downloads all of them, in order, unless asked for the open tab only.
      const others = scope === "all" && tabs && tabs.length > 1 ? tabs.map((tab) => tab.id) : null;
      if (format !== "pdf" && !changes && session.ui.get().hunks.length) {
        setExporting({ format, scope });
        return;
      }
      if (format === "pdf") {
        const addTabs = others ? (await import("@/components/workspace/exportTabs")).withOtherTabs(documentId, others) : undefined;
        await session.exportPdf(addTabs).catch((error: Error) => toast(`Couldn't export the PDF: ${error.message}`, { tone: "error" }));
        return;
      }
      await session.whenSaved();
      const link = document.createElement("a");
      link.href = `/api/documents/${documentId}/export?format=${format}${changes === "without" ? "&changes=without" : ""}${others ? "&tabs=all" : ""}`;
      link.download = "";
      document.body.append(link);
      link.click();
      link.remove();
    },
    [session, documentId, tabs],
  );

  commandHandler.current = (command) => {
    if (command.kind === "print") void session.print();
    else if (command.kind === "export_pdf") void download("pdf", undefined, command.tabs ?? "tab");
    else if (command.kind === "download") {
      const link = document.createElement("a");
      link.href = command.url;
      link.download = command.filename;
      document.body.append(link);
      link.click();
      link.remove();
    } else if (command.kind === "open_document" && command.documentId !== documentId) {
      toast("Claude opened another document.", { action: { label: "Open", run: () => router.push(`/d/${command.documentId}`) } });
    } else if (command.kind === "scroll_to") session.scrollTo(command.from, command.to);
  };

  // App-level shortcuts that work even when the editor isn't focused.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const modKey = event.metaKey || event.ctrlKey;
      if (!modKey) return;
      const key = event.key.toLowerCase();
      // Mode shortcuts match Google Docs; event.code because Alt changes event.key on macOS.
      const modeByCode: Record<string, EditorMode> = { KeyZ: "editing", KeyX: "suggesting", KeyC: "viewing" };
      if (event.altKey && event.shiftKey && modeByCode[event.code]) {
        event.preventDefault();
        void session.setMode(modeByCode[event.code]!);
        return;
      }
      if (event.shiftKey && !event.altKey && event.code === "KeyP") {
        event.preventDefault();
        session.setShowInvisibles(!preferences.get().showInvisibles);
        return;
      }
      if (key === "k" && !event.shiftKey && !event.altKey && session.view?.hasFocus() && session.ui.get().mode !== "viewing") {
        event.preventDefault();
        setPrompting(true);
        return;
      }
      if (event.altKey && !event.shiftKey && event.code === "KeyX" && session.view?.hasFocus() && session.ui.get().mode !== "viewing") {
        event.preventDefault();
        checkSpelling();
        return;
      }
      if (key === "j" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setPanel((current) => (current === "agent" ? null : "agent"));
      } else if (key === "l" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        askClaude();
      } else if (key === "/") {
        event.preventDefault();
        setShortcuts(true);
      } else if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        void session.print();
      } else if (key === "f" && !event.shiftKey && !(event.target as HTMLElement).closest?.(".agent-panel")) {
        event.preventDefault();
        setFind({ replace: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [askClaude, checkSpelling, setPanel, session]);

  const insertImageFile = async (file: File) => {
    try {
      const uploaded = await uploadFile(file);
      if (uploaded.kind !== "image") {
        toast("That file isn't an image.", { tone: "error" });
        return;
      }
      session.run(insertImage(uploaded.url, file.name.replace(/\.[^.]+$/, "")));
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't upload the image.", { tone: "error" });
    }
  };

  // For the File menu's "Show in Finder" label; read when the menu opens, so nothing re-renders.
  useEffect(() => void loadServerPlatform(), []);

  const actions: MenuActions = {
    newDocument: async () => {
      const { document } = await post<{ document: { meta: DocumentMeta } }>("/api/documents", {});
      router.push(`/d/${document.meta.id}`);
    },
    goHome: () => router.push("/"),
    duplicate: async () => {
      await session.whenSaved();
      const { document } = await post<{ document: { meta: DocumentMeta } }>(`/api/documents/${documentId}/duplicate`);
      toast(`Created "${document.meta.title}".`, { action: { label: "Open", run: () => router.push(`/d/${document.meta.id}`) } });
    },
    download: (format) => void download(format),
    print: () => void session.print(),
    reveal: () => void session.whenSaved().then(() => revealOnDisk({ documentId })),
    pageSetup: (tab = "page") => setSetup({ tab }),
    history: () => setPanel("history"),
    trash: async () => {
      await patch(`/api/documents/${documentId}`, { trashed: true });
      router.push("/");
    },
    find: (replace) => setFind({ replace }),
    link: () => setLinkEditing(true),
    comment: startComment,
    image: () => imageInput.current?.click(),
    zoom: setZoom,
    zoomFit: zoom === "fit",
    toggleTheme,
    dark,
    toggleOutline,
    addTab: () =>
      void addTab(documentId)
        .then((id) => router.push(`/d/${id}`))
        .catch((error: Error) => toast(error.message, { tone: "error" })),
    toggleAgent: () => setPanel((current) => (current === "agent" ? null : "agent")),
    shortcuts: () => setShortcuts(true),
    connectClaudeCode: async () => {
      try {
        const { command } = await api<{ command: string }>("/api/mcp/connect");
        await navigator.clipboard.writeText(command);
        toast("Copied. Paste the command in a terminal to let Claude Code work in your Inline documents.", { tone: "success", duration: 8000 });
      } catch {
        toast("Couldn't copy the command. Open /api/mcp/connect to see it.", { tone: "error" });
      }
    },
    wordCount: () => setCounting(true),
    specialCharacters: () => setCharmap(true),
    notice: (message) => toast(message),
    paste: (plain) => void session.paste(plain).catch((error: Error) => toast(error.message, { tone: "error" })),
    clipboard: (action) => {
      if (!session.clipboard(action)) toast(`Select some text to ${action}.`);
    },
    fitWidth: () => setZoom("fit"),
    fullScreen: () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen?.().catch(() => toast("Full screen isn't available here."));
    },
    focusMode,
    toggleFocusMode: () => {
      const next = !focusMode;
      setFocusMode(next);
      store(FOCUS_KEY, next ? "1" : "0");
      if (next) setPanel((current) => (current === "agent" ? null : current));
      toast(next ? "Focus mode on: Claude is hidden until you turn it off in View." : "Focus mode off.");
    },
    mode: ui.mode,
    setMode: (mode) => void session.setMode(mode),
    showInvisibles: prefs.showInvisibles,
    toggleInvisibles: () => session.setShowInvisibles(!prefs.showInvisibles),
    spellcheck: prefs.spellcheck,
    toggleSpellcheck: () => session.setSpellcheck(!prefs.spellcheck),
    substitutions: prefs.substitutions,
    toggleSubstitutions: () => {
      setPreference("substitutions", !prefs.substitutions);
      toast(prefs.substitutions ? "Automatic substitutions off." : "Automatic substitutions on.");
    },
    checkSpelling,
    ask: (prompt) => {
      setPanel("agent");
      requestAnimationFrame(() => agentRef.current?.ask(null, prompt));
    },
  };

  if (ui.status === "error" || ui.status === "deleted") {
    return (
      <div className="workspace-error">
        <InlineLogo size={32} />
        <h1>{ui.status === "deleted" ? "This document was deleted" : "Couldn't open this document"}</h1>
        <p>{ui.error ?? "It may have been moved to the trash or deleted in another window."}</p>
        <button type="button" className="btn btn-primary btn-md" onClick={() => router.push("/")}>
          <span className="btn-label">Back to documents</span>
        </button>
      </div>
    );
  }

  const openComments = ui.comments.filter((comment) => !comment.resolved).length;
  const working = Boolean(ui.activity && ui.activity.status !== "idle");
  const formats = (scope: "all" | "tab"): MenuItem[] => [
    { label: "Word (.docx)", onSelect: () => void download("docx", undefined, scope) },
    { label: "PDF (.pdf)", onSelect: () => void download("pdf", undefined, scope) },
    { label: "Markdown (.md)", onSelect: () => void download("md", undefined, scope) },
    { label: "Web page (.html)", onSelect: () => void download("html", undefined, scope) },
    { label: "Plain text (.txt)", onSelect: () => void download("txt", undefined, scope) },
  ];
  const downloads: MenuItem[] =
    tabs && tabs.length > 1
      ? [{ kind: "label", label: `All ${tabs.length} tabs` }, ...formats("all"), { kind: "separator" }, { label: "This tab only", submenu: formats("tab") }]
      : formats("all");
  // Phones fold the title bar's buttons and the menu bar into one menu.
  const moreItems = (): MenuItem[] => [
    { label: "Mode", hint: EDITOR_MODES[ui.mode].label, icon: EDITOR_MODES[ui.mode].icon(16), submenu: modeMenuItems(ui.mode, (mode) => void session.setMode(mode)) },
    { label: "Download", icon: <Download size={16} />, submenu: downloads },
    { label: "Version history", icon: <History size={16} />, onSelect: () => setPanel("history") },
    { label: "Dark theme", icon: <Moon size={16} />, checked: dark, onSelect: toggleTheme },
    { kind: "separator" },
    ...Object.entries(documentMenus(session, actions, effectiveZoom, ui.hunks.length)).map(([name, items]) => ({ label: name, submenu: items })),
  ];

  return (
    <div className={`workspace${panel ? " has-panel" : ""}${focusMode ? " is-focus" : ""} is-${ui.mode}`} style={{ ["--panel-width" as string]: `${panelWidth}px` }}>
      <header ref={titlebarRef} className={`titlebar${compact ? " is-compact" : ""}`}>
        <button type="button" className="home-btn" aria-label="All documents" data-tip="All documents" onClick={() => router.push("/")}>
          <InlineLogo />
        </button>
        <div className="title-stack">
          <TitleInput meta={meta} onRename={(title) => void session.updateMeta({ title })} />
          <MenuBar session={session} actions={actions} zoom={effectiveZoom} hunks={ui.hunks.length} />
        </div>
        <div className="titlebar-status">
          <LiveSyncStatus session={session} compact={compact} />
        </div>
        {compact ? (
          <div className="titlebar-actions">
            <IconButton label="Tabs & outline" active={outline} onClick={toggleOutline}>
              <ListTree size={16} />
            </IconButton>
            <IconButton label="Comments" active={panel === "comments"} onClick={() => setPanel((current) => (current === "comments" ? null : "comments"))}>
              <MessageSquare size={16} />
              {openComments > 0 && <span className="badge">{openComments}</span>}
            </IconButton>
            {!focusMode && (
              <IconButton label="Claude" className={`claude-toggle${panel === "agent" ? " is-active" : ""}${working ? " is-working" : ""}`} onClick={() => setPanel((current) => (current === "agent" ? null : "agent"))}>
                <Sparkles size={16} />
              </IconButton>
            )}
            <MenuButton className="icon-btn icon-btn-md" label="More options" title={meta?.title ?? "Document"} placement="bottom-end" items={moreItems}>
              <MoreHorizontal size={16} />
            </MenuButton>
          </div>
        ) : (
          <div className="titlebar-actions">
            <IconButton label={dark ? "Light theme" : "Dark theme"} onClick={toggleTheme}>
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </IconButton>
            <IconButton label="Version history" active={panel === "history"} onPointerEnter={() => prefetchVersions(documentId)} onClick={() => setPanel((current) => (current === "history" ? null : "history"))}>
              <History size={16} />
            </IconButton>
            <IconButton label="Tabs & outline" active={outline} onClick={toggleOutline}>
              <ListTree size={16} />
            </IconButton>
            <IconButton label="Comments" active={panel === "comments"} onClick={() => setPanel((current) => (current === "comments" ? null : "comments"))}>
              <MessageSquare size={16} />
              {openComments > 0 && <span className="badge">{openComments}</span>}
            </IconButton>
            <button
              type="button"
              className={`btn btn-md claude-toggle claude-toggle-text${panel === "agent" ? " is-active" : ""}`}
              onClick={() => setPanel((current) => (current === "agent" ? null : "agent"))}
              aria-pressed={panel === "agent"}
              data-tip={`${panel === "agent" ? "Close" : "Open"} Claude  ${keys("⌘J")}`}
            >
              {/* With the panel closed, the button is where Claude shows it is working. */}
              {working && panel !== "agent" ? <Spark size={15} /> : <PanelRight size={15} />}
              <span className="btn-label">Claude</span>
            </button>
            <MenuButton className="btn btn-secondary btn-md export-btn" label="Download" placement="bottom-end" items={downloads}>
              <Download size={15} />
              <span className="btn-label">Export</span>
            </MenuButton>
          </div>
        )}
      </header>

      <WithEditorState session={session}>
        {(state) => (
      <Toolbar
        session={session}
        state={state}
        meta={meta}
        zoom={effectiveZoom}
        zoomFit={zoom === "fit"}
        onZoom={setZoom}
        onLink={() => setLinkEditing(true)}
        onComment={startComment}
        onImage={() => imageInput.current?.click()}
        mode={ui.mode}
      />
        )}
      </WithEditorState>
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void insertImageFile(file);
          event.target.value = "";
        }}
      />

      <div className="workspace-body">
        {outline && (
          <>
            <div className="tabs-backdrop" onClick={toggleOutline} aria-hidden />
            <WithEditorState session={session}>{(state) => <OutlinePanel session={session} state={state} meta={meta} readOnly={ui.mode === "viewing"} onClose={toggleOutline} />}</WithEditorState>
          </>
        )}
        <main
          ref={canvasRef}
          className={`canvas${versionShown && panel === "history" ? " is-previewing" : ""}${!panel && (draftComment || ui.comments.some((comment) => !comment.resolved)) && marginFits(canvasRef.current) ? " with-comments" : ""}`}
          style={{ ["--canvas-pad" as string]: `${canvasPad}px` }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onPasteCapture={(event) => {
            if (!(event.target as HTMLElement).closest?.(".doc-content")) return;
            const data = event.clipboardData;
            const image = Array.from(data.files).find((item) => item.type.startsWith("image/"));
            // A screenshot or copied image file: upload it. Pasted HTML is left to the editor.
            if (image && !data.types.includes("text/html")) {
              event.preventDefault();
              event.stopPropagation();
              void insertImageFile(image);
              return;
            }
            if (data.types.includes("text/html") && data.getData("text/html").includes("data:image/")) {
              setTimeout(() => void session.uploadInlineImages(), 0);
            }
          }}
          onDrop={(event) => {
            const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("image/"));
            if (!file) return;
            event.preventDefault();
            void insertImageFile(file);
          }}
        >
          {find && <WithEditorState session={session}>{(state) => <FindBar session={session} state={state} replace={find.replace} onClose={() => setFind(null)} />}</WithEditorState>}
          <OfflineNotice offline={ui.status === "ready" && (ui.connection === "reconnecting" || ui.sync === "error")} />
          <WithEditorState session={session}>{(state) => <AgentLocator canvas={canvasRef} state={state} active={working && !focusMode} label={ui.activity?.label ?? ""} />}</WithEditorState>
          {ui.status === "loading" && (
            <div className="canvas-loading">
              <Loader2 size={18} className="spin" />
            </div>
          )}
          {versionShown && panel === "history" && <VersionPreview key={versionShown.id} session={session} version={versionShown} onClose={() => setVersionShown(null)} />}
          <PageCanvas session={session} meta={meta} pages={ui.pages} zoom={effectiveZoom} printing={ui.printing} flow={false} />
          {!panel && (
            <WithEditorState session={session}>
              {(state) => <CommentMargin session={session} state={state} canvas={canvasRef} comments={ui.comments} active={ui.activeComment} draft={draftComment} onDraftDone={endDraft} onAskClaude={askAboutComment} />}
            </WithEditorState>
          )}
          <ReviewBar session={session} hunks={ui.hunks} />
          <WithEditorState session={session}>{(state) => <SelectionBubble session={session} state={state} linkEditing={linkEditing} onLinkEditing={setLinkEditing} onAsk={() => askClaude()} onComment={startComment} prompting={prompting} onPrompting={setPrompting} onInlineAsk={inlineAsk} />}</WithEditorState>
        </main>

        {panel && (
          <div className="panel-shell">
            <PanelResizer
              width={panelWidth}
              onResize={(value) => {
                setPanelWidth(value);
                store(PANEL_WIDTH_KEY, String(value));
              }}
            />
            {panel === "agent" && (
              <AgentPanel
                key={chatKey}
                ref={agentRef}
                documentId={documentId}
                chatKey={chatKey}
                hunks={ui.hunks}
                initialPrompt={initialAsk}
                onClose={() => setPanel(null)}
                onReview={(action, ids) => {
                  if (action === "next") session.gotoChange(1, ids);
                  else void session.review(action, ids);
                }}
              />
            )}
            {panel === "comments" && (
              <CommentsPanel
                session={session}
                comments={ui.comments}
                active={ui.activeComment}
                draft={draftComment}
                onDraftDone={endDraft}
                onClose={() => setPanel(null)}
                onAskClaude={askAboutComment}
              />
            )}
            {panel === "history" && <HistoryPanel session={session} selected={versionShown} onSelect={setVersionShown} onClose={() => setPanel(null)} />}
          </div>
        )}
      </div>

      <footer className="statusbar">
        <TabStatus documentId={documentId} open={outline} onToggle={toggleOutline} />
        {ui.hunks.length > 0 && <span className="status-item is-accent">{ui.hunks.length} pending</span>}
        {ui.mode !== "editing" && (
          <button type="button" className={`status-item status-mode is-${ui.mode}`} onClick={() => void session.setMode("editing")} data-tip="Back to editing">
            {EDITOR_MODES[ui.mode].icon(13)} {EDITOR_MODES[ui.mode].label}
          </button>
        )}
        <span className="status-spacer" />
        <button type="button" className="status-item" onClick={() => setCounting(true)}>
          <WithEditorState session={session}>{(state) => <>{(state ? docWordCount(state.doc) : (meta?.wordCount ?? 0)).toLocaleString()} words</>}</WithEditorState>
        </button>
        <span className="status-item">
          {ui.pages} page{ui.pages === 1 ? "" : "s"}
        </span>
      </footer>

      <PageSetupDialog open={Boolean(setup)} initialTab={setup?.tab} session={session} settings={meta?.settings} onClose={() => setSetup(null)} />
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
      <Dialog
        open={exporting !== null}
        onClose={() => setExporting(null)}
        title="Download with pending changes?"
        description={`${ui.hunks.length} change${ui.hunks.length === 1 ? " is" : "s are"} still waiting for review.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setExporting(null)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                const { format, scope } = exporting!;
                setExporting(null);
                void download(format, "without", scope);
              }}
            >
              Without them
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const { format, scope } = exporting!;
                setExporting(null);
                void download(format, "with", scope);
              }}
            >
              Include them
            </Button>
          </>
        }
      >
        <p>Include the pending changes as they appear now, or download the text as it was before them. Nothing in the document changes either way.</p>
      </Dialog>
      <SpecialCharactersDialog
        open={charmap}
        onClose={() => setCharmap(false)}
        onInsert={(char) => {
          session.run(insertText(char));
        }}
      />
      <ContextMenu session={session} hideClaude={focusMode} readOnly={ui.mode === "viewing"} onAsk={() => askClaude()} onComment={startComment} onLink={() => setLinkEditing(true)} />
      <WordCountDialog open={counting} onClose={() => setCounting(false)} session={session} />
      <Toaster />
      <ConfirmHost />
    </div>
  );
}

/**
 * Renders its children with the live editor state. Only this subtree re-renders
 * on a keystroke or selection change, not the whole workspace.
 */
function WithEditorState({ session, children }: { session: DocumentSession; children: (state: EditorState | null) => ReactNode }) {
  const state = useSyncExternalStore(session.editor.subscribe, session.editor.get, session.editor.get);
  return <>{children(state)}</>;
}

function TitleInput({ meta, onRename }: { meta: DocumentMeta | null; onRename: (title: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? meta?.title ?? "";
  return (
    <input
      className="title-input"
      aria-label="Document title"
      autoComplete="off"
      value={value}
      size={Math.max(8, Math.min(60, value.length + 1))}
      onFocus={(event) => {
        setDraft(meta?.title ?? "");
        event.target.select();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft != null && draft.trim() && draft.trim() !== meta?.title) onRename(draft.trim());
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") {
          setDraft(null);
          requestAnimationFrame(() => (event.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}

/**
 * The session's UI state, except that saving/saved flips don't count as a
 * change: they happen with every burst of typing and would re-render the whole
 * workspace. LiveSyncStatus shows them on its own.
 */
function useWorkspaceUi(session: DocumentSession) {
  const last = useRef<{ full: DocumentUiState; view: DocumentUiState } | null>(null);
  const get = useCallback(() => {
    const full = session.ui.get();
    const previous = last.current;
    if (previous && (previous.full === full || sameButSaving(previous.full, full))) {
      previous.full = full;
      return previous.view;
    }
    last.current = { full, view: full };
    return full;
  }, [session]);
  return useSyncExternalStore(session.ui.subscribe, get, get);
}

function sameButSaving(a: DocumentUiState, b: DocumentUiState) {
  for (const key of Object.keys(b) as Array<keyof DocumentUiState>) {
    if (key === "sync") {
      if ((a.sync === "error") !== (b.sync === "error")) return false;
    } else if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

/** Narrowest the title gets before the title bar folds into its compact layout. */
const MIN_TITLE_WIDTH = 120;
/** Extra room needed to unfold again, so a width near the edge doesn't flip back and forth. */
const UNFOLD_SLACK = 24;

/**
 * Whether the title bar's full layout (title, menus, buttons) is wider than the bar. The full
 * layout's width is measured while it's shown and remembered while the compact one is.
 */
function useCrowdedTitlebar(ref: RefObject<HTMLElement | null>, narrow: boolean) {
  const [crowded, setCrowded] = useState(false);
  const fullWidth = useRef(0);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar || narrow) return;
    const check = () => {
      const stack = bar.querySelector<HTMLElement>(".title-stack");
      const menubar = bar.querySelector<HTMLElement>(".menubar");
      const status = bar.querySelector<HTMLElement>(".titlebar-status");
      const sync = status?.firstElementChild as HTMLElement | null | undefined;
      const actions = bar.querySelector<HTMLElement>(".titlebar-actions");
      if (!crowded && stack && menubar && status && sync && actions) {
        // The title and the status's spare room give way; the menus and buttons can't.
        const padRight = Number.parseFloat(getComputedStyle(bar).paddingRight) || 0;
        const used = actions.getBoundingClientRect().right + padRight - bar.getBoundingClientRect().left;
        const stackGap = Number.parseFloat(getComputedStyle(stack).columnGap) || 0;
        fullWidth.current = used - stack.offsetWidth + MIN_TITLE_WIDTH + stackGap + menubar.offsetWidth - (status.clientWidth - sync.offsetWidth);
      }
      const width = bar.clientWidth;
      const next = crowded ? width < fullWidth.current + UNFOLD_SLACK : width < fullWidth.current;
      if (next !== crowded) setCrowded(next);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [ref, narrow, crowded]);
  return crowded && !narrow;
}

function LiveSyncStatus({ session, compact }: { session: DocumentSession; compact?: boolean }) {
  const sync = useSyncExternalStore(session.ui.subscribe, () => session.ui.get().sync, () => session.ui.get().sync);
  const connection = useSyncExternalStore(session.ui.subscribe, () => session.ui.get().connection, () => session.ui.get().connection);
  return <SyncStatus sync={sync} connection={connection} compact={compact} />;
}

function SyncStatus({ sync, connection, compact }: { sync: "saved" | "saving" | "error"; connection: "connecting" | "live" | "reconnecting"; compact?: boolean }) {
  // Phones show only the icon; the label stays available to screen readers.
  const label = (text: string) => <span className={compact ? "sr-only" : undefined}>{text}</span>;
  if (connection === "reconnecting" || sync === "error") {
    return (
      <span className="sync-status is-warning" title="Changes are kept locally and will sync when the connection is back.">
        <CloudOff size={13} /> {label("Offline")}
      </span>
    );
  }
  if (sync === "saving") {
    return (
      <span className="sync-status">
        <Loader2 size={13} className="spin" /> {label("Saving…")}
      </span>
    );
  }
  return (
    <span className="sync-status">
      <Check size={13} /> {label("Saved")}
    </span>
  );
}

function WordCountDialog({ open, onClose, session }: { open: boolean; onClose: () => void; session: DocumentSession }) {
  return (
    <Dialog open={open} onClose={onClose} title="Word count" width={420}>
      {open && <WordCountTable session={session} />}
    </Dialog>
  );
}

function WordCountTable({ session }: { session: DocumentSession }) {
  const state = session.view?.state;
  const text = state ? docPlainText(state.doc) : "";
  const selectionText = state && !state.selection.empty ? state.doc.textBetween(state.selection.from, state.selection.to, "\n") : "";
  const stats = (value: string) => ({
    words: wordCount(value),
    characters: value.replace(/\n/g, "").length,
    noSpaces: value.replace(/\s/g, "").length,
  });
  const all = stats(text);
  const selected = selectionText ? stats(selectionText) : null;
  const rows: Array<[string, number, number | undefined]> = [
    ["Words", all.words, selected?.words],
    ["Characters", all.characters, selected?.characters],
    ["Characters without spaces", all.noSpaces, selected?.noSpaces],
    ["Reading time (min)", Math.max(1, Math.round(all.words / 238)), undefined],
  ];
  return (
    <table className="stats-table">
      <thead>
        <tr>
          <th />
          <th>Document</th>
          {selected && <th>Selection</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, value, selection]) => (
          <tr key={label}>
            <td>{label}</td>
            <td>{value.toLocaleString()}</td>
            {selected && <td>{selection?.toLocaleString() ?? ""}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}


/** The open tab's name in the status bar, when the document has more than one tab. */
function TabStatus({ documentId, open, onToggle }: { documentId: string; open: boolean; onToggle: () => void }) {
  const tabs = useTabs(documentId);
  const current = tabs && tabs.length > 1 ? tabs.find((tab) => tab.id === documentId) : null;
  if (!current) return null;
  return (
    <button type="button" className={`status-item status-tab${open ? " is-active" : ""}`} onClick={onToggle} aria-pressed={open} data-tip={`${open ? "Hide" : "Show"} tabs & outline`}>
      <ListTree size={12} />
      <span>{current.title}</span>
    </button>
  );
}
