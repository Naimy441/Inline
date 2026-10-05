"use client";

import type { EditorState } from "prosemirror-state";
import { useMemo } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";

type Entry = { pos: number; level: number; text: string };

function outline(state: EditorState): Entry[] {
  const entries: Entry[] = [];
  state.doc.forEach((node, pos) => {
    if (node.type.name === "title") entries.push({ pos, level: 0, text: node.textContent });
    else if (node.type.name === "heading" && (node.attrs.level as number) <= 4) entries.push({ pos, level: node.attrs.level as number, text: node.textContent });
  });
  return entries.filter((entry) => entry.text.trim());
}

/** Document outline in the left margin, like Google Docs' tabs pane. */
export function OutlinePanel({ session, state }: { session: DocumentSession; state: EditorState | null }) {
  const entries = useMemo(() => (state ? outline(state) : []), [state?.doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const head = state?.selection.head ?? 0;
  const current = [...entries].reverse().find((entry) => entry.pos <= head);
  return (
    <nav className="outline" aria-label="Outline">
      <div className="outline-title">Outline</div>
      {entries.length === 0 ? (
        <p className="outline-empty">Headings you add appear here.</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.pos}>
              <button
                type="button"
                className={`outline-item level-${entry.level}${current === entry ? " is-current" : ""}`}
                onClick={() => session.scrollTo(entry.pos + 1, entry.pos + 1)}
              >
                {entry.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
