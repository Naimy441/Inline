"use client";

import { Check, CircleDashed, History, Loader2, MessageSquarePlus, Plus, RefreshCw, Terminal, Trash2, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Attachment, ChatSettings, ChatSummary, SelectionContext, Todo } from "@/lib/agent/types";
import { refreshAgentStatus, useAgentStatus } from "@/lib/client/agentStatus";
import { ChatSession, chatApi, type ChatUiState } from "@/lib/client/chatSession";
import { Composer, type ComposerHandle } from "@/components/agent/Composer";
import { MessageList } from "@/components/agent/MessageView";
import { Button, IconButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";

export type AgentPanelHandle = { ask: (selection: SelectionContext | null, text?: string) => void };

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

function storageKey(documentId: string) {
  return `inline-chat:${documentId}`;
}

function readChatId(documentId: string) {
  try {
    return localStorage.getItem(storageKey(documentId));
  } catch {
    return null;
  }
}

function writeChatId(documentId: string, chatId: string | null) {
  try {
    if (chatId) localStorage.setItem(storageKey(documentId), chatId);
    else localStorage.removeItem(storageKey(documentId));
  } catch {
    // ignore
  }
}

export const AgentPanel = forwardRef<
  AgentPanelHandle,
  {
    documentId: string;
    pendingChanges: number;
    onClose: () => void;
    onReview: (action: "next" | "accept" | "reject") => void;
    initialPrompt?: string | null;
  }
>(function AgentPanel({ documentId, pendingChanges, onClose, onReview, initialPrompt }, ref) {
  const { status, defaults } = useAgentStatus();
  const [chatId, setChatId] = useState<string | null>(() => (typeof window === "undefined" ? null : readChatId(documentId)));
  const [session, setSession] = useState<ChatSession | null>(null);
  const [draftSettings, setDraftSettings] = useState<ChatSettings | null>(null);
  const [selection, setSelection] = useState<SelectionContext | null>(null);
  const [history, setHistory] = useState<ChatSummary[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prompted = useRef(false);

  useEffect(() => {
    if (!chatId) {
      setSession(null);
      return;
    }
    const next = new ChatSession(chatId);
    next.connect();
    setSession(next);
    writeChatId(documentId, chatId);
    return () => next.close();
  }, [chatId, documentId]);

  const store = session?.ui ?? emptyStore;
  const ui = useSyncExternalStore(store.subscribe, store.get, () => EMPTY_UI);
  const chat = ui.chat;

  // A chat id remembered from an earlier session may have been deleted.
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    fetch(`/api/agent/chats/${chatId}`).then((response) => {
      if (!cancelled && response.status === 404) {
        writeChatId(documentId, null);
        setChatId(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, documentId]);

  const settings: ChatSettings = chat?.settings ?? draftSettings ?? defaults ?? { model: null, effort: "medium", mode: "agent" };
  const models = status?.state === "ready" ? status.models : [];
  const ready = status?.state === "ready";

  useImperativeHandle(ref, () => ({
    ask: (next, text) => {
      if (next) setSelection(next);
      if (text) composer.current?.setText(text);
      else composer.current?.focus();
    },
  }));

  useEffect(() => {
    if (initialPrompt && !prompted.current) {
      prompted.current = true;
      composer.current?.setText(initialPrompt);
    }
  }, [initialPrompt]);

  // Keep the newest content in view while streaming, unless the user scrolled up.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  });

  const send = useCallback(
    async ({ text, attachments }: { text: string; attachments: Attachment[] }) => {
      let target = session;
      if (!target) {
        const created = await chatApi.create({ documentId, settings });
        target = new ChatSession(created.id);
        setChatId(created.id);
      }
      stick.current = true;
      await target.send({ text, documentId, selection: selection ?? undefined, attachments });
      setSelection(null);
    },
    [session, documentId, settings, selection],
  );

  const updateSettings = (patch: Partial<ChatSettings>) => {
    if (session) void session.update({ settings: patch });
    else setDraftSettings({ ...settings, ...patch });
  };

  const openHistory = async () => {
    setHistoryOpen(true);
    setHistory(await chatApi.list(documentId).catch(() => []));
  };

  const todos = chat?.todos ?? [];
  const showTodos = todos.length > 0 && (chat?.running || todos.some((todo) => todo.status !== "completed"));

  const historyItems = useMemo(
    () =>
      history === null
        ? [{ kind: "label" as const, label: "Loading…" }]
        : history.length === 0
          ? [{ kind: "label" as const, label: "No earlier chats for this document" }]
          : [
              { kind: "label" as const, label: "Chats for this document" },
              ...history.slice(0, 20).map((item) => ({
                label: item.title,
                hint: item.preview,
                checked: item.id === chatId,
                onSelect: () => setChatId(item.id),
                submenu: [
                  { label: "Open", onSelect: () => setChatId(item.id) },
                  {
                    label: "Delete chat",
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onSelect: () => {
                      void chatApi.remove(item.id).then(() => {
                        if (item.id === chatId) setChatId(null);
                      });
                    },
                  },
                ],
              })),
            ],
    [history, chatId],
  );

  return (
    <aside className="agent-panel" aria-label="Claude">
      <header className="panel-header">
        <div className="panel-title">
          <span className="panel-title-text">{chat?.title && chat.messages.length ? chat.title : "New chat"}</span>
          {chat?.running && <Loader2 size={13} className="spin muted" />}
        </div>
        <div className="panel-actions">
          <IconButton ref={historyButton} label="Chat history" size="sm" onClick={() => void openHistory()}>
            <History size={15} />
          </IconButton>
          <IconButton
            label="New chat"
            size="sm"
            onClick={() => {
              setChatId(null);
              writeChatId(documentId, null);
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
        <Menu open={historyOpen} onClose={() => setHistoryOpen(false)} anchor={historyButton} items={historyItems} placement="bottom-end" className="history-menu" />
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
            <MessageList messages={chat.messages} pendingChanges={pendingChanges} onRetry={() => session?.retry()} onReview={onReview} />
            {chat.running && chat.status && <RunStatusLine status={chat.status} />}
          </div>
        ) : (
          <EmptyState onPick={(prompt) => composer.current?.setText(prompt)} />
        )}
      </div>

      <div className="panel-footer">
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
          context={chat?.context}
          selection={selection}
          onClearSelection={() => setSelection(null)}
          onSend={send}
          onStop={() => void session?.interrupt()}
          onSettings={updateSettings}
        />
      </div>
    </aside>
  );
});

function RunStatusLine({ status }: { status: NonNullable<import("@/lib/agent/types").ChatState["status"]> }) {
  let text = "";
  if (status.kind === "starting") text = "Starting Claude Code…";
  else if (status.kind === "retrying") text = `${status.error} Retrying (${status.attempt}/${status.maxRetries})…`;
  else if (status.kind === "compacting") text = "Summarizing earlier messages to free up context…";
  if (!text) return null;
  return <div className="run-status shimmer">{text}</div>;
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

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="panel-empty">
      <div className="panel-empty-mark">
        <MessageSquarePlus size={22} />
      </div>
      <h3>Write with Claude</h3>
      <p>Claude reads and edits this document directly. Every change shows up highlighted so you can keep or undo it.</p>
      <div className="suggestions">
        {SUGGESTIONS.map((item) => (
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
  return (
    <div className="onboarding">
      <div className="panel-empty-mark">
        <Terminal size={22} />
      </div>
      <h3>{state === "signed_out" ? "Sign in to Claude Code" : "Claude Code isn't available"}</h3>
      <p>
        Inline&apos;s agent runs on Claude Code with your own Claude account, so there are no API keys to manage.
        {state === "unavailable" && message ? ` ${message}` : ""}
      </p>
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
        variant="primary"
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
    </div>
  );
}
