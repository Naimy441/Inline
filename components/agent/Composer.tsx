"use client";

import { ArrowUp, Brain, ChevronDown, FileText, Image as ImageIcon, MessageCircleQuestion, Paperclip, PenLine, Square, TextQuote, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { AgentMode, Attachment, ChatSettings, ContextUsage, Effort, ModelOption, SelectionContext } from "@/lib/agent/types";
import { uploadFile } from "@/lib/client/api";
import { MenuButton } from "@/components/ui/Menu";
import { toast } from "@/components/ui/Toast";

export type ComposerHandle = { focus: () => void; setText: (text: string) => void };

const EFFORT_LABELS: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

const mod = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? "⌘" : "Ctrl+";

export const Composer = forwardRef<
  ComposerHandle,
  {
    running: boolean;
    disabled?: boolean;
    disabledReason?: string;
    settings: ChatSettings;
    models: ModelOption[];
    context?: ContextUsage;
    selection: SelectionContext | null;
    onClearSelection: () => void;
    onSend: (input: { text: string; attachments: Attachment[] }) => Promise<void> | void;
    onStop: () => void;
    onSettings: (patch: Partial<ChatSettings>) => void;
  }
>(function Composer({ running, disabled, disabledReason, settings, models, context, selection, onClearSelection, onSend, onStop, onSettings }, ref) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => textarea.current?.focus(),
    setText: (value) => {
      setText(value);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        const length = textarea.current?.value.length ?? 0;
        textarea.current?.setSelectionRange(length, length);
      });
    },
  }));

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 260)}px`;
  }, [text]);

  const attach = async (files: FileList | File[]) => {
    for (const file of Array.from(files).slice(0, 10)) {
      setUploading((count) => count + 1);
      try {
        const uploaded = await uploadFile(file);
        setAttachments((list) => [...list, { id: uploaded.id, name: uploaded.name, mime: uploaded.mime, size: uploaded.size, kind: uploaded.kind }]);
      } catch (error) {
        toast(error instanceof Error ? error.message : `Couldn't attach ${file.name}.`, { tone: "error" });
      } finally {
        setUploading((count) => count - 1);
      }
    }
  };

  const submit = async () => {
    const value = text.trim();
    if ((!value && !attachments.length) || disabled || uploading) return;
    setText("");
    const sent = attachments;
    setAttachments([]);
    try {
      await onSend({ text: value, attachments: sent });
    } catch {
      setText(value);
      setAttachments(sent);
    }
  };

  const model = models.find((item) => item.value === settings.model) ?? models[0];
  const efforts = model?.efforts.length ? model.efforts : (["low", "medium", "high"] as Effort[]);
  const canSend = Boolean(text.trim() || attachments.length) && !disabled && !uploading;

  return (
    <div
      className={`composer${disabled ? " is-disabled" : ""}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        void attach(event.dataTransfer.files);
      }}
    >
      {(selection || attachments.length > 0 || uploading > 0) && (
        <div className="composer-chips">
          {selection && (
            <span className="chip chip-quote" title={selection.text}>
              <TextQuote size={12} />
              <span className="chip-text">{selection.text}</span>
              <button type="button" className="chip-x" aria-label="Remove selection" onClick={onClearSelection}>
                <X size={12} />
              </button>
            </span>
          )}
          {attachments.map((attachment) => (
            <span key={attachment.id} className="chip">
              {attachment.kind === "image" ? <ImageIcon size={12} /> : <FileText size={12} />}
              <span className="chip-text">{attachment.name}</span>
              <button type="button" className="chip-x" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((list) => list.filter((item) => item.id !== attachment.id))}>
                <X size={12} />
              </button>
            </span>
          ))}
          {uploading > 0 && <span className="chip is-loading">Uploading…</span>}
        </div>
      )}
      <textarea
        ref={textarea}
        className="composer-input"
        rows={1}
        value={text}
        placeholder={
          disabled
            ? disabledReason ?? "Claude Code isn't available"
            : running
              ? "Queue a follow-up…"
              : settings.mode === "ask"
                ? "Ask about your document…"
                : "Ask Claude to write, edit or review…"
        }
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (files.length) {
            event.preventDefault();
            void attach(files);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape" && running) {
            event.preventDefault();
            onStop();
          }
        }}
        aria-label="Message Claude"
      />
      <div className="composer-bar">
        <div className="composer-controls">
          <MenuButton
            className="pill"
            label="Mode"
            placement="top-start"
            items={[
              {
                label: "Agent",
                hint: "Claude edits the document directly",
                icon: <PenLine size={14} />,
                checked: settings.mode === "agent",
                onSelect: () => onSettings({ mode: "agent" as AgentMode }),
              },
              {
                label: "Ask",
                hint: "Read-only: answers without editing",
                icon: <MessageCircleQuestion size={14} />,
                checked: settings.mode === "ask",
                onSelect: () => onSettings({ mode: "ask" as AgentMode }),
              },
            ]}
          >
            {settings.mode === "ask" ? <MessageCircleQuestion size={13} /> : <PenLine size={13} />}
            {settings.mode === "ask" ? "Ask" : "Agent"}
            <ChevronDown size={12} />
          </MenuButton>
          {models.length > 0 && (
            <MenuButton
              className="pill pill-ghost"
              label="Model"
              placement="top-start"
              items={models.map((item) => ({ label: item.displayName, hint: item.description, checked: item.value === model?.value, onSelect: () => onSettings({ model: item.value }) }))}
            >
              {model ? model.displayName.replace(/\s*\(.*\)$/, "") : "Model"}
              <ChevronDown size={12} />
            </MenuButton>
          )}
          {efforts.length > 0 && (
            <MenuButton
              className="pill pill-ghost"
              label="Thinking effort"
              placement="top-start"
              items={[
                { kind: "label", label: "Thinking effort" },
                ...efforts.map((value) => ({ label: EFFORT_LABELS[value], checked: settings.effort === value, onSelect: () => onSettings({ effort: value }) })),
              ]}
            >
              <Brain size={13} />
              {EFFORT_LABELS[settings.effort] ?? settings.effort}
            </MenuButton>
          )}
        </div>
        <div className="composer-actions">
          {context && context.percentage >= 40 && (
            <span className="context-meter" title={`${context.tokens.toLocaleString()} of ${context.maxTokens.toLocaleString()} tokens of context used. Claude summarizes older messages automatically when it fills up.`}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--border-strong)" strokeWidth="2" />
                <circle
                  cx="8"
                  cy="8"
                  r="6.5"
                  fill="none"
                  stroke={context.percentage > 85 ? "var(--warning)" : "var(--muted)"}
                  strokeWidth="2"
                  strokeDasharray={`${(Math.min(100, context.percentage) / 100) * 40.8} 40.8`}
                  transform="rotate(-90 8 8)"
                />
              </svg>
              {Math.round(context.percentage)}%
            </span>
          )}
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Attach files" data-tip="Attach images, PDFs or text files" onClick={() => fileInput.current?.click()} disabled={disabled}>
            <Paperclip size={15} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept="image/*,application/pdf,.txt,.md,.csv,.json"
            onChange={(event) => {
              if (event.target.files) void attach(event.target.files);
              event.target.value = "";
            }}
          />
          {running && !canSend ? (
            <button type="button" className="send-btn is-stop" aria-label="Stop" data-tip="Stop  Esc" onClick={onStop}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="send-btn" aria-label={running ? "Queue message" : "Send"} data-tip={running ? "Queue  ⏎" : "Send  ⏎"} disabled={!canSend} onClick={() => void submit()}>
              <ArrowUp size={16} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">
        <span>
          <kbd>⏎</kbd> send · <kbd>⇧⏎</kbd> new line · <kbd>{mod}L</kbd> add selection
        </span>
      </div>
    </div>
  );
});
