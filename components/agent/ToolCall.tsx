"use client";

import {
  BookOpen,
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
  ListTree,
  MessageSquare,
  Paintbrush,
  PenLine,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  TextCursorInput,
  Undo2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
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

/** Partial JSON while the input streams: pull out a string field if it has arrived. */
function previewField(preview: string | undefined, field: string) {
  if (!preview) return undefined;
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(preview);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
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
    case "analyze_writing":
      return { icon: <Sparkles size={14} />, verb: "Analyzed", target: "the writing", live: "Analyzing" };
    case "list_documents":
      return { icon: <FileText size={14} />, verb: "Listed", target: "documents", live: "Listing" };
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
    default:
      return { icon: <Sparkles size={14} />, verb: name.replace(/_/g, " "), live: name.replace(/_/g, " ") };
  }
}

function DiffBlock({ before, after }: { before?: string; after?: string }) {
  return (
    <div className="tool-diff">
      {before ? <div className="tool-diff-del">{before}</div> : null}
      {after ? <div className="tool-diff-add">{after}</div> : null}
    </div>
  );
}

function details(part: ToolPart) {
  const name = shortToolName(part.name);
  const input = part.input ?? {};
  if (name === "edit_document") return <DiffBlock before={String(input.old_string ?? "")} after={String(input.new_string ?? "")} />;
  if (name === "multi_edit_document" && Array.isArray(input.edits)) {
    return (
      <>
        {(input.edits as Array<{ old_string?: string; new_string?: string }>).map((edit, index) => (
          <DiffBlock key={index} before={edit.old_string} after={edit.new_string} />
        ))}
      </>
    );
  }
  if (name === "write_document" || name === "insert_content") return <DiffBlock after={String(input.content ?? "")} />;
  return null;
}

export function ToolCall({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const described = describeTool(part);
  const running = part.status === "pending" || part.status === "running";
  const failed = part.status === "error";
  const detail = part.input ? details(part) : null;
  const result = part.result?.trim();
  return (
    <div className={`tool${running ? " is-running" : ""}${failed ? " is-error" : ""}${open ? " is-open" : ""}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="tool-icon">{described.icon}</span>
        <span className="tool-label">
          <span className={running ? "shimmer" : undefined}>{running ? described.live : described.verb}</span>
          {described.target && <span className="tool-target"> {described.target}</span>}
        </span>
        {failed && <CircleAlert size={13} className="tool-status-error" />}
        <ChevronRight size={13} className="tool-chevron" />
      </button>
      {open && (
        <div className="tool-body">
          {detail}
          {result && (
            <pre className={`tool-result${failed ? " is-error" : ""}`}>{result.length > 4000 ? `${result.slice(0, 4000)}\n…` : result}</pre>
          )}
          {!detail && !result && <pre className="tool-result">{JSON.stringify(part.input ?? {}, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}
