"use client";

import { useEffect, useMemo, useState } from "react";

export type PaletteCommand = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  shortcut?: string;
};

type Props = {
  commands: PaletteCommand[];
  onPick: (id: string) => void;
  onClose: () => void;
};

export function CommandPalette({ commands, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((item) => `${item.label} ${item.hint ?? ""} ${item.group}`.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((index) => Math.min(filtered.length - 1, index + 1));
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => Math.max(0, index - 1));
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const item = filtered[active];
        if (item) onPick(item.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, filtered, onClose, onPick]);

  const groups = [...new Set(filtered.map((item) => item.group))];

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
        <input
          autoFocus
          value={query}
          placeholder="Search commands, templates, and writing tools…"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="palette-list">
          {groups.map((group) => (
            <div key={group} className="palette-group">
              <p>{group}</p>
              {filtered
                .filter((item) => item.group === group)
                .map((item) => {
                  const index = filtered.indexOf(item);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={index === active ? "is-active" : undefined}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => onPick(item.id)}
                    >
                      <span>
                        <strong>{item.label}</strong>
                        {item.hint ? <em>{item.hint}</em> : null}
                      </span>
                      {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                    </button>
                  );
                })}
            </div>
          ))}
          {!filtered.length && <p className="palette-empty">No matching commands.</p>}
        </div>
      </div>
    </div>
  );
}
