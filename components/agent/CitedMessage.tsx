"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChatText } from "@/components/agent/ChatText";
import type { AgentCitation } from "@/lib/agent/types";

function splitCited(text: string, citations: AgentCitation[]) {
  if (!citations.length) return [{ type: "text" as const, value: text }];
  const pattern = /\[(\d+)\]/g;
  const parts: Array<{ type: "text"; value: string } | { type: "cite"; citation: AgentCitation; index: number }> = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index) });
    const index = Number(match[1]);
    const citation = citations[index - 1];
    if (citation) parts.push({ type: "cite", citation, index });
    else parts.push({ type: "text", value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}

function CitationPill({
  citation,
  index,
  onInsert,
}: {
  citation: AgentCitation;
  index: number;
  onInsert: (citation: AgentCitation) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const cardId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <span className="agent-cite" ref={wrapRef}>
      <button
        type="button"
        className="agent-cite-pill"
        aria-expanded={open}
        aria-controls={cardId}
        onClick={() => setOpen((value) => !value)}
      >
        {citation.url ? hostname(citation.url) : citation.author || index}
      </button>
      {open && (
        <span className="agent-cite-card" id={cardId} role="dialog">
          <strong>{citation.title}</strong>
          <span>
            {citation.author}
            {citation.year ? ` · ${citation.year}` : ""}
          </span>
          {citation.url ? <small>{citation.url}</small> : null}
          {citation.bibliography ? <q>{citation.bibliography}</q> : null}
          <button type="button" onClick={() => onInsert(citation)}>
            Insert {citation.inline}
          </button>
        </span>
      )}
    </span>
  );
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function CitedMessage({
  text,
  citations,
  onInsert,
  streaming,
  footer,
}: {
  text: string;
  citations: AgentCitation[];
  onInsert: (citation: AgentCitation) => void;
  streaming?: boolean;
  footer?: ReactNode;
}) {
  const lines = text.split("\n");
  return (
    <div className="chat-assistant">
      {lines.map((line, lineIndex) => (
        <p key={`line-${lineIndex}`}>
          {splitCited(line || " ", citations).map((part, partIndex) =>
            part.type === "cite" ? (
              <CitationPill key={`cite-${lineIndex}-${partIndex}`} citation={part.citation} index={part.index} onInsert={onInsert} />
            ) : (
              <ChatText
                key={`text-${lineIndex}-${partIndex}`}
                text={part.value === " " && !line ? "\u00a0" : part.value}
              />
            ),
          )}
          {streaming && lineIndex === lines.length - 1 ? <span className="chat-caret" /> : null}
        </p>
      ))}
      {footer}
      {citations.length ? (
        <div className="chat-citations" aria-label="Sources">
          <div className="chat-citations-head">
            <span>Sources</span>
            <small>{citations.length}</small>
          </div>
          <div className="chat-citations-list">
            {citations.map((citation, index) => (
              <div key={citation.id} className="chat-citation-card">
                <div className="chat-citation-copy">
                  <strong>
                    [{index + 1}] {citation.title}
                  </strong>
                  <span>
                    {citation.author} · {citation.year}
                  </span>
                </div>
                <button type="button" onClick={() => onInsert(citation)} title={`Insert ${citation.inline}`}>
                  {citation.inline}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
