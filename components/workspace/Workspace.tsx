"use client";

import { ArrowLeft, Check, CloudOff, Download, History, Loader2, MessageSquare, Moon, MoreHorizontal, PanelRight, Sparkles, Sun } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SelectionContext } from "@/lib/agent/types";
import { patch, post, uploadFile } from "@/lib/client/api";
import { DocumentSession, geometryFor, type ClientCommand, type EditorMode } from "@/lib/client/documentSession";
import { useTheme } from "@/lib/client/theme";
import { docPlainText, wordCount } from "@/lib/doc/editing";
import type { DocumentMeta } from "@/lib/doc/settings";
import { insertImage, insertText } from "@/lib/editor/commands";
import { AgentPanel, type AgentPanelHandle } from "@/components/agent/AgentPanel";
import { IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { MenuButton, type MenuItem } from "@/components/ui/Menu";
import { toast, Toaster } from "@/components/ui/Toast";
import { InlineLogo } from "@/components/ui/Logo";
import { CommentsPanel } from "@/components/workspace/CommentsPanel";
import { FindBar } from "@/components/workspace/FindBar";
import { HistoryPanel } from "@/components/workspace/HistoryPanel";
import { documentMenus, MenuBar, type MenuActions } from "@/components/workspace/MenuBar";
import { OutlinePanel } from "@/components/workspace/OutlinePanel";
import { PageCanvas } from "@/components/workspace/PageCanvas";
import { PageSetupDialog } from "@/components/workspace/PageSetupDialog";
import { ReviewBar } from "@/components/workspace/ReviewBar";
import { EDITOR_MODES, modeMenuItems } from "@/components/workspace/modes";
import { COMPACT_QUERY, isCompact, useIsPhone, useMediaQuery, useVisualViewportVars } from "@/lib/client/viewport";
import { DEFAULT_PREFERENCES, preferences, setPreference } from "@/lib/client/preferences";
import { SelectionBubble } from "@/components/workspace/SelectionBubble";
import { ShortcutsDialog } from "@/components/workspace/ShortcutsDialog";
import { ContextMenu } from "@/components/workspace/ContextMenu";
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

  const [panel, setPanelState] = useState<Panel>("agent");
  const [panelWidth, setPanelWidth] = useState(420);
  const [zoom, setZoomState] = useState<Zoom>("fit");
  const [canvasWidth, setCanvasWidth] = useState(0);
  const canvasRef = useRef<HTMLElement>(null);
  const phone = useIsPhone();
  // Below this width the menu bar and labelled buttons fold into a "More" menu.
  const compact = useMediaQuery(COMPACT_QUERY);
  useVisualViewportVars();
  const [outline, setOutline] = useState(false);
  const [find, setFind] = useState<{ replace: boolean } | null>(null);
  const [linkEditing, setLinkEditing] = useState(false);
  const [draftComment, setDraftComment] = useState(false);
  const [setup, setSetup] = useState<{ tab: "page" | "text" | "header" } | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [counting, setCounting] = useState(false);
  const [charmap, setCharmap] = useState(false);
  const [focusMode, setFocusMode] = useState(false);

  useEffect(() => {
    // On phones and tablets a panel covers the document, so it only opens when asked for.
    if (isCompact()) setPanelState(initialAsk ? "agent" : null);
    else setPanelState(readStored<Panel>(PANEL_KEY, "agent", (raw) => (raw === "none" ? null : (["agent", "comments", "history"].includes(raw) ? (raw as Panel) : null))));
    setPanelWidth(readStored(PANEL_WIDTH_KEY, 420, (raw) => (Number(raw) >= 320 ? Math.min(760, Number(raw)) : null)));
    setZoomState(readStored<Zoom>(ZOOM_KEY, "fit", (raw) => (raw === "fit" ? "fit" : Number(raw) >= 0.5 && Number(raw) <= 2 ? Number(raw) : null)));
    setOutline(readStored(OUTLINE_KEY, false, (raw) => raw === "1"));
    setFocusMode(readStored(FOCUS_KEY, false, (raw) => raw === "1"));
  }, []);

  const setPanel = useCallback((next: Panel | ((current: Panel) => Panel)) => {
    setPanelState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      // Small screens always start without a panel, so don't overwrite the desktop choice.
      if (!isCompact()) store(PANEL_KEY, value ?? "none");
      return value;
    });
  }, []);

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

  const ui = useSyncExternalStore(session.ui.subscribe, session.ui.get, session.ui.get);
  const prefs = useSyncExternalStore(preferences.subscribe, preferences.get, () => DEFAULT_PREFERENCES);
  const state = useSyncExternalStore(session.editor.subscribe, session.editor.get, session.editor.get);
  const meta = ui.meta;

  useEffect(() => session.setFlow(phone), [session, phone]);
  const flow = ui.flow && !ui.printing && !ui.exporting;
  const canvasPad = canvasWidth && canvasWidth < 900 ? 16 : 40;
  const pageWidth = geometryFor(meta).pageWidth;
  const fitZoom = canvasWidth ? Math.max(0.5, Math.min(1, Math.floor(((canvasWidth - canvasPad * 2) / pageWidth) * 100) / 100)) : 1;
  const effectiveZoom = flow ? 1 : zoom === "fit" ? fitZoom : zoom;

  useEffect(() => {
    if (meta) document.title = `${meta.title} · Inline`;
  }, [meta]);

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

  const startComment = useCallback(() => {
    if (!session.view || session.view.state.selection.empty) {
      toast("Select the text you want to comment on.");
      return;
    }
    setPanel("comments");
    setDraftComment(true);
  }, [session, setPanel]);

  keyHandler.current = (name) => {
    if (name === "find" || name === "replace") setFind({ replace: name === "replace" });
    else if (name === "link") setLinkEditing(true);
    else if (name === "comment") startComment();
    else if (name === "askClaude") askClaude();
    return true;
  };

  const download = useCallback(
    async (format: "docx" | "pdf" | "md" | "html" | "txt") => {
      if (format === "pdf") {
        await session.exportPdf().catch((error: Error) => toast(`Couldn't export the PDF: ${error.message}`, { tone: "error" }));
        return;
      }
      await session.whenSaved();
      const link = document.createElement("a");
      link.href = `/api/documents/${documentId}/export?format=${format}`;
      link.download = "";
      document.body.append(link);
      link.click();
      link.remove();
    },
    [session, documentId],
  );

  commandHandler.current = (command) => {
    if (command.kind === "print") void session.print();
    else if (command.kind === "export_pdf") void session.exportPdf().catch((error: Error) => toast(`Couldn't export the PDF: ${error.message}`, { tone: "error" }));
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
  }, [askClaude, setPanel, session]);

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
    flow,
    toggleTheme,
    dark,
    toggleOutline: () =>
      setOutline((value) => {
        store(OUTLINE_KEY, value ? "0" : "1");
        return !value;
      }),
    toggleAgent: () => setPanel((current) => (current === "agent" ? null : "agent")),
    shortcuts: () => setShortcuts(true),
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
    substitutions: prefs.substitutions,
    toggleSubstitutions: () => {
      setPreference("substitutions", !prefs.substitutions);
      toast(prefs.substitutions ? "Automatic substitutions off." : "Automatic substitutions on.");
    },
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

  const words = state ? wordCount(docPlainText(state.doc)) : (meta?.wordCount ?? 0);
  const openComments = ui.comments.filter((comment) => !comment.resolved).length;
  const working = Boolean(ui.activity && ui.activity.status !== "idle");
  const downloads: MenuItem[] = [
    { label: "Word (.docx)", onSelect: () => void download("docx") },
    { label: "PDF", onSelect: () => void download("pdf") },
    { label: "Markdown (.md)", onSelect: () => void download("md") },
    { label: "Web page (.html)", onSelect: () => void download("html") },
    { label: "Plain text (.txt)", onSelect: () => void download("txt") },
  ];
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
      <header className="titlebar">
        <button type="button" className="icon-btn icon-btn-md" aria-label="All documents" data-tip="All documents" onClick={() => router.push("/")}>
          <ArrowLeft size={17} />
        </button>
        <InlineLogo />
        <div className="title-stack">
          <TitleInput meta={meta} onRename={(title) => void session.updateMeta({ title })} />
          <MenuBar session={session} actions={actions} zoom={effectiveZoom} hunks={ui.hunks.length} />
        </div>
        <div className="titlebar-status">
          <SyncStatus sync={ui.sync} connection={ui.connection} compact={compact} />
          {ui.activity && ui.activity.status !== "idle" && (
            <span className="presence-pill">
              <Sparkles size={12} />
              <span className="shimmer">{ui.activity.label || "Claude is working"}</span>
            </span>
          )}
        </div>
        {compact ? (
          <div className="titlebar-actions">
            <IconButton label="Comments" size="lg" active={panel === "comments"} onClick={() => setPanel((current) => (current === "comments" ? null : "comments"))}>
              <MessageSquare size={19} />
              {openComments > 0 && <span className="badge">{openComments}</span>}
            </IconButton>
            {!focusMode && (
              <IconButton label="Claude" size="lg" className={`claude-toggle${panel === "agent" ? " is-active" : ""}${working ? " is-working" : ""}`} onClick={() => setPanel((current) => (current === "agent" ? null : "agent"))}>
                <Sparkles size={19} />
              </IconButton>
            )}
            <MenuButton className="icon-btn icon-btn-lg" label="More options" title={meta?.title ?? "Document"} placement="bottom-end" items={moreItems}>
              <MoreHorizontal size={20} />
            </MenuButton>
          </div>
        ) : (
          <div className="titlebar-actions">
            <IconButton label={dark ? "Light theme" : "Dark theme"} onClick={toggleTheme}>
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </IconButton>
            <IconButton label="Version history" active={panel === "history"} onClick={() => setPanel((current) => (current === "history" ? null : "history"))}>
              <History size={16} />
            </IconButton>
            <IconButton label="Comments" active={panel === "comments"} onClick={() => setPanel((current) => (current === "comments" ? null : "comments"))}>
              <MessageSquare size={16} />
              {openComments > 0 && <span className="badge">{openComments}</span>}
            </IconButton>
            <MenuButton className="btn btn-secondary btn-md export-btn" label="Download" placement="bottom-end" items={downloads}>
              <Download size={15} />
              <span className="btn-label">Export</span>
            </MenuButton>
            <button
              type="button"
              className={`btn btn-md claude-toggle${panel === "agent" ? " is-active" : ""}`}
              onClick={() => setPanel((current) => (current === "agent" ? null : "agent"))}
              data-tip="Claude  ⌘J"
            >
              <Sparkles size={15} />
              <span className="btn-label">Claude</span>
            </button>
          </div>
        )}
      </header>

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
        {outline && <OutlinePanel session={session} state={state} />}
        <main
          ref={canvasRef}
          className="canvas"
          style={{ ["--canvas-pad" as string]: `${canvasPad}px` }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDrop={(event) => {
            const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("image/"));
            if (!file) return;
            event.preventDefault();
            void insertImageFile(file);
          }}
        >
          {find && <FindBar session={session} state={state} replace={find.replace} onClose={() => setFind(null)} />}
          {ui.status === "loading" && (
            <div className="canvas-loading">
              <Loader2 size={18} className="spin" />
            </div>
          )}
          <PageCanvas session={session} meta={meta} pages={ui.pages} zoom={effectiveZoom} printing={ui.printing} flow={flow} />
          <ReviewBar session={session} hunks={ui.hunks} />
          <SelectionBubble session={session} state={state} linkEditing={linkEditing} onLinkEditing={setLinkEditing} onAsk={() => askClaude()} onComment={startComment} />
        </main>

        {panel && phone && <div className="panel-backdrop" onClick={() => setPanel(null)} aria-hidden />}
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
                ref={agentRef}
                documentId={documentId}
                pendingChanges={ui.hunks.length}
                initialPrompt={initialAsk}
                onClose={() => setPanel(null)}
                onReview={(action) => {
                  if (action === "next") session.gotoChange(1);
                  else void session.review(action, "all");
                }}
              />
            )}
            {panel === "comments" && (
              <CommentsPanel
                session={session}
                comments={ui.comments}
                active={ui.activeComment}
                draft={draftComment}
                onDraftDone={() => setDraftComment(false)}
                onClose={() => setPanel(null)}
                onAskClaude={(comment) => {
                  setPanel("agent");
                  requestAnimationFrame(() =>
                    agentRef.current?.ask(null, `Address this comment (id ${comment.id}) on “${comment.quote}”: ${comment.body}\nThen reply to the comment saying what you changed and resolve it.`),
                  );
                }}
              />
            )}
            {panel === "history" && <HistoryPanel session={session} onClose={() => setPanel(null)} />}
          </div>
        )}
      </div>

      <footer className="statusbar">
        <button type="button" className="status-item" onClick={() => setCounting(true)}>
          {words.toLocaleString()} words
        </button>
        <span className="status-item">
          {ui.pages} page{ui.pages === 1 ? "" : "s"}
        </span>
        {ui.hunks.length > 0 && <span className="status-item is-accent">{ui.hunks.length} pending</span>}
        {ui.mode !== "editing" && (
          <button type="button" className={`status-item status-mode is-${ui.mode}`} onClick={() => void session.setMode("editing")} data-tip="Back to editing">
            {EDITOR_MODES[ui.mode].icon(13)} {EDITOR_MODES[ui.mode].label}
          </button>
        )}
        <span className="status-spacer" />
        <button type="button" className="status-item" onClick={() => setShortcuts(true)}>
          Shortcuts
        </button>
        <span className="status-item">{Math.round(effectiveZoom * 100)}%</span>
        <button type="button" className={`status-item status-claude${panel === "agent" ? " is-active" : ""}`} onClick={() => setPanel((current) => (current === "agent" ? null : "agent"))}>
          <PanelRight size={13} /> Claude
        </button>
      </footer>

      <PageSetupDialog open={Boolean(setup)} initialTab={setup?.tab} session={session} settings={meta?.settings} onClose={() => setSetup(null)} />
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
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
    </div>
  );
}

function TitleInput({ meta, onRename }: { meta: DocumentMeta | null; onRename: (title: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? meta?.title ?? "";
  return (
    <input
      className="title-input"
      aria-label="Document title"
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

function PanelResizer({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      onPointerDown={(event) => {
        const startX = event.clientX;
        const start = width;
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => onResize(Math.max(320, Math.min(760, start + (startX - moveEvent.clientX))));
        const up = () => {
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", up);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
      }}
    />
  );
}

function WordCountDialog({ open, onClose, session }: { open: boolean; onClose: () => void; session: DocumentSession }) {
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
    <Dialog open={open} onClose={onClose} title="Word count" width={420}>
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
    </Dialog>
  );
}

