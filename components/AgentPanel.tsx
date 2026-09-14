"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { relativeTime } from "@/lib/agent/chats";
import {
  AGENT_MODES,
  THINKING_LEVELS,
  findAgentModel,
  modelLabel,
  thinkingLabel,
  type AgentModelOption,
} from "@/lib/agent/models";
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep, stepsFromLive } from "@/components/agent/ChainOfThought";
import { CitedMessage } from "@/components/agent/CitedMessage";
import { ContextUsage } from "@/components/agent/ContextUsage";
import { InstructionQueue } from "@/components/agent/InstructionQueue";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/agent/Reasoning";
import { Shimmer } from "@/components/agent/Shimmer";
import { TaskPanel } from "@/components/agent/TaskPanel";
import type { AgentAttachment, AgentChat, AgentCitation, AgentMode, AgentQueueItem, AgentSelection, AgentStep, AgentTurn, AgentUsage, PendingEdit, ThinkingLevel } from "@/lib/agent/types";
import { PROMPT_TEMPLATES, QUICK_PROMPTS } from "@/lib/writing/templates";

const CHAT_WIDTH_KEY = "inline-chat-width";
const DEFAULT_CHAT_WIDTH = 400;
const MIN_CHAT_WIDTH = 320;
const MAX_CHAT_WIDTH = 760;

function clampChatWidth(width: number) {
  const max = Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, Math.round(window.innerWidth * 0.72)));
  return Math.max(MIN_CHAT_WIDTH, Math.min(max, Math.round(width)));
}

const COMPOSER_CONTROLS = ["tone", "templates", "mode", "model"] as const;
type ComposerControlId = (typeof COMPOSER_CONTROLS)[number];
type ComposerMenuId = ComposerControlId | "more";

type Props = {
  open: boolean;
  minimized: boolean;
  busy: boolean;
  livePhase: "thinking" | "planning" | "editing" | "reviewing" | null;
  liveThinking: string;
  livePrompt: string;
  liveSelection: string | null;
  liveMessage: string;
  liveEdits: PendingEdit[];
  liveCitations: AgentCitation[];
  error: string | null;
  prompt: string;
  context: AgentSelection[];
  chats: AgentChat[];
  queued: AgentQueueItem[];
  contextUsage: { used: number; limit: number; usage?: AgentUsage };
  liveSteps?: AgentStep[];
  activeChatId: string;
  models: AgentModelOption[];
  providers: { openai: boolean; anthropic: boolean };
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onRevert: (turnId: string) => void;
  onClearContext: () => void;
  onRevealContext: (context: AgentSelection) => void;
  onRemoveContext: (index: number) => void;
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
  attachments: AgentAttachment[];
  preserveTone: boolean;
  liveTools: string[];
  onPreserveToneChange: (value: boolean) => void;
  onAttach: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
  onTemplate: (prompt: string) => void;
  onToggleTask: (id: string) => void;
  onCancelQueued: (id: string) => void;
  onInsertCitation: (citation: AgentCitation) => void;
};

export function AgentPanel({
  open,
  minimized,
  busy,
  livePhase,
  liveThinking,
  livePrompt,
  liveSelection,
  liveMessage,
  liveEdits,
  liveCitations,
  error,
  prompt,
  context,
  chats,
  queued,
  contextUsage,
  liveSteps,
  activeChatId,
  models,
  providers,
  onPromptChange,
  onSubmit,
  onStop,
  onRevert,
  onClearContext,
  onRevealContext,
  onRemoveContext,
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
  attachments,
  preserveTone,
  liveTools,
  onPreserveToneChange,
  onAttach,
  onRemoveAttachment,
  onTemplate,
  onToggleTask,
  onCancelQueued,
  onInsertCitation,
}: Props) {
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputEventRef = useRef(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [menu, setMenu] = useState<ComposerMenuId | null>(null);
  const [inputFade, setInputFade] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState<{ id: string; later: boolean } | null>(null);
  const [overflowIds, setOverflowIds] = useState<ComposerControlId[]>([]);
  const controlsRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);
  const [width, setWidth] = useState(DEFAULT_CHAT_WIDTH);
  const [widthReady, setWidthReady] = useState(false);
  const [resizing, setResizing] = useState(false);
  const chat = chats.find((item) => item.id === activeChatId) ?? chats[0];
  const supportsThinking = Boolean(findAgentModel(chat?.model)?.thinking);
  const phase =
    livePhase === "editing" || liveEdits.length
      ? "Editing"
      : livePhase === "reviewing"
        ? "Checking"
        : livePhase === "planning" || chat?.mode === "plan"
          ? "Planning"
          : chat?.thinkingLevel === "none" || !supportsThinking
            ? "Working"
            : "Thinking";
  const pending = chat?.turns.flatMap((turn) => turn.edits.filter((edit) => edit.status === "pending")) ?? [];
  const tasks = chat?.tasks ?? [];

  useLayoutEffect(() => {
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
    const max = busy ? Math.round(window.innerHeight * 0.28) : Math.round(window.innerHeight * 0.55);
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 24), max)}px`;
    const fade = el.scrollHeight > el.clientHeight + 1;
    setInputFade((current) => (current === fade ? current : fade));
  }, [busy]);

  useEffect(() => {
    if (open && !minimized && !historyOpen && !busy) {
      inputRef.current?.focus();
      syncInputHeight();
    }
  }, [open, minimized, historyOpen, busy, syncInputHeight]);

  useEffect(() => {
    if (inputEventRef.current) {
      inputEventRef.current = false;
      return;
    }
    syncInputHeight();
  }, [prompt, syncInputHeight]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const frame = window.requestAnimationFrame(() => {
      thread.scrollTop = thread.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chat?.turns, busy, liveThinking, livePhase, livePrompt, liveMessage, liveEdits, liveSteps, historyOpen]);

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

  useEffect(() => {
    if (!confirmRevert) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmRevert(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmRevert]);

  useLayoutEffect(() => {
    const row = controlsRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const update = () => {
      const budget = row.clientWidth;
      if (budget < 80) return;
      const attach = measure.querySelector("[data-measure='attach']") as HTMLElement | null;
      const more = measure.querySelector("[data-measure='more']") as HTMLElement | null;
      const items = COMPOSER_CONTROLS.map((id) => measure.querySelector(`[data-measure='${id}']`) as HTMLElement | null);
      const gap = 2;
      const attachWidth = attach?.offsetWidth ?? 28;
      const moreWidth = more?.offsetWidth ?? 28;
      let best = 0;
      for (let count = items.length; count >= 0; count -= 1) {
        let used = attachWidth;
        for (let i = 0; i < count; i += 1) used += (items[i]?.offsetWidth ?? 0) + gap;
        if (count < items.length) used += moreWidth + gap;
        if (used <= budget) {
          best = count;
          break;
        }
      }
      const next = COMPOSER_CONTROLS.slice(best);
      setOverflowIds((current) => (current.length === next.length && current.every((id, index) => id === next[index]) ? current : [...next]));
    };
    const observer = new ResizeObserver(update);
    observer.observe(row);
    update();
    const frame = window.requestAnimationFrame(update);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [width, chat?.mode, chat?.model, preserveTone, open]);

  useEffect(() => {
    if (menu === "more" && overflowIds.length === 0) setMenu(null);
  }, [menu, overflowIds.length]);

  const history = useMemo(
    () => [...chats].sort((a, b) => b.updatedAt - a.updatedAt),
    [chats],
  );

  if (!open) return null;

  if (minimized) {
    return (
      <aside className="comments-rail chat-rail">
        <button type="button" className="comments-rail-btn" onClick={() => onMinimizedChange(false)}>
          Chat{queued.length ? ` · ${queued.length} queued` : pending.length ? ` · ${pending.length}` : ""}
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
          {!historyOpen && <ContextUsage used={contextUsage.used} limit={contextUsage.limit} usage={contextUsage.usage} />}
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
          {chat?.turns.map((turn, index) => (
            <MemoTurnBlock
              key={turn.id}
              turn={turn}
              canRevert={!busy && Boolean(turn.snapshotId)}
              onJump={onJump}
              onAccept={onAccept}
              onReject={onReject}
              onRevert={() =>
                setConfirmRevert({
                  id: turn.id,
                  later: index < (chat.turns.length - 1),
                })
              }
              onInsertCitation={onInsertCitation}
            />
          ))}
          {busy && (
            <LiveTurn
              phase={phase}
              prompt={livePrompt}
              selection={liveSelection}
              thinking={liveThinking}
              steps={liveSteps ?? stepsFromLive({ phase, tools: liveTools, editCount: liveEdits.length, hasMessage: Boolean(liveMessage) })}
              edits={liveEdits}
              message={liveMessage}
              citations={liveCitations}
              onJump={onJump}
              onAccept={onAccept}
              onReject={onReject}
              onInsertCitation={onInsertCitation}
            />
          )}
          {error && <p className="chat-error">{error}</p>}
          <TaskPanel tasks={tasks} onToggle={onToggleTask} />
          <InstructionQueue items={queued} onCancel={onCancelQueued} />
        </div>
      )}

      {!historyOpen && pending.length > 0 && (
        <div className="chat-review" aria-label="Review all changes">
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
          className={`chat-composer${busy ? " is-busy" : ""}`}
          onSubmit={(event) => {
            event.preventDefault();
            setMenu(null);
            onSubmit();
          }}
        >
          {context.length > 0 && (
            <div className="chat-context" aria-label={`${context.length} selected passage${context.length === 1 ? "" : "s"}`}>
              {context.map((item, index) => (
                <div className="chat-context-chip" key={`${item.start}-${item.end}-${index}`}>
                  <button type="button" className="chat-context-main" onClick={() => onRevealContext(item)}>
                    <SelectionIcon />
                    <span className="chat-context-quote">“{clipHunk(item.text)}”</span>
                    <em>{wordCount(item.text)}</em>
                  </button>
                  <button
                    type="button"
                    className="chat-context-remove"
                    onClick={() => onRemoveContext(index)}
                    aria-label={`Remove selection ${index + 1}`}
                  >
                    <CloseIcon />
                  </button>
                </div>
              ))}
              {context.length > 1 && (
                <button type="button" className="chat-context-clear" onClick={onClearContext}>
                  Clear all
                </button>
              )}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="chat-attach-list">
              {attachments.map((file) => (
                <span key={file.id} className="chat-attach-chip">
                  {file.name}
                  <button type="button" onClick={() => onRemoveAttachment(file.id)} aria-label={`Remove ${file.name}`}>
                    <CloseIcon />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className={`chat-composer-field${inputFade || busy ? " is-fade" : ""}`}>
            <textarea
              ref={inputRef}
              rows={1}
              value={prompt}
              placeholder={busy ? "Queue another instruction…" : placeholder}
              aria-busy={busy}
              onChange={(event) => onPromptChange(event.target.value)}
              onInput={() => {
                inputEventRef.current = true;
                syncInputHeight();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  setMenu(null);
                  onSubmit();
                }
              }}
            />
            <div className="chat-composer-fade" aria-hidden />
          </div>
          <div className="chat-composer-bar">
            <div className="chat-composer-controls" ref={controlsRef}>
              <div className="chat-composer-measure" ref={measureRef} aria-hidden>
                <span data-measure="attach" className="chat-icon-btn">
                  <PaperclipIcon />
                </span>
                <span data-measure="tone" className="chat-menu-btn">
                  Tone
                </span>
                <span data-measure="templates" className="chat-menu-btn">
                  Templates
                  <ChevronIcon />
                </span>
                <span data-measure="mode" className="chat-menu-btn">
                  {AGENT_MODES.find((item) => item.id === chat?.mode)?.label ?? "Agent"}
                  <ChevronIcon />
                </span>
                <span data-measure="model" className="chat-menu-btn">
                  {chat ? modelLabel(chat.model) : "Model"}
                  <ChevronIcon />
                </span>
                <span data-measure="more" className="chat-icon-btn">
                  <MoreIcon />
                </span>
              </div>
              <input
                ref={attachRef}
                type="file"
                hidden
                accept=".txt,.md,.html,.csv"
                multiple
                onChange={(event) => {
                  onAttach(event.target.files);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="chat-icon-btn"
                title="Attach a style sample"
                aria-label="Attach a style sample"
                aria-pressed={attachments.length > 0}
                onClick={() => attachRef.current?.click()}
              >
                <PaperclipIcon />
              </button>
              {!overflowIds.includes("tone") && (
                <button
                  type="button"
                  className="chat-menu-btn"
                  data-active={preserveTone}
                  onClick={() => onPreserveToneChange(!preserveTone)}
                >
                  Tone
                </button>
              )}
              {!overflowIds.includes("templates") && (
                <ComposerMenu id="templates" open={menu} setOpen={setMenu} label="Templates">
                  <TemplateMenuItems onPick={onTemplate} onClose={() => setMenu(null)} />
                </ComposerMenu>
              )}
              {!overflowIds.includes("mode") && (
                <ComposerMenu
                  id="mode"
                  open={menu}
                  setOpen={setMenu}
                  label={AGENT_MODES.find((item) => item.id === chat?.mode)?.label ?? "Agent"}
                >
                  <ModeMenuItems mode={chat?.mode} onPick={onModeChange} onClose={() => setMenu(null)} />
                </ComposerMenu>
              )}
              {!overflowIds.includes("model") && (
                <ModelPicker
                  open={menu === "model"}
                  setOpen={(next) => setMenu(next ? "model" : null)}
                  chat={chat}
                  models={models}
                  providers={providers}
                  onModelChange={onModelChange}
                  onThinkingChange={onThinkingChange}
                />
              )}
              {overflowIds.length > 0 && (
                <OverflowMenu
                  open={menu}
                  setOpen={setMenu}
                  ids={overflowIds}
                  chat={chat}
                  models={models}
                  providers={providers}
                  preserveTone={preserveTone}
                  onPreserveToneChange={onPreserveToneChange}
                  onTemplate={onTemplate}
                  onModeChange={onModeChange}
                  onModelChange={onModelChange}
                  onThinkingChange={onThinkingChange}
                />
              )}
            </div>
            {busy ? (
              <div className="chat-send-group">
                <button type="button" className="chat-stop" aria-label="Stop" title="Stop current run" onClick={onStop}>
                  <StopIcon />
                </button>
                <button type="submit" className="chat-send" disabled={!prompt.trim()} aria-label="Queue instruction" title="Queue instruction">
                  <QueueIcon />
                </button>
              </div>
            ) : (
              <button type="submit" className="chat-send" disabled={!prompt.trim()} aria-label="Send">
                <SendIcon />
              </button>
            )}
          </div>
        </form>
      )}
      {confirmRevert && (
        <div className="chat-confirm-scrim" role="presentation">
          <div className="chat-confirm" role="dialog" aria-modal="true" aria-labelledby="chat-revert-title">
            <p id="chat-revert-title">Revert the document to before this message?</p>
            <p className="chat-muted">
              {confirmRevert.later
                ? "AI changes from this message and later messages will be discarded."
                : "AI changes from this message will be discarded."}
            </p>
            <div className="chat-confirm-actions">
              <button type="button" onClick={() => setConfirmRevert(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="is-danger"
                onClick={() => {
                  onRevert(confirmRevert.id);
                  setConfirmRevert(null);
                }}
              >
                Revert
              </button>
            </div>
          </div>
        </div>
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
  id: ComposerMenuId;
  open: ComposerMenuId | null;
  setOpen: (value: ComposerMenuId | null) => void;
  label: string;
  children: ReactNode;
}) {
  const shown = useOpenTransition(open === id);
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
      {shown && <div className={`chat-menu-pop${open === id ? " is-open" : ""}`}>{children}</div>}
    </div>
  );
}

function ModelPicker({
  open,
  setOpen,
  chat,
  models,
  providers,
  onModelChange,
  onThinkingChange,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  chat: AgentChat | undefined;
  models: AgentModelOption[];
  providers: { openai: boolean; anthropic: boolean };
  onModelChange: (model: string) => void;
  onThinkingChange: (level: ThinkingLevel) => void;
}) {
  const shown = useOpenTransition(open);

  return (
    <div className="chat-menu" data-chat-menu>
      <button
        type="button"
        className="chat-menu-btn"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {chat ? modelLabel(chat.model) : "Model"}
        <ChevronIcon />
      </button>
      {shown && (
        <div className={`chat-menu-pop chat-model-pop${open ? " is-open" : ""}`}>
          <ModelPickerBody
            open={open}
            chat={chat}
            models={models}
            providers={providers}
            onModelChange={onModelChange}
            onThinkingChange={onThinkingChange}
          />
        </div>
      )}
    </div>
  );
}

function ModelPickerBody({
  open,
  chat,
  models,
  providers,
  onModelChange,
  onThinkingChange,
}: {
  open: boolean;
  chat: AgentChat | undefined;
  models: AgentModelOption[];
  providers: { openai: boolean; anthropic: boolean };
  onModelChange: (model: string) => void;
  onThinkingChange: (level: ThinkingLevel) => void;
}) {
  const [view, setView] = useState<"root" | "effort" | "model">("root");
  const option = findAgentModel(chat?.model);
  const supportsThinking = Boolean(option?.thinking);
  const effortRef = useRef<ThinkingLevel>(chat?.thinkingLevel && chat.thinkingLevel !== "none" ? chat.thinkingLevel : "medium");
  if (chat?.thinkingLevel && chat.thinkingLevel !== "none") effortRef.current = chat.thinkingLevel;
  const fast = !supportsThinking || chat?.thinkingLevel === "none";
  const effort = chat?.thinkingLevel && chat.thinkingLevel !== "none" ? chat.thinkingLevel : effortRef.current;

  useEffect(() => {
    if (!open) setView("root");
  }, [open]);

  if (view === "effort") {
    return (
      <div className="chat-model-view">
        <button type="button" className="chat-model-back" aria-label="Back" onClick={() => setView("root")}>
          <ChevronIcon />
        </button>
        {THINKING_LEVELS.filter((item) => item.id !== "none").map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === effort ? "is-active" : undefined}
            onClick={() => {
              effortRef.current = item.id;
              onThinkingChange(item.id);
              setView("root");
            }}
          >
            <strong>{item.label}</strong>
          </button>
        ))}
      </div>
    );
  }

  if (view === "model") {
    return (
      <div className="chat-model-view">
        <p className="chat-menu-label">OpenAI</p>
        {models
          .filter((item) => item.provider === "openai")
          .map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === chat?.model ? "is-active" : undefined}
              onClick={() => {
                onModelChange(item.id);
                if (!item.thinking) onThinkingChange("none");
                else if (!fast) onThinkingChange(effortRef.current);
                setView("root");
              }}
            >
              <strong>{item.label}</strong>
              {!providers.openai && <span>Mock without a key</span>}
            </button>
          ))}
        <p className="chat-menu-label">Anthropic</p>
        {models
          .filter((item) => item.provider === "anthropic")
          .map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === chat?.model ? "is-active" : undefined}
              disabled={!providers.anthropic}
              onClick={() => {
                onModelChange(item.id);
                if (!item.thinking) onThinkingChange("none");
                else if (!fast) onThinkingChange(effortRef.current);
                setView("root");
              }}
            >
              <strong>{item.label}</strong>
              {!providers.anthropic && <span>Needs API key</span>}
            </button>
          ))}
      </div>
    );
  }

  return (
    <div className="chat-model-view">
      {supportsThinking && (
        <div className="chat-model-row">
          <span>Fast</span>
          <button
            type="button"
            className={`chat-switch${fast ? " is-on" : ""}`}
            role="switch"
            aria-checked={fast}
            aria-label="Fast"
            onClick={() => onThinkingChange(fast ? effortRef.current : "none")}
          />
        </div>
      )}
      {supportsThinking && (
        <button type="button" className="chat-model-row is-nav" onClick={() => setView("effort")}>
          <span>Effort</span>
          <em>
            {thinkingLabel(effort)}
            <ChevronRightIcon />
          </em>
        </button>
      )}
      <button type="button" className="chat-model-row is-nav" onClick={() => setView("model")}>
        <span>Model</span>
        <em>
          {option?.label ?? "Model"}
          <ChevronRightIcon />
        </em>
      </button>
    </div>
  );
}

function OverflowMenu({
  open,
  setOpen,
  ids,
  chat,
  models,
  providers,
  preserveTone,
  onPreserveToneChange,
  onTemplate,
  onModeChange,
  onModelChange,
  onThinkingChange,
}: {
  open: ComposerMenuId | null;
  setOpen: (value: ComposerMenuId | null) => void;
  ids: ComposerControlId[];
  chat: AgentChat | undefined;
  models: AgentModelOption[];
  providers: { openai: boolean; anthropic: boolean };
  preserveTone: boolean;
  onPreserveToneChange: (value: boolean) => void;
  onTemplate: (prompt: string) => void;
  onModeChange: (mode: AgentMode) => void;
  onModelChange: (model: string) => void;
  onThinkingChange: (level: ThinkingLevel) => void;
}) {
  const [view, setView] = useState<"root" | ComposerControlId>("root");
  const shown = useOpenTransition(open === "more");

  useEffect(() => {
    if (open !== "more") setView("root");
  }, [open]);

  const label = (id: ComposerControlId) => {
    if (id === "tone") return "Tone";
    if (id === "templates") return "Templates";
    if (id === "mode") return AGENT_MODES.find((item) => item.id === chat?.mode)?.label ?? "Agent";
    return chat ? modelLabel(chat.model) : "Model";
  };

  return (
    <div className="chat-menu" data-chat-menu>
      <button
        type="button"
        className="chat-icon-btn chat-more-btn"
        title="More"
        aria-label="More"
        aria-expanded={open === "more"}
        onClick={() => setOpen(open === "more" ? null : "more")}
      >
        <MoreIcon />
      </button>
      {shown && (
        <div className={`chat-menu-pop chat-more-pop${open === "more" ? " is-open" : ""}`}>
          {view === "root" &&
            ids.map((id) =>
              id === "tone" ? (
                <div key={id} className="chat-model-row">
                  <span>Tone</span>
                  <button
                    type="button"
                    className={`chat-switch${preserveTone ? " is-on" : ""}`}
                    role="switch"
                    aria-checked={preserveTone}
                    aria-label="Tone"
                    onClick={() => onPreserveToneChange(!preserveTone)}
                  />
                </div>
              ) : (
                <button key={id} type="button" className="chat-model-row is-nav" onClick={() => setView(id)}>
                  <span>{label(id)}</span>
                  <em>
                    <ChevronRightIcon />
                  </em>
                </button>
              ),
            )}
          {view === "templates" && (
            <div className="chat-model-view">
              <button type="button" className="chat-model-back" aria-label="Back" onClick={() => setView("root")}>
                <ChevronIcon />
              </button>
              <TemplateMenuItems
                onPick={onTemplate}
                onClose={() => setOpen(null)}
              />
            </div>
          )}
          {view === "mode" && (
            <div className="chat-model-view">
              <button type="button" className="chat-model-back" aria-label="Back" onClick={() => setView("root")}>
                <ChevronIcon />
              </button>
              <ModeMenuItems mode={chat?.mode} onPick={onModeChange} onClose={() => setOpen(null)} />
            </div>
          )}
          {view === "model" && (
            <ModelPickerBody
              open={open === "more"}
              chat={chat}
              models={models}
              providers={providers}
              onModelChange={onModelChange}
              onThinkingChange={onThinkingChange}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TemplateMenuItems({ onPick, onClose }: { onPick: (prompt: string) => void; onClose: () => void }) {
  return (
    <>
      {PROMPT_TEMPLATES.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => {
            onPick(item.prompt);
            onClose();
          }}
        >
          <strong>{item.label}</strong>
          <span>{item.hint}</span>
        </button>
      ))}
      <p className="chat-menu-label">Quick</p>
      {QUICK_PROMPTS.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => {
            onPick(item.prompt);
            onClose();
          }}
        >
          <strong>{item.label}</strong>
        </button>
      ))}
    </>
  );
}

function ModeMenuItems({
  mode,
  onPick,
  onClose,
}: {
  mode: AgentMode | undefined;
  onPick: (mode: AgentMode) => void;
  onClose: () => void;
}) {
  return (
    <>
      {AGENT_MODES.map((item) => (
        <button
          key={item.id}
          type="button"
          className={item.id === mode ? "is-active" : undefined}
          onClick={() => {
            onPick(item.id);
            onClose();
          }}
        >
          <strong>{item.label}</strong>
          <span>{item.hint}</span>
        </button>
      ))}
    </>
  );
}

function useOpenTransition(open: boolean, ms = 160) {
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setShown(true);
      return;
    }
    const timer = window.setTimeout(() => setShown(false), ms);
    return () => window.clearTimeout(timer);
  }, [open, ms]);
  return shown;
}

function LiveTurn({
  phase,
  prompt,
  selection,
  thinking,
  steps,
  edits,
  message,
  citations,
  onJump,
  onAccept,
  onReject,
  onInsertCitation,
}: {
  phase: string;
  prompt: string;
  selection: string | null;
  thinking: string;
  steps: AgentStep[];
  edits: PendingEdit[];
  message: string;
  citations: AgentCitation[];
  onJump: (id: string) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onInsertCitation: (citation: AgentCitation) => void;
}) {
  return (
    <div className="chat-live">
      {prompt ? (
        <div className="chat-live-prompt chat-prompt">
          <div className="chat-prompt-body is-open">
            <p>{prompt}</p>
            {selection ? (
              <div className="chat-user-chip">
                <SelectionIcon />
                <span>{clipHunk(selection)}</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {thinking ? (
        <Reasoning isStreaming={!message && !edits.length}>
          <ReasoningTrigger />
          <ReasoningContent>{thinking}</ReasoningContent>
        </Reasoning>
      ) : !message && !edits.length ? (
        <div className="chat-status">
          <Shimmer>{phase}</Shimmer>
        </div>
      ) : null}
      {steps.length ? (
        <ChainOfThought defaultOpen>
          <ChainOfThoughtHeader>{phase}</ChainOfThoughtHeader>
          <ChainOfThoughtContent>
            {steps.map((step) => (
              <ChainOfThoughtStep key={step.id} label={step.title} description={step.detail} status={step.status} hits={step.hits} />
            ))}
          </ChainOfThoughtContent>
        </ChainOfThought>
      ) : null}
      {edits.map((edit) => (
        <Hunk key={edit.id} edit={edit} onJump={onJump} onAccept={onAccept} onReject={onReject} />
      ))}
      {message ? (
        <CitedMessage text={message} citations={citations} onInsert={onInsertCitation} streaming />
      ) : null}
    </div>
  );
}

function TurnBlock({
  turn,
  canRevert,
  onJump,
  onAccept,
  onReject,
  onRevert,
  onInsertCitation,
}: {
  turn: AgentTurn;
  canRevert: boolean;
  onJump: (id: string) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onRevert: () => void;
  onInsertCitation: (citation: AgentCitation) => void;
}) {
  const [promptOpen, setPromptOpen] = useState(false);
  const longPrompt = turn.prompt.length > 160 || turn.prompt.split("\n").length > 4;
  const toolSteps = turn.tools?.map((tool, index) => ({
    id: `${turn.id}-${tool.name}-${index}`,
    title: tool.name.replace(/_/g, " "),
    status: "complete" as const,
  }));
  return (
    <section className="chat-turn">
      <div className="chat-prompt">
        <div className={`chat-prompt-body${promptOpen || !longPrompt ? " is-open" : ""}`}>
          <p>{turn.prompt}</p>
          {turn.selection && (
            <div className="chat-user-chip">
              <SelectionIcon />
              {turn.selections && turn.selections.length > 1 ? `${turn.selections.length} selections` : "Selection"}
            </div>
          )}
          {longPrompt && !promptOpen ? <div className="chat-prompt-fade" aria-hidden /> : null}
        </div>
        {(longPrompt || canRevert) && (
          <div className="chat-prompt-bar">
            {longPrompt ? (
              <button type="button" className="chat-prompt-more" onClick={() => setPromptOpen((value) => !value)}>
                {promptOpen ? "Show less" : "Show more"}
              </button>
            ) : (
              <span />
            )}
            {canRevert ? (
              <button type="button" className="chat-prompt-revert" onClick={onRevert}>
                Revert
              </button>
            ) : null}
          </div>
        )}
      </div>
      {turn.thinking ? (
        <Reasoning isStreaming={false} duration={turn.durationMs ? Math.max(1, Math.round(turn.durationMs / 1000)) : undefined}>
          <ReasoningTrigger />
          <ReasoningContent>{turn.thinking}</ReasoningContent>
        </Reasoning>
      ) : null}
      {toolSteps?.length ? (
        <ChainOfThought defaultOpen={false}>
          <ChainOfThoughtHeader>Steps</ChainOfThoughtHeader>
          <ChainOfThoughtContent>
            {toolSteps.map((step) => (
              <ChainOfThoughtStep key={step.id} label={step.title} status={step.status} />
            ))}
          </ChainOfThoughtContent>
        </ChainOfThought>
      ) : null}
      {turn.edits.map((edit) => (
        <Hunk key={edit.id} edit={edit} onJump={onJump} onAccept={onAccept} onReject={onReject} />
      ))}
      {turn.message ? (
        <CitedMessage
          text={turn.message}
          citations={turn.citations ?? []}
          onInsert={onInsertCitation}
          footer={turn.mock ? <p className="chat-muted">Mock proposal — add an API key for a model response.</p> : null}
        />
      ) : null}
      {turn.error ? <p className="chat-error">{turn.error}</p> : null}
    </section>
  );
}

const MemoTurnBlock = memo(
  TurnBlock,
  (previous, next) => previous.turn === next.turn && previous.canRevert === next.canRevert,
);

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
  const settled = edit.status !== "pending";
  const open = settled || !long || expanded;
  return (
    <div className={`chat-hunk is-${edit.status}${open ? "" : " is-collapsed"}`}>
      <div className="chat-hunk-head">
        <button type="button" className="chat-hunk-file" onClick={() => onJump(edit.id)}>
          Document
        </button>
        {edit.status !== "pending" && <span className="chat-hunk-status">{statusLabel(edit.status)}</span>}
        {long && edit.status === "pending" && (
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
      ) : null}
    </div>
  );
}

function hunkIsLong(edit: PendingEdit) {
  const text = `${edit.find}\n${edit.replace}`;
  return text.length > 140 || text.split(/\n/).length > 3;
}

function clipHunk(text: unknown) {
  const clean = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  return clean.length > 92 ? `${clean.slice(0, 92).trim()}…` : clean;
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

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.4" fill="currentColor" />
    </svg>
  );
}

function QueueIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4.2h8M4 7.9h8M4 11.6h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="m11.2 10.3 2.2 1.7-2.2 1.7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
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

function MoreIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.4 3 7.4 6 4.4 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
