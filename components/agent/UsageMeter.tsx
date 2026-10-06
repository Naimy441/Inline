"use client";

import { useRef, useState } from "react";
import type { ChatState, PlanUsage, UsageWindow } from "@/lib/agent/types";
import { USAGE_LIMIT_OPTIONS } from "@/lib/agent/types";
import { refreshPlanUsage, usePlanUsage } from "@/lib/client/planUsage";
import { Popover } from "@/components/ui/Popover";

function tone(percent: number) {
  return percent >= 95 ? "danger" : percent >= 75 ? "warning" : "normal";
}

function resetText(at: number | null, now: number) {
  if (!at) return "";
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  if (minutes < 60) return `Resets in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Resets in ${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return `Resets ${new Date(at).toLocaleDateString([], { weekday: "short" })} ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export function formatUsd(value: number) {
  if (value <= 0) return "$0.00";
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

function formatTokens(count: number) {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k` : String(count);
}

/** What this chat has cost so far, rewound replies included. */
export function chatSpend(chat: ChatState | null) {
  if (!chat) return 0;
  return chat.messages.reduce((sum, message) => sum + (message.role === "assistant" ? (message.usage?.costUsd ?? 0) : 0), chat.rewoundUsd ?? 0);
}

function Ring({ percent, state }: { percent: number; state: string }) {
  const circumference = 2 * Math.PI * 6.5;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className={`usage-ring-svg is-${state}`}>
      <circle cx="8" cy="8" r="6.5" fill="none" className="usage-ring-track" strokeWidth="2.2" />
      <circle
        cx="8"
        cy="8"
        r="6.5"
        fill="none"
        className="usage-ring-fill"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeDasharray={`${(Math.max(2, Math.min(100, percent)) / 100) * circumference} ${circumference}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

function WindowRow({ window, now }: { window: UsageWindow; now: number }) {
  const percent = Math.round(window.utilization);
  return (
    <div className="usage-row">
      <div className="usage-row-line">
        <span className="usage-row-label">{window.label}</span>
        <span className="usage-row-meta">
          {resetText(window.resetsAt, now)}
          <span className="usage-row-pct">{percent}%</span>
        </span>
      </div>
      <div className="usage-bar" role="progressbar" aria-label={window.label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <span className={`usage-bar-fill is-${tone(percent)}`} style={{ width: `${Math.min(100, Math.max(0, window.utilization))}%` }} />
      </div>
    </div>
  );
}

const PLAN_NAMES: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };

/**
 * The usage ring by the send button: the account's 5-hour and weekly plan
 * usage, what this chat has cost, and the limit Claude pauses at.
 */
export function UsageMeter({ chat, running, usageLimit, onUsageLimit }: { chat: ChatState | null; running: boolean; usageLimit: number | null; onUsageLimit: (limit: number | null) => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { usage } = usePlanUsage(running);
  const spent = chatSpend(chat);
  const context = chat?.context;
  const now = Date.now();
  const plan: PlanUsage | null = usage;
  const windows = plan?.available ? plan.windows.filter((window) => !window.resetsAt || window.resetsAt > now) : [];
  const main = windows.filter((window) => window.id === "five_hour" || window.id === "seven_day");
  const top = [...main].sort((a, b) => b.utilization - a.utilization)[0];
  const percent = top ? top.utilization : (context?.percentage ?? 0);
  if (!plan && !spent && !context) return null;
  const tip = top ? `${top.label} usage ${Math.round(top.utilization)}%` : "Usage";
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`usage-ring${open ? " is-open" : ""}`}
        aria-label="Usage"
        aria-expanded={open}
        data-tip={open ? undefined : tip}
        onClick={() => {
          if (!open) void refreshPlanUsage(15_000);
          setOpen((value) => !value);
        }}
      >
        <Ring percent={percent} state={top ? tone(top.utilization) : "normal"} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={button} placement="top-end" className="usage-popover">
        {top && top.utilization >= 75 && (
          <div className={`usage-alert is-${tone(top.utilization)}`}>
            {top.label} {top.utilization >= 100 ? "used up" : "almost used up"}: {Math.round(top.utilization)}%.{top.resetsAt ? ` ${resetText(top.resetsAt, now)}.` : ""}
          </div>
        )}
        <div className="usage-section">
          <div className="usage-section-head">Plan usage limits{plan?.plan ? ` · ${PLAN_NAMES[plan.plan] ?? plan.plan}` : ""}</div>
          {plan?.available ? (
            windows.length ? (
              windows.map((window) => <WindowRow key={window.id} window={window} now={now} />)
            ) : (
              <p className="usage-note">No usage reported yet.</p>
            )
          ) : (
            <p className="usage-note">{plan ? "This sign-in has no plan limits (an API key or a cloud provider), so only costs are shown." : "Checking usage…"}</p>
          )}
        </div>
        <div className="usage-section">
          <div className="usage-line">
            <span>This chat</span>
            <span className="usage-line-value">{formatUsd(spent)}</span>
          </div>
          {context && (
            <div className="usage-line">
              <span>Context</span>
              <span className="usage-line-value">
                {formatTokens(context.tokens)} of {formatTokens(context.maxTokens)} · {Math.round(context.percentage)}%
              </span>
            </div>
          )}
        </div>
        <div className="usage-section">
          <div className="usage-section-head">Pause Claude at</div>
          <div className="usage-limit" role="radiogroup" aria-label="Pause Claude at">
            {USAGE_LIMIT_OPTIONS.map((value) => (
              <button
                key={String(value)}
                type="button"
                role="radio"
                aria-checked={(usageLimit ?? null) === value}
                className={`usage-limit-option${(usageLimit ?? null) === value ? " is-active" : ""}`}
                disabled={value !== null && !plan?.available}
                onClick={() => onUsageLimit(value)}
              >
                {value === null ? "No limit" : `${value}%`}
              </button>
            ))}
          </div>
          <p className="usage-note">Claude stops when your 5-hour or weekly usage reaches this share of your plan.</p>
        </div>
      </Popover>
    </>
  );
}
