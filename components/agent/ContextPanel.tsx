"use client";

import { ChartPie, ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import { contextView, type ContextViewRow } from "@/lib/agent/contextUsage";
import type { ContextUsage } from "@/lib/agent/types";
import { IconButton } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";

/**
 * The open chat's context window, closed until the header control is used.
 * Nothing is drawn until the chat has a real breakdown.
 */
export function ContextPanel({ context }: { context?: ContextUsage }) {
  const view = contextView(context);
  const [open, setOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!view) return null;
  const close = () => {
    setOpen(false);
    setFilesOpen(false);
  };
  return (
    <>
      <IconButton ref={button} label="Context" size="sm" active={open} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChartPie size={15} />
      </IconButton>
      <Popover open={open} onClose={close} anchor={button} placement="bottom-end" className="context-popover" label="Context">
        <div className="context-label">Context</div>
        <div className="context-headline">
          <span className="context-percent">{view.percentLabel}</span>
          <span className="context-fraction">{view.usageLabel}</span>
        </div>
        <div className="context-bar" role="img" aria-label={`${view.percentLabel} used, ${view.usageLabel}`}>
          {view.bar.map((segment) => (
            <span key={segment.name} className="context-bar-seg" style={{ width: `${segment.share * 100}%`, background: segment.color }} title={segment.name} />
          ))}
        </div>
        <ul className="context-rows">
          {view.rows.map((row) => (
            <li key={`${row.kind}:${row.name}`}>
              <ContextRow row={row} filesOpen={filesOpen} onToggle={() => setFilesOpen((value) => !value)} />
              {filesOpen && row.files && (
                <ul className="context-files">
                  {row.files.map((file) => (
                    <li key={file.path} className="context-file">
                      <span className="context-file-name">{file.name}</span>
                      <span className="context-file-tokens">{file.tokenLabel}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}

function ContextRow({ row, filesOpen, onToggle }: { row: ContextViewRow; filesOpen: boolean; onToggle: () => void }) {
  const dot = <span className={`context-dot${row.kind === "free" ? " is-free" : ""}`} style={row.color ? { background: row.color } : undefined} />;
  const body = (
    <>
      {dot}
      <span className="context-name">{row.name}</span>
      <span className="context-count">{row.tokenLabel}</span>
      <span className="context-pct">{row.percentLabel}</span>
      {row.files?.length ? <ChevronRight size={12} className={`context-chevron${filesOpen ? " is-open" : ""}`} /> : <span className="context-chevron-gap" />}
    </>
  );
  if (!row.files?.length) return <div className="context-row">{body}</div>;
  return (
    <button type="button" className="context-row" aria-expanded={filesOpen} onClick={onToggle}>
      {body}
    </button>
  );
}
