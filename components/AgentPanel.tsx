"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { relativeTime } from "@/lib/agent/chats";
import {
  AGENT_MODES,
  THINKING_LEVELS,
  modelLabel,
  thinkingLabel,
  type AgentModelOption,
} from "@/lib/agent/models";
import type { AgentChat, AgentMode, AgentSelection, AgentTurn, PendingEdit, ThinkingLevel } from "@/lib/agent/types";

const CHAT_WIDTH_KEY = "inline-chat-width";
const DEFAULT_CHAT_WIDTH = 400;
const MIN_CHAT_WIDTH = 320;
const MAX_CHAT_WIDTH = 760;

function clampChatWidth(width: number) {
  const max = Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, Math.round(window.innerWidth * 0.72)));
  return Math.max(MIN_CHAT_WIDTH, Math.min(max, Math.round(width)));
}

type Props = {
  open: boolean;
  minimized: boolean;
  busy: boolean;
  livePhase: "thinking" | "planning" | null;
  liveThinking: string;
  error: string | null;
  prompt: string;
  context: AgentSelection | null;
  chats: AgentChat[];
  activeChatId: string;
  models: AgentModelOption[];
  providers: { openai: boolean; anthropic: boolean };
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onClearContext: () => void;
  onMinimizedChange: (value: boolean) => void;
  onClose: () => void;
  onNewChat: () => void;
  onSelectChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onModeChange: (mode: AgentMode) => void;
  onModelChange: (model: string) => void;
  onThinkingChange: (level: ThinkingLevel) => void;
  onJump: (id: string) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
};

export function AgentPanel({
  open,
  minimized,
  busy,
  livePhase,
  liveThinking,
  error,
  prompt,
  context,
  chats,
  activeChatId,
  models,
  providers,
  onPromptChange,
  onSubmit,
  onClearContext,
  onMinimizedChange,
  onClose,
  onNewChat,
  onSelectChat,
  onDeleteChat,
  onModeChange,
  onModelChange,
  onThinkingChange,
  onJump,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
}: Props) {
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [menu, setMenu] = useState<"mode" | "model" | "thinking" | null>(null);
  const [width, setWidth] = useState(DEFAULT_CHAT_WIDTH);
  const [widthReady, setWidthReady] = useState(false);
  const [resizing, setResizing] = useState(false);
  const chat = chats.find((item) => item.id === activeChatId) ?? chats[0];
  const phase = livePhase === "planning" || chat?.mode === "plan" ? "Planning" : "Thinking";
  const pending = chat?.turns.flatMap((turn) => turn.edits.filter((edit) => edit.status === "pending")) ?? [];

  useEffect(() => {
    const stored = Number(window.localStorage.getItem(CHAT_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) setWidth(clampChatWidth(stored));
    setWidthReady(true);
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--chat-width", `${width}px`);
    if (widthReady) window.localStorage.setItem(CHAT_WIDTH_KEY, String(width));
  }, [width, widthReady]);

  useEffect(() => {
    const onResize = () => setWidth((current) => clampChatWidth(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const syncInputHeight = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    const max = Math.round(window.innerHeight * 0.55);
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 24), max)}px`;
  }, []);

  useEffect(() => {
    if (open && !minimized && !historyOpen) {
      inputRef.current?.focus();
      syncInputHeight();
    }
  }, [open, minimized, historyOpen, syncInputHeight]);

  useEffect(() => {
    syncInputHeight();
  }, [prompt, syncInputHeight]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTop = thread.scrollHeight;
  }, [chat?.turns, busy, liveThinking, livePhase, historyOpen]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("[data-chat-menu]")) return;
      setMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menu]);

  const history = useMemo(
    () => [...chats].sort((a, b) => b.updatedAt - a.updatedAt),
    [chats],
  );

  if (!open) return null;

  if (minimized) {
    return (
      <aside className="comments-rail chat-rail">
        <button type="button" className="comments-rail-btn" onClick={() => onMinimizedChange(false)}>
          Chat{pending.length ? ` - ${pending.length}` : ""}
        </button>
      </aside>
    );
  }

  const title = chat?.title || "New chat";
  const placeholder =
    chat?.mode === "ask"
      ? "Ask about the document…"
      : chat?.mode === "plan"
        ? "Describe the plan you want…"
        : "Plan, search, ask to edit…";

  return (
    <aside className="agent-panel" style={{ width }}>
      <div
        className={`chat-resize${resizing ? " is-dragging" : ""}`}
        role="slider"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label="Chat width"
        aria-valuemin={MIN_CHAT_WIDTH}
        aria-valuemax={MAX_CHAT_WIDTH}
        aria-valuenow={width}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            setWidth((current) => clampChatWidth(current + 24));
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setWidth((current) => clampChatWidth(current - 24));
          }
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          const startX = event.clientX;
          const startWidth = width;
          const onMove = (move: PointerEvent) => {
            setWidth(clampChatWidth(startWidth + (startX - move.clientX)));
          };
          const onUp = () => {
            setResizing(false);
            document.body.classList.remove("is-chat-resizing");
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
          };
          setResizing(true);
          document.body.classList.add("is-chat-resizing");
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
      />
      <header className="chat-head">
        <div className="chat-tabs">
          {historyOpen ? (
            <span className="chat-tab">History</span>
          ) : (
            <span className="chat-tab" title={title}>
              {title}
            </span>
          )}
        </div>
        <div className="chat-head-actions">
          <button
            type="button"
            className="chat-icon-btn"
            title={historyOpen ? "Back to chat" : "Chat history"}
            aria-pressed={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <HistoryIcon />
          </button>
          <button
            type="button"
            className="chat-icon-btn"
            title="New chat"
            onClick={() => {
              setHistoryOpen(false);
              onNewChat();
            }}
          >
            <PlusIcon />
          </button>
          <button type="button" className="chat-icon-btn" title="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
      </header>

      {historyOpen ? (
        <div className="chat-history">
          {history.map((item) => (
            <div key={item.id} className={`chat-history-row${item.id === chat?.id ? " is-active" : ""}`}>
              <button
                type="button"
                className="chat-history-open"
                onClick={() => {
                  onSelectChat(item.id);
                  setHistoryOpen(false);
                }}
              >
                <strong>{item.title}</strong>
                <span>
                  {item.turns.length ? `${item.turns.length} ${item.turns.length === 1 ? "message" : "messages"}` : "Empty"}
                  {" - "}
                  {relativeTime(item.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className="chat-icon-btn"
                title="Delete chat"
                onClick={() => onDeleteChat(item.id)}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="chat-thread" ref={threadRef}>
          {chat?.turns.map((turn) => (
            <TurnBlock
              key={turn.id}
              turn={turn}
              onJump={onJump}
              onAccept={onAccept}
              onReject={onReject}
            />
          ))}
          {busy && (
            <div className="chat-live">
              <div className="chat-status">
                <span className="chat-shimmer">{phase}</span>
              </div>
              {liveThinking ? (
                <p className="chat-trace is-live">
                  {liveThinking}
                  <span className="chat-caret" />
                </p>
              ) : null}
            </div>
          )}
          {error && <p className="chat-error">{error}</p>}
        </div>
      )}

      {!historyOpen && pending.length > 0 && (
        <div className="chat-review">
          <button type="button" onClick={onRejectAll}>
            Undo All
          </button>
          <button type="button" className="chat-review-primary" onClick={onAcceptAll}>
            Keep All
          </button>
        </div>
      )}

      {!historyOpen && (
        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            setMenu(null);
            onSubmit();
          }}
        >
          {context && (
            <div className="chat-context">
              <button type="button" className="chat-context-chip" onClick={() => pending[0] && onJump(pending[0].id)}>
                <SelectionIcon />
                <span>Selection</span>
                <em>{wordCount(context.text)}</em>
              </button>
              <button type="button" className="chat-context-remove" onClick={onClearContext} aria-label="Remove selection">
                <CloseIcon />
              </button>
            </div>
          )}
          <textarea
            ref={inputRef}
            rows={1}
            value={prompt}
            placeholder={placeholder}
            onChange={(event) => onPromptChange(event.target.value)}
            onInput={syncInputHeight}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                setMenu(null);
                onSubmit();
              }
            }}
          />
          <div className="chat-composer-bar">
            <div className="chat-composer-controls">
              <ComposerMenu
                id="mode"
                open={menu}
                setOpen={setMenu}
                label={AGENT_MODES.find((item) => item.id === chat?.mode)?.label ?? "Agent"}
              >
                {AGENT_MODES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={item.id === chat?.mode ? "is-active" : undefined}
                    onClick={() => {
                      onModeChange(item.id);
                      setMenu(null);
                    }}
                  >
                    <strong>{item.label}</strong>
                    <span>{item.hint}</span>
                  </button>
                ))}
              </ComposerMenu>
              <ComposerMenu
                id="model"
                open={menu}
                setOpen={setMenu}
                label={chat ? modelLabel(chat.model) : "Model"}
              >
                <p className="chat-menu-label">OpenAI</p>
                {models.filter((item) => item.provider === "openai").map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={item.id === chat?.model ? "is-active" : undefined}
                    onClick={() => {
                      onModelChange(item.id);
                      setMenu(null);
                    }}
                  >
                    <strong>{item.label}</strong>
                    {!providers.openai && <span>Mock without a key</span>}
                  </button>
                ))}
                <p className="chat-menu-label">Anthropic</p>
                {models.filter((item) => item.provider === "anthropic").map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={item.id === chat?.model ? "is-active" : undefined}
                    disabled={!providers.anthropic}
                    onClick={() => {
                      onModelChange(item.id);
                      setMenu(null);
                    }}
                  >
                    <strong>{item.label}</strong>
                    {!providers.anthropic && <span>Needs API key</span>}
                  </button>
                ))}
              </ComposerMenu>
              <ComposerMenu
                id="thinking"
                open={menu}
                setOpen={setMenu}
                label={chat ? thinkingLabel(chat.thinkingLevel) : "Medium"}
              >
                {THINKING_LEVELS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={item.id === chat?.thinkingLevel ? "is-active" : undefined}
                    onClick={() => {
                      onThinkingChange(item.id);
                      setMenu(null);
                    }}
                  >
                    <strong>{item.label}</strong>
                  </button>
                ))}
              </ComposerMenu>
            </div>
            <button type="submit" className="chat-send" disabled={busy || !prompt.trim()} aria-label="Send">
              <SendIcon />
            </button>
          </div>
        </form>
      )}
    </aside>
  );
}

function ComposerMenu({
  id,
  open,
  setOpen,
  label,
  children,
}: {
  id: "mode" | "model" | "thinking";
  open: "mode" | "model" | "thinking" | null;
  setOpen: (value: "mode" | "model" | "thinking" | null) => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="chat-menu" data-chat-menu>
      <button
        type="button"
        className="chat-menu-btn"
        aria-expanded={open === id}
        onClick={() => setOpen(open === id ? null : id)}
      >
        {label}
        <ChevronIcon />
      </button>
      {open === id && <div className="chat-menu-pop">{children}</div>}
    </div>
  );
}

function TurnBlock({
  turn,
  onJump,
  onAccept,
  onReject,
}: {
  turn: AgentTurn;
  onJump: (id: string) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const [traceOpen, setTraceOpen] = useState(false);
  const applied = turn.edits.filter((edit) => edit.status !== "missed").length;
  return (
    <section className="chat-turn">
      <div className="chat-user">
        <p>{turn.prompt}</p>
        {turn.selection && (
          <div className="chat-user-chip">
            <SelectionIcon />
            Selection
          </div>
        )}
      </div>
      {turn.thinking && (
        <div className="chat-trace-wrap">
          <button type="button" className="chat-trace-toggle" onClick={() => setTraceOpen((value) => !value)}>
            <span className="chat-trace-label">{traceLabel(turn.mode, turn.durationMs)}</span>
            <ChevronIcon />
          </button>
          {traceOpen && <p className="chat-trace">{turn.thinking}</p>}
        </div>
      )}
      {applied > 0 && (
        <div className="chat-tool">
          <DocIcon />
          Edited the document
          <em>
            {applied} {applied === 1 ? "change" : "changes"}
          </em>
        </div>
      )}
      <div className="chat-assistant">
        {turn.message.split("\n").map((line, index) => (
          <p key={`${turn.id}-${index}`}>{line || "\u00a0"}</p>
        ))}
        {turn.mock && <p className="chat-muted">Mock proposal — add an API key for a model response.</p>}
        {turn.edits.map((edit) => (
          <Hunk key={edit.id} edit={edit} onJump={onJump} onAccept={onAccept} onReject={onReject} />
        ))}
      </div>
    </section>
  );
}

function Hunk({
  edit,
  onJump,
  onAccept,
  onReject,
}: {
  edit: PendingEdit;
  onJump: (id: string) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const long = hunkIsLong(edit);
  const [expanded, setExpanded] = useState(false);
  const open = !long || expanded;
  return (
    <div className={`chat-hunk is-${edit.status}${open ? "" : " is-collapsed"}`}>
      <div className="chat-hunk-head">
        <button type="button" className="chat-hunk-file" onClick={() => onJump(edit.id)}>
          Document
        </button>
        {long && (
          <button
            type="button"
            className="chat-hunk-expand"
            aria-expanded={open}
            onClick={() => setExpanded((value) => !value)}
          >
            {open ? "Show less" : "Show more"}
            <ChevronIcon />
          </button>
        )}
      </div>
      <button
        type="button"
        className="chat-hunk-body"
        onClick={() => {
          if (!open) setExpanded(true);
          else onJump(edit.id);
        }}
      >
        <pre>
          <code>
            {edit.find ? (
              <span className="chat-hunk-line is-del">- {open ? edit.find : clipHunk(edit.find)}</span>
            ) : null}
            <span className="chat-hunk-line is-add">+ {open ? edit.replace || "(delete)" : clipHunk(edit.replace || "(delete)")}</span>
          </code>
        </pre>
      </button>
      {edit.status === "pending" ? (
        <div className="chat-hunk-actions">
          <button type="button" onClick={() => onReject(edit.id)}>
            Undo
          </button>
          <button type="button" className="chat-keep" onClick={() => onAccept(edit.id)}>
            Keep
          </button>
        </div>
      ) : (
        <p className="chat-hunk-status">{statusLabel(edit.status)}</p>
      )}
    </div>
  );
}

function hunkIsLong(edit: PendingEdit) {
  const text = `${edit.find}\n${edit.replace}`;
  return text.length > 140 || text.split(/\n/).length > 3;
}

function clipHunk(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 92 ? `${clean.slice(0, 92).trim()}…` : clean;
}

function traceLabel(mode: AgentMode, durationMs?: number) {
  const verb = mode === "plan" ? "Planned" : "Thought";
  if (!durationMs || durationMs < 400) return verb;
  const seconds = durationMs < 1000 ? Math.round(durationMs / 100) / 10 : Math.round(durationMs / 1000);
  return `${verb} for ${seconds}s`;
}

function statusLabel(status: PendingEdit["status"]) {
  if (status === "accepted") return "Kept";
  if (status === "rejected") return "Undone";
  if (status === "missed") return "Could not find that text.";
  return "";
}

function wordCount(text: string) {
  const parts = text.trim().split(/\s+/);
  return parts[0] === "" ? "0 words" : `${parts.length} ${parts.length === 1 ? "word" : "words"}`;
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 12.5V3.5M4.5 7 8 3.5 11.5 7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SelectionIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.2" y="2.5" width="9.6" height="11" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 6.5h4M6 8.7h4M6 10.9h2.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.2a4.8 4.8 0 1 1-3.4 1.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8 5.6V8.2l1.8 1.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3.1 4.2v2.4H5.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 4.4 6 7.4 9 4.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 2.6h4.2L12.4 6v7.4H5V2.6Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9.1 2.6V6h3.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
