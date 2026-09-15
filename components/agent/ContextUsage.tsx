"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { ContextBucket } from "@/lib/agent/context";
import type { AgentUsage } from "@/lib/agent/types";

const BUCKET_COLORS: Record<string, string> = {
  system: "#9aa0a6",
  tools: "#c58af9",
  document: "#81c995",
  conversation: "#f6ad55",
  input: "#8ab4f8",
  output: "#f28b82",
  reasoning: "#fdd663",
  cached: "#78d9ec",
};

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}K`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

function bucketColor(id: string, index: number) {
  return BUCKET_COLORS[id] ?? ["#9aa0a6", "#c58af9", "#81c995", "#f6ad55", "#78d9ec"][index % 5];
}

export function ContextUsage({
  used,
  limit,
  usage,
  buckets,
}: {
  used: number;
  limit: number;
  usage?: AgentUsage;
  buckets?: ContextBucket[];
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const percentage = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - used / Math.max(1, limit));
  const segments = (buckets?.length
    ? buckets
    : [
        usage?.input ? { id: "input", label: "Input", tokens: usage.input } : null,
        usage?.output ? { id: "output", label: "Output", tokens: usage.output } : null,
        usage?.reasoning ? { id: "reasoning", label: "Reasoning", tokens: usage.reasoning } : null,
        usage?.cached ? { id: "cached", label: "Cache", tokens: usage.cached } : null,
      ].filter((item): item is ContextBucket => Boolean(item))) ?? [];
  const segmentTotal = Math.max(1, segments.reduce((sum, item) => sum + item.tokens, 0));

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
        title={`${used.toLocaleString()} of ${limit.toLocaleString()} tokens`}
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
            <strong>Context Usage</strong>
            <button type="button" className="agent-context-close" aria-label="Close" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <div className="agent-context-meta">
            <span>{percentage}% Full</span>
            <span>
              ~{formatTokens(used)} / {formatTokens(limit)} Tokens
            </span>
          </div>
          <div className="agent-context-bar" aria-hidden="true">
            {segments.map((bucket, index) => (
              <i
                key={bucket.id}
                style={{
                  width: `${(bucket.tokens / segmentTotal) * 100}%`,
                  background: bucketColor(bucket.id, index),
                }}
              />
            ))}
          </div>
          <ul className="agent-context-legend">
            {segments.map((bucket, index) => (
              <li key={bucket.id}>
                <span>
                  <i style={{ background: bucketColor(bucket.id, index) }} />
                  {bucket.label}
                </span>
                <em>{formatTokens(bucket.tokens)}</em>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
