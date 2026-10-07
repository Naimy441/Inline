"use client";

import {
  FolderInput,
  FolderPlus,
  FolderTree,
  FolderX,
  BookOpen,
  BookPlus,
  Check,
  ChevronRight,
  CircleAlert,
  Download,
  FilePlus2,
  FileSearch,
  FileText,
  Files,
  Globe,
  Hash,
  History,
  ImageIcon,
  ListTodo,
  ListTree,
  Lock,
  MessageSquare,
  Paintbrush,
  PanelsTopLeft,
  Paperclip,
  Pencil,
  PenLine,
  RotateCcw,
  Search,
  Settings2,
  SpellCheck,
  Sparkles,
  TextCursorInput,
  Undo2,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ToolPart } from "@/lib/agent/types";
import { shortToolName } from "@/lib/agent/types";

type Described = { icon: ReactNode; verb: string; target?: string; live: string };

function str(value: unknown, max = 80) {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function host(url: unknown) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "");
  } catch {
    return str(url, 40);
  }
}

function unescapeJson(raw: string) {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    // Cut mid-escape while streaming: drop the partial escape and decode the rest.
    try {
      return JSON.parse(`"${raw.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "")}"`) as string;
    } catch {
      return raw;
    }
  }
}

/** Partial JSON while the input streams: every value of a string field that has started to arrive, in order. */
function previewFields(preview: string | undefined, field: string) {
  if (!preview) return [];
  return [...preview.matchAll(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, "g"))].map((match) => unescapeJson(match[1]!));
}

/** Partial JSON while the input streams: pull out a string field if it has arrived. */
function previewField(preview: string | undefined, field: string) {
  return previewFields(preview, field)[0];
}

/** "some_tool" or "SomeTool" as "Some tool", for tools without their own wording. */
export function humanizeToolName(name: string) {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

export function describeTool(part: ToolPart): Described {
  const name = shortToolName(part.name);
  const input = part.input ?? {};
  const field = (key: string) => (input[key] as unknown) ?? previewField(part.inputPreview, key);
  const lines = () => {
    const from = input.offset ?? input.from_line;
    const to = input.limit ? Number(input.offset ?? 1) + Number(input.limit) - 1 : input.to_line;
    return from ? `lines ${from}${to ? `–${to}` : ""}` : undefined;
  };
  switch (name) {
    case "read_document":
      return { icon: <BookOpen size={14} />, verb: "Read", target: lines() ?? "document", live: "Reading" };
    case "edit_document":
      return { icon: <PenLine size={14} />, verb: "Edited", target: str(field("old_string"), 48) ? `“${str(field("old_string"), 48)}”` : "document", live: "Editing" };
    case "multi_edit_document": {
      const count = Array.isArray(input.edits) ? input.edits.length : undefined;
      return { icon: <PenLine size={14} />, verb: "Edited", target: count ? `${count} passages` : "document", live: "Editing" };
    }
    case "write_document":
      return { icon: <FileText size={14} />, verb: "Wrote", target: "the document", live: "Writing" };
    case "insert_content":
      return { icon: <TextCursorInput size={14} />, verb: "Added", target: str(field("content"), 48) ?? "content", live: "Adding" };
    case "search_document":
      return { icon: <Search size={14} />, verb: "Searched for", target: str(field("pattern"), 48) ? `“${str(field("pattern"), 48)}”` : undefined, live: "Searching" };
    case "get_outline":
      return { icon: <ListTree size={14} />, verb: "Read", target: "the outline", live: "Reading" };
    case "count_words":
      return { icon: <Hash size={14} />, verb: "Counted words in", target: typeof input.text === "string" ? "a draft" : lines() ?? "the document", live: "Counting words in" };
    case "get_page_count":
      return { icon: <Files size={14} />, verb: "Counted", target: "pages", live: "Counting" };
    case "format_text":
      return { icon: <Paintbrush size={14} />, verb: "Formatted", target: str(field("text"), 48) ? `“${str(field("text"), 48)}”` : "text", live: "Formatting" };
    case "set_paragraph_style":
      return { icon: <Paintbrush size={14} />, verb: "Styled", target: "paragraphs", live: "Styling" };
    case "get_document_settings":
      return { icon: <Settings2 size={14} />, verb: "Checked", target: "page setup", live: "Checking" };
    case "update_document_settings":
      return { icon: <Settings2 size={14} />, verb: "Changed", target: "page setup", live: "Changing" };
    case "get_editor_context":
      return { icon: <TextCursorInput size={14} />, verb: "Looked at", target: "your selection", live: "Looking at" };
    case "get_pending_changes":
      return { icon: <FileSearch size={14} />, verb: "Reviewed", target: "pending changes", live: "Reviewing" };
    case "keep_changes":
      return { icon: <Check size={14} />, verb: "Kept", target: "changes", live: "Keeping" };
    case "revert_changes":
      return { icon: <Undo2 size={14} />, verb: "Reverted", target: "changes", live: "Reverting" };
    case "list_comments":
      return { icon: <MessageSquare size={14} />, verb: "Read", target: "comments", live: "Reading" };
    case "add_comment":
      return { icon: <MessageSquare size={14} />, verb: "Commented on", target: str(field("text"), 40) ? `“${str(field("text"), 40)}”` : "text", live: "Commenting" };
    case "reply_to_comment":
      return { icon: <MessageSquare size={14} />, verb: "Replied to", target: "a comment", live: "Replying" };
    case "resolve_comment":
      return { icon: <Check size={14} />, verb: "Resolved", target: "a comment", live: "Resolving" };
    case "delete_comment":
      return { icon: <MessageSquare size={14} />, verb: "Deleted", target: "a comment", live: "Deleting" };
    case "lock_text":
      return input.locked === false
        ? { icon: <Lock size={14} />, verb: "Unlocked", target: str(field("text"), 40) ? `“${str(field("text"), 40)}”` : "text", live: "Unlocking" }
        : { icon: <Lock size={14} />, verb: "Locked", target: str(field("text"), 40) ? `“${str(field("text"), 40)}”` : "text", live: "Locking" };
    case "list_locked_text":
      return { icon: <Lock size={14} />, verb: "Checked", target: "locked text", live: "Checking" };
    case "insert_image":
      return { icon: <ImageIcon size={14} />, verb: "Inserted", target: "an image", live: "Inserting" };
    case "read_attachment":
      return { icon: <Paperclip size={14} />, verb: "Read", target: "an attachment", live: "Reading" };
    case "check_spelling":
      return { icon: <SpellCheck size={14} />, verb: "Checked", target: "spelling", live: "Checking" };
    case "add_to_dictionary": {
      const words = Array.isArray(input.words) ? (input.words as unknown[]).filter((word): word is string => typeof word === "string") : [];
      return { icon: <BookPlus size={14} />, verb: "Added", target: words.length ? `${words.slice(0, 3).map((word) => `“${word}”`).join(", ")}${words.length > 3 ? ` and ${words.length - 3} more` : ""} to the dictionary` : "words to the dictionary", live: "Adding" };
    }
    case "list_tabs":
      return { icon: <PanelsTopLeft size={14} />, verb: "Listed", target: "tabs", live: "Listing" };
    case "create_tab":
      return { icon: <PanelsTopLeft size={14} />, verb: "Created", target: str(field("title"), 40) ? `the tab “${str(field("title"), 40)}”` : "a tab", live: "Creating" };
    case "rename_tab":
      return { icon: <Pencil size={14} />, verb: "Renamed", target: str(field("title"), 40) ? `a tab to “${str(field("title"), 40)}”` : "a tab", live: "Renaming" };
    case "analyze_writing":
      return { icon: <Sparkles size={14} />, verb: "Analyzed", target: "the writing", live: "Analyzing" };
    case "list_documents":
      return { icon: <FileText size={14} />, verb: "Listed", target: "documents", live: "Listing" };
    case "list_library":
      return { icon: <FolderTree size={14} />, verb: "Looked through", target: "your documents", live: "Looking through" };
    case "list_folders":
      return { icon: <FolderTree size={14} />, verb: "Listed", target: "folders", live: "Listing" };
    case "move_documents": {
      const moves = Array.isArray(input.moves) ? (input.moves as Array<{ folder?: unknown }>) : [];
      const folders = new Set(moves.map((move) => (typeof move.folder === "string" ? move.folder : "")));
      const only = folders.size === 1 ? [...folders][0] : undefined;
      const count = moves.length === 1 ? "a document" : moves.length ? `${moves.length} documents` : "documents";
      const where = only === undefined ? "" : only && !/^[A-Za-z0-9_-]{10}$/.test(only) ? ` to “${str(only, 40)}”` : only === "" ? " to the top level" : "";
      return { icon: <FolderInput size={14} />, verb: "Moved", target: `${count}${where}`, live: "Moving" };
    }
    case "create_folder":
      return { icon: <FolderPlus size={14} />, verb: "Created", target: str(field("name"), 40) ? `the folder “${str(field("name"), 40)}”` : "a folder", live: "Creating" };
    case "update_folder":
      return { icon: <Pencil size={14} />, verb: "Updated", target: "a folder", live: "Updating" };
    case "delete_folder":
      return { icon: <FolderX size={14} />, verb: "Deleted", target: "a folder", live: "Deleting" };
    case "create_document":
      return { icon: <FilePlus2 size={14} />, verb: "Created", target: str(field("title"), 40) ?? "a document", live: "Creating" };
    case "open_document":
      return { icon: <FileText size={14} />, verb: "Opened", target: "a document", live: "Opening" };
    case "save_version":
      return { icon: <History size={14} />, verb: "Saved", target: "a version", live: "Saving" };
    case "list_versions":
      return { icon: <History size={14} />, verb: "Checked", target: "version history", live: "Checking" };
    case "restore_version":
      return { icon: <RotateCcw size={14} />, verb: "Restored", target: "a version", live: "Restoring" };
    case "export_document":
      return { icon: <Download size={14} />, verb: "Exported", target: typeof input.format === "string" ? input.format.toUpperCase() : undefined, live: "Exporting" };
    case "WebSearch":
      return { icon: <Globe size={14} />, verb: "Searched the web for", target: str(field("query"), 60) ? `“${str(field("query"), 60)}”` : undefined, live: "Searching the web" };
    case "WebFetch":
      return { icon: <Globe size={14} />, verb: "Read", target: host(field("url")), live: "Reading" };
    case "TodoWrite":
      return { icon: <ListTodo size={14} />, verb: "Updated", target: "the plan", live: "Planning" };
    default:
      return { icon: <Sparkles size={14} />, verb: humanizeToolName(name), live: humanizeToolName(name) };
  }
}

/**
 * Long content trimmed to a few lines with a fade and a "Show all" toggle,
 * instead of a box that scrolls inside the chat. While `live` (the text is
 * still streaming) it shows the newest lines.
 */
export function Clamp({ children, live = false, max = 150 }: { children: ReactNode; live?: boolean; max?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const height = inner.current?.offsetHeight ?? 0;
    setOverflows(height > max + 24);
  });
  const clamped = overflows && !expanded;
  return (
    <div className={`clamp${clamped ? " is-clamped" : ""}${live ? " is-live" : ""}`}>
      <div className="clamp-body" style={clamped ? { maxHeight: max } : undefined}>
        <div ref={inner}>{children}</div>
      </div>
      {overflows && !live && (
        <button type="button" className="clamp-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

type Diff = { before?: string; after?: string };

const WRITE_TOOLS = new Set(["edit_document", "multi_edit_document", "write_document", "insert_content"]);

/** What a writing tool puts in the document, from its input, or from the partial input while it streams. */
function writeDiffs(part: ToolPart): Diff[] {
  const name = shortToolName(part.name);
  const input = part.input;
  const preview = part.inputPreview;
  if (name === "edit_document") return [{ before: str2(input?.old_string) ?? previewField(preview, "old_string"), after: str2(input?.new_string) ?? previewField(preview, "new_string") }];
  if (name === "multi_edit_document") {
    if (input && Array.isArray(input.edits)) return (input.edits as Array<{ old_string?: string; new_string?: string }>).map((edit) => ({ before: edit.old_string, after: edit.new_string }));
    const before = previewFields(preview, "old_string");
    const after = previewFields(preview, "new_string");
    return before.map((text, index) => ({ before: text, after: after[index] }));
  }
  if (name === "write_document" || name === "insert_content") return [{ after: str2(input?.content) ?? previewField(preview, "content") }];
  return [];
}

function str2(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function DiffBlock({ before, after, caret }: Diff & { caret?: boolean }) {
  return (
    <div className="tool-diff">
      {before ? <div className="tool-diff-del">{before}</div> : null}
      {after || caret ? (
        <div className="tool-diff-add">
          {after}
          {caret && <span className="tool-caret" aria-hidden />}
        </div>
      ) : null}
    </div>
  );
}

export function ToolCall({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const described = describeTool(part);
  const running = part.status === "pending" || part.status === "running";
  const failed = part.status === "error";
  const writes = WRITE_TOOLS.has(shortToolName(part.name));
  const diffs = writes ? writeDiffs(part).filter((diff) => diff.before || diff.after) : [];
  const result = part.result?.trim();
  return (
    <div className={`tool${running ? " is-running" : ""}${failed ? " is-error" : ""}${open ? " is-open" : ""}${writes ? " is-write" : ""}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="tool-icon">{described.icon}</span>
        <span className="tool-label">
          <span className={running ? "shimmer" : undefined}>{running ? described.live : described.verb}</span>
          {described.target && <span className="tool-target"> {described.target}</span>}
        </span>
        {failed && <CircleAlert size={13} className="tool-status-error" />}
        <ChevronRight size={13} className="tool-chevron" />
      </button>
      {/* What Claude writes is shown as it arrives, trimmed until expanded. A failed write is only in the details. */}
      {diffs.length > 0 && !failed && (
        <div className={`tool-write${running ? " is-live" : ""}`}>
          <Clamp live={running}>
            {diffs.map((diff, index) => (
              <DiffBlock key={index} before={diff.before} after={diff.after} caret={running && part.status === "pending" && index === diffs.length - 1} />
            ))}
          </Clamp>
        </div>
      )}
      {open && (
        <div className="tool-body">
          {failed && diffs.length > 0 && (
            <Clamp>
              {diffs.map((diff, index) => (
                <DiffBlock key={index} before={diff.before} after={diff.after} />
              ))}
            </Clamp>
          )}
          {result ? (
            <Clamp>
              <pre className={`tool-result${failed ? " is-error" : ""}`}>{result.length > 4000 ? `${result.slice(0, 4000)}\n…` : result}</pre>
            </Clamp>
          ) : !diffs.length ? (
            <pre className="tool-result">{JSON.stringify(part.input ?? {}, null, 2)}</pre>
          ) : null}
        </div>
      )}
    </div>
  );
}
