"use client";

import { Check, CircleDashed, Copy, FolderTree, History, Loader2, MessageSquarePlus, Plus, RefreshCw, Terminal, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { shortToolName, type Attachment, type ChatMessage, type DocumentMention, type ChatSettings, type LinkedDocument, type SelectionContext, type Todo } from "@/lib/agent/types";
import { formatChatHistory, formatPromptTurn, turnForMessage } from "@/lib/agent/devCopy";
import { ActivityLine, isWaiting } from "@/components/agent/Activity";
import { refreshAgentStatus, useAgentStatus } from "@/lib/client/agentStatus";
import { acquireChat, ChatSession, newChatId, peekChat, releaseChat, rememberChat, rememberedChat, warmChat, type ChatUiState } from "@/lib/client/chatSession";
import { Composer, type ComposerHandle } from "@/components/agent/Composer";
import { MessageList, type TurnHunk } from "@/components/agent/MessageView";
import { Button, IconButton } from "@/components/ui/Button";
import { ChatHistory } from "@/components/agent/ChatHistory";
import { UsageMeter } from "@/components/agent/UsageMeter";
import { Dialog } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { api, post } from "@/lib/client/api";
import { loadDraftSelection, saveDraftSelection } from "@/lib/client/drafts";
import { promptTexts } from "@/lib/client/promptHistory";
import { loadPreferences, preferences } from "@/lib/client/preferences";

export type AgentPanelHandle = {
  ask: (selection: SelectionContext | null, text?: string) => void;
  /** Send a message right away (the inline ⌘⇧K prompt). */
  send: (selection: SelectionContext | null, text: string) => Promise<void>;
  /** The user is about to send something: start Claude Code now. */
  warm: () => void;
  /** Show a chat that was started elsewhere (Claude converting an imported PDF). */
  openChat: (chatId: string) => void;
};

const NO_HUNKS: ReadonlyArray<TurnHunk> = [];
/** Where the home page's open chat is remembered. */
const HOME_CHAT_KEY = "home";

const EMPTY_UI: ChatUiState = { chat: null, connected: false, error: null, rateLimit: null };
const emptyStore = { subscribe: () => () => undefined, get: () => EMPTY_UI };

const SUGGESTIONS = [
  { label: "Proofread", prompt: "Proofread the document and fix spelling, grammar and punctuation. Don't change the meaning or voice." },
  { label: "Tighten", prompt: "Tighten the writing: cut filler and repetition, and make sentences clearer without losing anything important." },
  { label: "Give feedback", prompt: "Read the document and give me your three most important suggestions to improve it. Don't edit yet." },
  { label: "Outline", prompt: "Draft an outline for this document based on what's here so far." },
  { label: "Continue writing", prompt: "Continue writing from where the document leaves off, matching its style." },
  { label: "Format nicely", prompt: "Improve the formatting: consistent headings, lists where they help, and clean spacing. Don't change the wording." },
];

/** Starting points on the home page, where Claude organizes rather than edits. */
const HOME_SUGGESTIONS = [
  {
    label: "Organize my Google Docs import",
    prompt:
      'Review all my documents and organize them into clear, well-named folders based on their content. Add two separate folders: "To Delete" for documents I probably don\'t need and "Misc" for ones that don\'t fit anywhere else.',
  },
  { label: "Sort everything into folders", prompt: "Sort my documents into folders. Use a few clear folders with plain names, and keep any folders I already have." },
  { label: "File what's unfiled", prompt: "File the documents that aren't in a folder yet into my existing folders, making a new folder only where nothing fits." },
  { label: "Suggest folders first", prompt: "Look through my documents and suggest a folder structure. Don't move anything yet; show me the plan first." },
  { label: "Find a document", prompt: "Help me find the document about " },
];

/** Tools that change the folders or the document list, after which the home page reloads. */
const LIBRARY_TOOLS = /__(move_documents|create_folder|update_folder|delete_folder|create_document)$/;

const readChatId = rememberedChat;
const writeChatId = rememberChat;

/** Chats already checked to still exist, this page load. */
const fresh = new Set<string>();

export const AgentPanel = forwardRef<
  AgentPanelHandle,
  {
    /** The open document; null on the home page. */
    documentId: string | null;
    /** Where the open chat is remembered: the document's first tab, so every tab shares it. */
    chatKey?: string;
    hunks?: ReadonlyArray<TurnHunk>;
    onClose: () => void;
    onReview?: (action: "next" | "accept" | "reject", ids: string[]) => void;
    initialPrompt?: string | null;
    /** On the home page: the folder the user is looking at, told to Claude with each message. */
    home?: { folderId: string | null };
    /** Claude changed folders or documents (home page): time to reload the list. */
    onLibraryChange?: () => void;
    /** Word and page counts for the open document, shown on the latest turn's usage line. */
    documentCounts?: ReactNode;
  }
>(function AgentPanel({ documentId, chatKey: chatKeyProp, hunks = NO_HUNKS, onClose, onReview, initialPrompt, home, onLibraryChange, documentCounts }, ref) {
  const chatKey = chatKeyProp ?? documentId ?? HOME_CHAT_KEY;
  const draftKey = documentId ?? HOME_CHAT_KEY;
  const { status, defaults } = useAgentStatus();
  const router = useRouter();
  const [chatId, setChatId] = useState<string | null>(() => (typeof window === "undefined" ? null : readChatId(chatKey)));
  // A chat that is already open shows straight away, with nothing to load.
  const [session, setSession] = useState<ChatSession | null>(() => (chatId ? peekChat(chatId) : null));
  const [draftSettings, setDraftSettings] = useState<ChatSettings | null>(null);
  // The quoted selection is part of the unsent message: it survives closing the panel.
  const [selection, setSelection] = useState<SelectionContext | null>(() => (typeof window === "undefined" ? null : loadDraftSelection(draftKey)));
  useEffect(() => saveDraftSelection(draftKey, selection), [draftKey, selection]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // The composer floats over the thread, so the scroller keeps a pad of the same height.
  const [footerSpace, setFooterSpace] = useState(0);
  const prompted = useRef(false);

  /** A session the panel created for a new chat; it is already showing the first message. */
  const created = useRef<ChatSession | null>(null);
  /** The id the next new chat will use, picked early so it can be warmed up while the user types. */
  const draftId = useRef<string | null>(null);

  useEffect(() => {
    if (!chatId) {
      setSession(null);
      return;
    }
    const next = acquireChat(chatId, created.current?.id === chatId ? created.current : undefined);
    created.current = null;
    setSession(next);
    writeChatId(chatKey, chatId);
    return () => releaseChat(next);
  }, [chatId, chatKey]);

  const store = session?.ui ?? emptyStore;
  const ui = useSyncExternalStore(store.subscribe, store.get, () => EMPTY_UI);
  const chat = ui.chat;

  // A chat id remembered from an earlier session may have been deleted.
  useEffect(() => {
    if (!chatId || fresh.has(chatId)) return;
    let cancelled = false;
    fetch(`/api/agent/chats/${chatId}`, { method: "HEAD" }).then((response) => {
      if (response.ok) fresh.add(chatId);
      if (!cancelled && response.status === 404) {
        writeChatId(chatKey, null);
        setChatId(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, chatKey]);

  const settings: ChatSettings = chat?.settings ?? draftSettings ?? defaults ?? { model: null, effort: "medium", mode: "agent" };
  const models = status?.state === "ready" ? status.models : [];
  const ready = status?.state === "ready";

  useImperativeHandle(ref, () => ({
    ask: (next, text) => {
      if (next) setSelection(next);
      if (text) composer.current?.setText(text);
      else composer.current?.focus();
    },
    send: (selected, text) => send({ text, attachments: [], selected }),
    warm,
    openChat: (id) => setChatId(id),
  }));

  useEffect(() => {
    if (initialPrompt && !prompted.current) {
      prompted.current = true;
      composer.current?.setText(initialPrompt);
    }
  }, [initialPrompt]);

  // Keep the newest content in view while streaming, unless the user scrolled up.
  // Only when the chat changed: reading scrollHeight forces a layout, which is costly next to a long document.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [chat, ui.error, footerSpace]);
  useEffect(() => {
    const node = footer.current;
    if (!node) return;
    const measure = () => setFooterSpace((current) => (current === node.offsetHeight ? current : node.offsetHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const warm = useCallback(() => {
    if (!ready) return;
    if (chatId) {
      warmChat({ id: chatId, exists: true, documentId, settings });
      return;
    }
    draftId.current ??= newChatId();
    warmChat({ id: draftId.current, exists: false, documentId, settings });
  }, [ready, chatId, documentId, settings]);

  const send = useCallback(
    async ({ text, attachments, mentions, links, selected }: { text: string; attachments: Attachment[]; mentions?: DocumentMention[]; links?: LinkedDocument[]; selected?: SelectionContext | null }) => {
      stick.current = true;
      if (!documentId) expectOpen.current = true;
      const input = { text, documentId, selection: (selected === undefined ? selection : selected) ?? undefined, attachments, mentions: mentions?.length ? mentions : undefined, links: links?.length ? links : undefined, home: homeRef.current };
      setSelection(null);
      try {
        if (session) {
          await session.send(input);
          return;
        }
        // A new chat: show it with the message right away, and create it and send in one request.
        const id = draftId.current ?? newChatId();
        draftId.current = null;
        const next = new ChatSession(id);
        next.onOpen = (docId) => openMatch.current(docId);
        created.current = next;
        fresh.add(id);
        setChatId(id);
        await next.create(input, settings);
      } catch (error) {
        setSelection(input.selection ?? null);
        throw error;
      }
    },
    [session, documentId, settings, selection],
  );

  const homeRef = useRef(home);
  homeRef.current = home;
  /** This page asked the home assistant to do something, so a new open_document should show the document. */
  const expectOpen = useRef(false);

  // Each folder or document change Claude finishes reloads the home page's list, once.
  const libraryChanges = chat?.messages.reduce((count, message) => count + (message.role === "assistant" ? message.parts.filter((part) => part.type === "tool" && part.status === "done" && LIBRARY_TOOLS.test(part.name)).length : 0), 0) ?? 0;
  const seenChanges = useRef<{ chatId: string; count: number } | null>(null);
  const libraryRef = useRef(onLibraryChange);
  libraryRef.current = onLibraryChange;
  const loadedChatId = chat?.id;
  useEffect(() => {
    if (!loadedChatId) return;
    // A chat that just loaded sets the baseline; only changes after that count.
    const last = seenChanges.current;
    if (last?.chatId === loadedChatId && libraryChanges > last.count) libraryRef.current?.();
    seenChanges.current = { chatId: loadedChatId, count: libraryChanges };
  }, [loadedChatId, libraryChanges]);

  // open_document from the home page. The turn can finish before the event stream
  // connects, so this also reads the tool call in the chat snapshot, not only the live event.
  const opened = useMemo(() => {
    let count = 0;
    let id: string | null = null;
    for (const message of chat?.messages ?? []) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (part.type !== "tool" || part.status !== "done" || shortToolName(part.name) !== "open_document") continue;
        const documentId = part.input?.document_id;
        if (typeof documentId !== "string" || !documentId) continue;
        count += 1;
        id = documentId;
      }
    }
    return { count, id };
  }, [chat]);
  const seenOpens = useRef<{ chatId: string; count: number } | null>(null);
  useEffect(() => {
    if (documentId || !loadedChatId) return;
    const last = seenOpens.current;
    const grew = last?.chatId === loadedChatId && opened.count > last.count;
    if (expectOpen.current && opened.id && (grew || (!last && opened.count > 0))) {
      expectOpen.current = false;
      router.push(`/d/${opened.id}`);
    }
    seenOpens.current = { chatId: loadedChatId, count: opened.count };
  }, [documentId, loadedChatId, opened.count, opened.id, router]);

  const updateSettings = (patch: Partial<ChatSettings>) => {
    if (session) void session.update({ settings: patch });
    else setDraftSettings({ ...settings, ...patch });
  };

  // Stable callbacks, so replies that didn't change don't re-render while another streams.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // Home has no editor listening for open_document, so the chat event opens the match.
  const openMatch = useRef<(id: string) => void>(() => undefined);
  openMatch.current = (id) => {
    if (!documentId) router.push(`/d/${id}`);
  };
  useEffect(() => {
    if (!session) return;
    session.onOpen = (id) => openMatch.current(id);
    return () => {
      session.onOpen = null;
    };
  }, [session]);
  const reviewRef = useRef(onReview);
  reviewRef.current = onReview;
  const retry = useCallback(() => void sessionRef.current?.retry(), []);
  const review = useCallback((action: "next" | "accept" | "reject", ids: string[]) => reviewRef.current?.(action, ids), []);
  useEffect(() => {
    loadPreferences();
  }, []);
  const devOptions = useSyncExternalStore(preferences.subscribe, () => preferences.get().devOptions, () => false);
  const copyTurn = useCallback((messageId: string) => {
    const messages = sessionRef.current?.ui.get().chat?.messages;
    if (!messages) return;
    const turn = turnForMessage(messages, messageId);
    if (!turn) return;
    void writeClipboard(formatPromptTurn(turn), "Copied this turn.");
  }, []);
  const copyHistory = useCallback(() => {
    const messages = sessionRef.current?.ui.get().chat?.messages;
    if (!messages?.length) return;
    void writeClipboard(formatChatHistory(messages), "Copied the chat history.");
  }, []);

  const [rewinding, setRewinding] = useState<{ versionId: string; messageId: string } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const restore = async () => {
    if (!rewinding || !chatId) return;
    setRestoring(true);
    try {
      const result = await post<{ text: string }>(`/api/agent/chats/${chatId}/rewind`, { messageId: rewinding.messageId, documentId, versionId: rewinding.versionId });
      setRewinding(null);
      if (result.text) composer.current?.setText(result.text);
      toast(result.text ? "Restored. Your message is back in the box to change or send again." : "Restored. The text before restoring is in version history.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't restore that version.", { tone: "error" });
    } finally {
      setRestoring(false);
    }
  };

  const todos = chat?.todos ?? [];
  const showTodos = todos.length > 0 && (chat?.running || todos.some((todo) => todo.status !== "completed"));

  return (
    <aside className="agent-panel" aria-label="Claude">
      <header className="panel-header">
        <div className="panel-title">
          <span className="panel-title-text">{chat?.title && chat.messages.length ? chat.title : "New chat"}</span>
        </div>
        <div className="panel-actions">
          {devOptions && chat && chat.messages.length > 0 && (
            <IconButton label="Copy chat history" size="sm" onClick={copyHistory}>
              <Copy size={15} />
            </IconButton>
          )}
          <IconButton ref={historyButton} label="Chat history" size="sm" active={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>
            <History size={15} />
          </IconButton>
          <IconButton
            label="New chat"
            size="sm"
            onClick={() => {
              setChatId(null);
              writeChatId(chatKey, null);
              setSelection(null);
              composer.current?.focus();
            }}
          >
            <Plus size={16} />
          </IconButton>
          <IconButton label="Close panel" size="sm" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <ChatHistory
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          anchor={historyButton}
          documentId={documentId}
          currentChatId={chatId}
          onOpenChat={setChatId}
          onOpenElsewhere={(otherDocument, otherChat) => {
            // Open the other document with this chat showing in its panel.
            writeChatId(otherDocument, otherChat);
            router.push(`/d/${otherDocument}`);
          }}
          onDeleted={(deleted) => {
            if (deleted === chatId) setChatId(null);
          }}
        />
      </header>

      <div
        ref={scroller}
        className="panel-scroll"
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {status && !ready ? (
          <Onboarding state={status.state} message={"message" in status ? status.message : ""} />
        ) : chat?.messages.length ? (
          <div className="messages">
            <MessageList messages={chat.messages} hunks={hunks} onRetry={retry} onReview={review} documentId={documentId ?? undefined} onRestore={(versionId, messageId) => setRewinding({ versionId, messageId })} onCopyTurn={devOptions ? copyTurn : undefined} documentCounts={documentCounts} />
            {chat.running && isWaiting(chat.status, lastAssistant(chat.messages)) && <ActivityLine status={chat.status} message={lastAssistant(chat.messages)} since={lastSent(chat.messages)} />}
          </div>
        ) : chatId && !chat && !ui.error ? (
          // The chat is still loading: hold its place rather than flash the new-chat screen.
          <div className="chat-loading" aria-busy="true" aria-label="Loading chat">
            <span />
            <span />
            <span />
          </div>
        ) : (
          <EmptyState home={!documentId} onPick={(prompt) => composer.current?.setText(prompt)} />
        )}
        <div className="panel-scroll-pad" style={{ height: footerSpace }} aria-hidden />
      </div>

      <div className="panel-footer" ref={footer}>
        {showTodos && <TodoList todos={todos} running={Boolean(chat?.running)} />}
        {chat && chat.queue.length > 0 && (
          <div className="queue">
            {chat.queue.map((item) => (
              <div key={item.id} className="queue-item">
                <CircleDashed size={13} />
                <span className="queue-text">{item.text}</span>
                <button type="button" className="chip-x" aria-label="Remove from queue" onClick={() => session?.removeQueued(item.id)}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {ui.error && <div className="panel-error">{ui.error}</div>}
        {ui.rateLimit && ui.rateLimit.status !== "allowed" && (
          <div className="panel-warning">
            {ui.rateLimit.status === "rejected" ? "You've reached your Claude usage limit" : "You're close to your Claude usage limit"}
            {ui.rateLimit.resetsAt ? `; it resets at ${new Date(ui.rateLimit.resetsAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : "."}
          </div>
        )}
        <Composer
          ref={composer}
          running={Boolean(chat?.running)}
          disabled={status ? !ready : false}
          disabledReason={status && !ready ? "Connect Claude Code to start" : undefined}
          settings={settings}
          models={models}
          meter={<UsageMeter chat={chat} running={Boolean(chat?.running)} usageLimit={settings.usageLimit ?? null} onUsageLimit={(usageLimit) => updateSettings({ usageLimit })} />}
          selection={selection}
          documentId={documentId}
          onClearSelection={() => setSelection(null)}
          onSend={send}
          onStop={() => void session?.interrupt()}
          onSettings={updateSettings}
          onWarm={warm}
          prompts={promptTexts(chat?.messages ?? [], chat?.queue ?? [])}
          historyKey={chat?.id ?? chatId}
        />
      </div>
      <Dialog
        open={rewinding !== null}
        onClose={() => setRewinding(null)}
        title="Restore to before this reply?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRewinding(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={restoring} onClick={() => void restore()}>
              Restore
            </Button>
          </>
        }
      >
        <p>The document goes back to how it was before this reply&apos;s edits, and the chat rewinds to before your message, so Claude forgets it too. What you have now is not saved as a version unless you saved one.</p>
      </Dialog>
    </aside>
  );
});

/** Copies text already in the chat. The transcript is not written anywhere else. */
function writeClipboard(text: string, success: string) {
  return navigator.clipboard.writeText(text).then(
    () => toast(success, { tone: "success" }),
    () => toast("Couldn't copy to the clipboard.", { tone: "error" }),
  );
}

function lastAssistant(messages: ChatMessage[]) {
  const last = messages[messages.length - 1];
  return last?.role === "assistant" ? last : undefined;
}

function lastSent(messages: ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]!.role === "user") return messages[i]!.createdAt;
  return undefined;
}

function TodoList({ todos, running }: { todos: Todo[]; running: boolean }) {
  const [open, setOpen] = useState(true);
  const done = todos.filter((todo) => todo.status === "completed").length;
  // Once Claude stops, an unfinished step is no longer in progress: no spinner.
  const active = running ? todos.find((todo) => todo.status === "in_progress") : undefined;
  return (
    <div className="todos">
      <button type="button" className="todos-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>{active ? (active.activeForm ?? active.content) : "Plan"}</span>
        <span className="todos-count">
          {done}/{todos.length}
        </span>
      </button>
      {open && (
        <ol className="todos-list">
          {todos.map((todo, index) => (
            <li key={index} className={`todo is-${todo.status === "in_progress" && !running ? "pending" : todo.status}`}>
              <span className="todo-mark">{todo.status === "completed" ? <Check size={12} /> : todo.status === "in_progress" && running ? <Loader2 size={12} className="spin" /> : null}</span>
              <span>{todo.content}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function EmptyState({ home, onPick }: { home: boolean; onPick: (prompt: string) => void }) {
  return (
    <div className="panel-empty">
      <div className="panel-empty-mark">{home ? <FolderTree size={22} /> : <MessageSquarePlus size={22} />}</div>
      <h3>{home ? "Organize with Claude" : "Write with Claude"}</h3>
      <p>
        {home
          ? "Tell Claude how you'd like your documents sorted. It reads titles and the first lines of each document, not whole documents, so sorting a big library stays light on your usage."
          : "Claude reads and edits this document directly. Every change shows up highlighted so you can keep or undo it."}
      </p>
      <div className="suggestions">
        {(home ? HOME_SUGGESTIONS : SUGGESTIONS).map((item) => (
          <button key={item.label} type="button" className="suggestion" onClick={() => onPick(item.prompt)}>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Onboarding({ state, message }: { state: "signed_out" | "unavailable"; message: string }) {
  const [checking, setChecking] = useState(false);
  const signedOut = state === "signed_out";
  return (
    <div className="onboarding">
      <div className="panel-empty-mark">
        <Terminal size={22} />
      </div>
      <h3>{signedOut ? "Sign in to Claude" : "Claude Code isn't available"}</h3>
      <p>
        Inline&apos;s agent runs on Claude Code with your own Claude account, so there are no API keys to manage.
        {state === "unavailable" && message ? ` ${message}` : ""}
      </p>
      {signedOut && <SignIn />}
      <details className="onboarding-terminal" open={!signedOut}>
        <summary>{signedOut ? "Or sign in from a terminal" : "Set up Claude Code"}</summary>
        <ol className="onboarding-steps">
          <li>
            Open a terminal on the machine running Inline and run <code>claude</code>.
          </li>
          <li>
            Type <code>/login</code> and sign in with your Claude account.
          </li>
          <li>Come back here and check again.</li>
        </ol>
        <Button
          variant={signedOut ? "secondary" : "primary"}
          icon={<RefreshCw size={14} />}
          loading={checking}
          onClick={async () => {
            setChecking(true);
            await refreshAgentStatus(true);
            setChecking(false);
          }}
        >
          Check again
        </Button>
      </details>
    </div>
  );
}

type LoginState = { state: "idle" } | { state: "waiting"; url: string | null } | { state: "done" } | { state: "failed"; message: string };

/** Signs in with `claude auth login` on the computer running Inline: the sign-in page opens in the browser and this follows along. */
function SignIn() {
  const [login, setLogin] = useState<LoginState>({ state: "idle" });
  const [starting, setStarting] = useState(false);
  const [code, setCode] = useState("");
  const waiting = login.state === "waiting";

  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const result = await api<{ login: LoginState }>("/api/agent/login");
        if (cancelled) return;
        setLogin(result.login);
        if (result.login.state === "done") await refreshAgentStatus(true);
      } catch {
        // the next poll tries again
      }
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [waiting]);

  const start = async () => {
    setStarting(true);
    try {
      const result = await post<{ login: LoginState }>("/api/agent/login", { action: "start" });
      setLogin(result.login);
    } catch (error) {
      setLogin({ state: "failed", message: error instanceof Error ? error.message : "Couldn't start signing in." });
    } finally {
      setStarting(false);
    }
  };

  if (login.state === "waiting") {
    return (
      <div className="signin">
        <p className="signin-status">
          <Loader2 size={14} className="spin" /> Finish signing in in your browser.
        </p>
        {login.url && (
          <a className="btn btn-secondary btn-sm" href={login.url} target="_blank" rel="noopener noreferrer">
            Open the sign-in page again
          </a>
        )}
        <form
          className="signin-code"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!code.trim()) return;
            try {
              setLogin((await post<{ login: LoginState }>("/api/agent/login", { action: "code", code })).login);
              setCode("");
            } catch (error) {
              toast(error instanceof Error ? error.message : "Couldn't send the code.");
            }
          }}
        >
          <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Shown a code? Paste it here" aria-label="Sign-in code" />
          <Button size="sm" type="submit" disabled={!code.trim()}>
            Continue
          </Button>
        </form>
        <button type="button" className="link-button" onClick={() => void post("/api/agent/login", { action: "cancel" }).then(() => setLogin({ state: "idle" }))}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="signin">
      <Button variant="primary" loading={starting || login.state === "done"} onClick={start}>
        Sign in with Claude
      </Button>
      {login.state === "failed" && <p className="signin-error">{login.message}</p>}
    </div>
  );
}
