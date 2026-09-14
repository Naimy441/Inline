"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { AgentUsage } from "@/lib/agent/types";

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

export function ContextUsage({
  used,
  limit,
  usage,
}: {
  used: number;
  limit: number;
  usage?: AgentUsage;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const percentage = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - used / Math.max(1, limit));

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="agent-context" ref={wrapRef}>
      <button
        type="button"
        className="agent-context-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        title={`${used.toLocaleString()} of ${limit.toLocaleString()} estimated tokens`}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="12" r={radius} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transform: "rotate(-90deg)", transformOrigin: "center" } as CSSProperties}
          />
        </svg>
        <span>{percentage}%</span>
      </button>
      {open && (
        <div className="agent-context-card" id={panelId} role="dialog" aria-label="Context usage">
          <div className="agent-context-head">
            <strong>{percentage}%</strong>
            <span>
              {formatTokens(used)} / {formatTokens(limit)}
            </span>
          </div>
          <div className="agent-context-bar" aria-hidden="true">
            <i style={{ width: `${percentage}%` }} />
          </div>
          {usage ? (
            <dl>
              {usage.input ? (
                <div>
                  <dt>Input</dt>
                  <dd>{formatTokens(usage.input)}</dd>
                </div>
              ) : null}
              {usage.output ? (
                <div>
                  <dt>Output</dt>
                  <dd>{formatTokens(usage.output)}</dd>
                </div>
              ) : null}
              {usage.reasoning ? (
                <div>
                  <dt>Reasoning</dt>
                  <dd>{formatTokens(usage.reasoning)}</dd>
                </div>
              ) : null}
              {usage.cached ? (
                <div>
                  <dt>Cache</dt>
                  <dd>{formatTokens(usage.cached)}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p>Estimated tokens for this chat, including the document and prompt.</p>
          )}
        </div>
      )}
    </div>
  );
}
