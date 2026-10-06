"use client";

import { Check, CircleDashed, History, Loader2, MessageSquarePlus, Plus, RefreshCw, Terminal, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Attachment, ChatMessage, DocumentMention, ChatSettings, SelectionContext, Todo } from "@/lib/agent/types";
import { ActivityLine, isWaiting } from "@/components/agent/Activity";
import { refreshAgentStatus, useAgentStatus } from "@/lib/client/agentStatus";
import { ChatSession, newChatId, warmChat, type ChatUiState } from "@/lib/client/chatSession";
import { Composer, type ComposerHandle } from "@/components/agent/Composer";
import { MessageList, type TurnHunk } from "@/components/agent/MessageView";
import { Button, IconButton } from "@/components/ui/Button";
import { ChatHistory } from "@/components/agent/ChatHistory";
import { UsageMeter } from "@/components/agent/UsageMeter";
import { Dialog } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { post } from "@/lib/client/api";
import { loadDraftSelection, saveDraftSelection } from "@/lib/client/drafts";

export type AgentPanelHandle = {
  ask: (selection: SelectionContext | null, text?: string) => void;
  /** Send a message right away (the inline ⌘K prompt). */
  send: (selection: SelectionContext | null, text: string) => Promise<void>;
  /** The user is about to send something: start Claude Code now. */
  warm: () => void;
};

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
    hunks: ReadonlyArray<TurnHunk>;
    onClose: () => void;
    onReview: (action: "next" | "accept" | "reject", ids: string[]) => void;
    initialPrompt?: string | null;
  }
>(function AgentPanel({ documentId, hunks, onClose, onReview, initialPrompt }, ref) {
  const { status, defaults } = useAgentStatus();
  const router = useRouter();
  const [chatId, setChatId] = useState<string | null>(() => (typeof window === "undefined" ? null : readChatId(documentId)));
  const [session, setSession] = useState<ChatSession | null>(null);
  const [draftSettings, setDraftSettings] = useState<ChatSettings | null>(null);
  // The quoted selection is part of the unsent message: it survives closing the panel.
  const [selection, setSelection] = useState<SelectionContext | null>(() => (typeof window === "undefined" ? null : loadDraftSelection(documentId)));
  useEffect(() => saveDraftSelection(documentId, selection), [documentId, selection]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
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
    const next = created.current?.id === chatId ? created.current : new ChatSession(chatId);
    created.current = null;
    next.connect();
    setSession(next);
    writeChatId(documentId, chatId);
    return () => next.close();
  }, [chatId, documentId]);

  const store = session?.ui ?? emptyStore;
  const ui = useSyncExternalStore(store.subscribe, store.get, () => EMPTY_UI);
  const chat = ui.chat;

  // A chat id remembered from an earlier session may have been deleted.
  const fresh = useRef(new Set<string>());
  useEffect(() => {
    if (!chatId || fresh.current.has(chatId)) return;
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
    send: (selected, text) => send({ text, attachments: [], selected }),
    warm,
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
  }, [chat, ui.error]);

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
    async ({ text, attachments, mentions, selected }: { text: string; attachments: Attachment[]; mentions?: DocumentMention[]; selected?: SelectionContext | null }) => {
      stick.current = true;
      const input = { text, documentId, selection: (selected === undefined ? selection : selected) ?? undefined, attachments, mentions: mentions?.length ? mentions : undefined };
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
        created.current = next;
        fresh.current.add(id);
        setChatId(id);
        await next.create(input, settings);
      } catch (error) {
        setSelection(input.selection ?? null);
        throw error;
      }
    },
    [session, documentId, settings, selection],
  );

  const updateSettings = (patch: Partial<ChatSettings>) => {
    if (session) void session.update({ settings: patch });
    else setDraftSettings({ ...settings, ...patch });
  };

  // Stable callbacks, so replies that didn't change don't re-render while another streams.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const reviewRef = useRef(onReview);
  reviewRef.current = onReview;
  const retry = useCallback(() => void sessionRef.current?.retry(), []);
  const review = useCallback((action: "next" | "accept" | "reject", ids: string[]) => reviewRef.current(action, ids), []);

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
          <IconButton ref={historyButton} label="Chat history" size="sm" active={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>
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
            <MessageList messages={chat.messages} hunks={hunks} onRetry={retry} onReview={review} documentId={documentId} onRestore={(versionId, messageId) => setRewinding({ versionId, messageId })} />
            {chat.running && isWaiting(chat.status, lastAssistant(chat.messages)) && <ActivityLine status={chat.status} message={lastAssistant(chat.messages)} since={lastSent(chat.messages)} />}
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
          meter={<UsageMeter chat={chat} running={Boolean(chat?.running)} usageLimit={settings.usageLimit ?? null} onUsageLimit={(usageLimit) => updateSettings({ usageLimit })} />}
          selection={selection}
          documentId={documentId}
          onClearSelection={() => setSelection(null)}
          onSend={send}
          onStop={() => void session?.interrupt()}
          onSettings={updateSettings}
          onWarm={warm}
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
        <p>The document goes back to how it was before this reply&apos;s edits, and the chat rewinds to before your message, so Claude forgets it too. The current text is saved in version history.</p>
      </Dialog>
    </aside>
  );
});

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
