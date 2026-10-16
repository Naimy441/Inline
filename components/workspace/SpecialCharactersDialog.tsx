"use client";

import { useMemo, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { SPECIAL_CHARACTER_GROUPS } from "@/lib/editor/specialCharacters";

/** Text style, so a symbol that also has an emoji form does not draw as one. */
const TEXT_PRESENTATION = "\uFE0E";

function shown(char: string) {
  return /\p{Emoji}/u.test(char) ? char + TEXT_PRESENTATION : char;
}

export function SpecialCharactersDialog({ open, onClose, onInsert }: { open: boolean; onClose: () => void; onInsert: (char: string) => void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("Punctuation");
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    // A search looks through every category. The menu only narrows the grid while browsing.
    const source = q || category === "All" ? SPECIAL_CHARACTER_GROUPS : SPECIAL_CHARACTER_GROUPS.filter((group) => group.name === category);
    if (!q) return source;
    const hex = /^[0-9a-f]{2,6}$/.test(q) ? Number.parseInt(q, 16) : null;
    return source
      .map((group) => ({
        ...group,
        chars: group.chars.filter(([char, name]) => char === q || char.toLowerCase() === q || name.includes(q) || (hex != null && char.codePointAt(0) === hex)),
      }))
      .filter((group) => group.chars.length);
  }, [query, category]);

  // Closed: skip building the grid, since the workspace re-renders on every keystroke.
  if (!open) return null;
  return (
    <Dialog open={open} onClose={onClose} title="Special characters" width={640}>
      <div className="charmap-tools">
        <input className="input" placeholder="Search, e.g. arrow, euro, check" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus aria-label="Search characters" />
        <select
          className="input"
          aria-label="Character category"
          value={query.trim() ? "All" : category}
          onChange={(event) => {
            setCategory(event.target.value);
            setQuery("");
          }}
        >
          <option value="All">All categories</option>
          {SPECIAL_CHARACTER_GROUPS.map((group) => (
            <option key={group.name} value={group.name}>
              {group.name}
            </option>
          ))}
        </select>
      </div>
      <div className="charmap">
        {groups.length === 0 && <p className="muted">No characters match “{query}”.</p>}
        {groups.map((group) => (
          <section key={group.name}>
            <h4>{group.name}</h4>
            <div className="charmap-grid">
              {group.chars.map(([char, name]) => (
                <button key={char} type="button" className="charmap-cell" title={name} aria-label={name} onClick={() => onInsert(char)}>
                  {shown(char)}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
