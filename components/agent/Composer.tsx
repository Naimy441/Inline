"use client";

import { ArrowUp, Brain, ChevronDown, FileText, Image as ImageIcon, MessageCircleQuestion, Paperclip, PenLine, Square, TextQuote, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AgentMode, Attachment, ChatSettings, DocumentMention, Effort, ModelOption, SelectionContext } from "@/lib/agent/types";
import { api, uploadFile } from "@/lib/client/api";
import { MenuButton } from "@/components/ui/Menu";
import { CommandsDialog, useCommands } from "@/components/agent/CommandsDialog";
import { expandSlashCommand, matchCommands, matchDocuments, type SlashCommand } from "@/lib/agent/commands";
import { toast } from "@/components/ui/Toast";
import { Shortcut } from "@/components/ui/Button";
import { loadDraft, saveDraft } from "@/lib/client/drafts";

/** Titles of the user's other documents, for @-mentions (loaded once per panel). */
function useDocumentTitles(exclude: string | null) {
  const [documents, setDocuments] = useState<DocumentMention[]>([]);
  useEffect(() => {
    let live = true;
    api<{ documents: Array<{ id: string; title: string }> }>("/api/documents")
      .then(({ documents }) => live && setDocuments(documents.map(({ id, title }) => ({ id, title: title || "Untitled" }))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return exclude ? documents.filter((doc) => doc.id !== exclude) : documents;
}

export type ComposerHandle = { focus: () => void; setText: (text: string) => void };

const EFFORT_LABELS: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

export const Composer = forwardRef<
  ComposerHandle,
  {
    running: boolean;
    disabled?: boolean;
    disabledReason?: string;
    settings: ChatSettings;
    models: ModelOption[];
    /** The usage meter, shown by the send button. */
    meter?: ReactNode;
    selection: SelectionContext | null;
    onClearSelection: () => void;
    /** The open document, left out of @-mention suggestions. The unsent message is remembered per document. */
    documentId?: string | null;
    onSend: (input: { text: string; attachments: Attachment[]; mentions: DocumentMention[] }) => Promise<void> | void;
    onStop: () => void;
    onSettings: (patch: Partial<ChatSettings>) => void;
    /** The user is writing a message: a chance to start Claude Code before it's sent. */
    onWarm?: () => void;
  }
>(function Composer({ running, disabled, disabledReason, settings, models, meter, selection, documentId, onClearSelection, onSend, onStop, onSettings, onWarm }, ref) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const commands = useCommands();
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsHidden, setCommandsHidden] = useState(false);
  const [managing, setManaging] = useState(false);
  const [mentions, setMentions] = useState<DocumentMention[]>([]);
  const [caret, setCaret] = useState(0);

  // Pick up the message left unsent when the panel was last closed. Read after
  // mounting, so the server render and the first client render agree.
  const restored = useRef<string | null>(null);
  const skipSave = useRef(false);
  useLayoutEffect(() => {
    if (!documentId || restored.current === documentId) return;
    restored.current = documentId;
    // This render's effects still see the values from before the restore.
    skipSave.current = true;
    const draft = loadDraft(documentId);
    setText(draft.text);
    setAttachments(draft.attachments);
    setMentions(draft.mentions);
    setCaret(draft.text.length);
  }, [documentId]);
  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    if (documentId && restored.current === documentId) saveDraft(documentId, { text, attachments, mentions });
  }, [documentId, text, attachments, mentions]);

  const documents = useDocumentTitles(documentId ?? null);
  const slash = /^\/([a-z0-9-]*)$/i.exec(text);
  // Titles have spaces, so the query runs to the caret; the list hides once nothing matches.
  const at = /(?:^|\s)@([^@\n]{0,40})$/.exec(text.slice(0, caret));
  const suggestions = slash && !commandsHidden ? matchCommands(slash[1]!, commands).slice(0, 8) : [];
  const docSuggestions = !slash && at && !commandsHidden ? matchDocuments(at[1]!, documents).slice(0, 8) : [];
  const optionCount = suggestions.length || docSuggestions.length;
  const pickDocument = (doc: DocumentMention) => {
    const start = caret - at![1]!.length - 1;
    const label = `@${doc.title.replace(/\s+/g, " ")} `;
    const next = text.slice(0, start) + label + text.slice(caret);
    setText(next);
    setMentions((list) => (list.some((item) => item.id === doc.id) ? list : [...list, doc]));
    setCommandIndex(0);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(start + label.length, start + label.length);
      setCaret(start + label.length);
    });
  };
  const pickCommand = (command: SlashCommand) => {
    setText(`/${command.name} `);
    setCommandIndex(0);
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Text set from outside (a suggestion) puts the caret at its end as soon as it's on screen,
  // not a frame later, when it could undo a selection the user (or a test) has just made.
  const caretToEnd = useRef(false);
  const placeCaretAtEnd = () => {
    const element = textarea.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  };
  useLayoutEffect(() => {
    if (!caretToEnd.current) return;
    caretToEnd.current = false;
    placeCaretAtEnd();
  }, [text]);

  useImperativeHandle(ref, () => ({
    focus: () => textarea.current?.focus(),
    setText: (value) => {
      if (value === text) {
        placeCaretAtEnd();
        return;
      }
      caretToEnd.current = true;
      setText(value);
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
    const value = expandSlashCommand(text.trim(), commands);
    if ((!value && !attachments.length) || disabled || uploading) return;
    setText("");
    const sent = attachments;
    // Only documents whose @-mention is still in the text.
    const mentioned = mentions.filter((doc) => value.includes(`@${doc.title.replace(/\s+/g, " ")}`));
    setAttachments([]);
    setMentions([]);
    try {
      await onSend({ text: value, attachments: sent, mentions: mentioned });
    } catch {
      setText(value);
      setAttachments(sent);
      setMentions(mentioned);
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
      {suggestions.length > 0 && (
        <div className="composer-commands" role="listbox" aria-label="Commands">
          {suggestions.map((command, index) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={index === commandIndex}
              className={`composer-command${index === commandIndex ? " is-active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pickCommand(command)}
            >
              <span className="composer-command-name">/{command.name}</span>
              <span className="composer-command-desc">{command.description}</span>
            </button>
          ))}
          <button type="button" className="composer-command composer-command-manage" onMouseDown={(event) => event.preventDefault()} onClick={() => setManaging(true)}>
            Manage commands…
          </button>
        </div>
      )}
      {docSuggestions.length > 0 && (
        <div className="composer-commands" role="listbox" aria-label="Documents">
          {docSuggestions.map((doc, index) => (
            <button
              key={doc.id}
              type="button"
              role="option"
              aria-selected={index === commandIndex}
              className={`composer-command${index === commandIndex ? " is-active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pickDocument(doc)}
            >
              <FileText size={13} />
              <span className="composer-command-name">{doc.title}</span>
            </button>
          ))}
        </div>
      )}
      <CommandsDialog open={managing} onClose={() => setManaging(false)} />
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
              : !documentId
                ? settings.mode === "ask"
                  ? "Ask about your documents…"
                  : "Ask Claude to organize or find documents…"
                : settings.mode === "ask"
                  ? "Ask about your document…"
                  : "Ask Claude to write, edit or review…"
        }
        disabled={disabled}
        onFocus={() => onWarm?.()}
        onChange={(event) => {
          if (event.target.value.trim()) onWarm?.();
          setText(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setCommandIndex(0);
          setCommandsHidden(false);
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (files.length) {
            event.preventDefault();
            void attach(files);
          }
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={(event) => {
          if (optionCount) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setCommandIndex((index) => (index + (event.key === "ArrowDown" ? 1 : optionCount - 1)) % optionCount);
              return;
            }
            if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              const index = Math.min(commandIndex, optionCount - 1);
              if (suggestions.length) pickCommand(suggestions[index]!);
              else pickDocument(docSuggestions[index]!);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setCommandsHidden(true);
              return;
            }
          }
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
          {meter}
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Attach files" data-tip="Attach images, PDFs or text files" onClick={() => fileInput.current?.click()} disabled={disabled}>
            <Paperclip size={15} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept="image/*,application/pdf,.txt,.md,.csv,.json,.docx"
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
          <kbd>⏎</kbd> send · <kbd>⇧⏎</kbd> new line
          {documentId && (
            <>
              {" "}
              · <kbd><Shortcut keys="⌘L" /></kbd> add selection
            </>
          )}
        </span>
      </div>
    </div>
  );
});
