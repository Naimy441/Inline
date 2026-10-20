"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import type { DictionaryEntry } from "@/lib/dictionary/lookup";
import { Popover } from "@/components/ui/Popover";

type Lookup =
  | { status: "loading" }
  | { status: "ready"; entry: DictionaryEntry }
  | { status: "missing" }
  | { status: "error" };

/**
 * Google Docs-style dictionary for the word under a right-click: definitions,
 * and synonyms that replace it.
 */
export function DictionaryCard({
  word,
  anchor,
  readOnly,
  onClose,
  onReplace,
  onAsk,
}: {
  word: string;
  anchor: DOMRect;
  readOnly: boolean;
  onClose: () => void;
  onReplace: (synonym: string) => void;
  /** Offered when the dictionary has nothing to show. */
  onAsk?: () => void;
}) {
  const [lookup, setLookup] = useState<Lookup>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setLookup({ status: "loading" });
    api<{ found: true; meanings: DictionaryEntry["meanings"]; synonyms: string[] } | { found: false }>(
      `/api/dictionary/lookup?word=${encodeURIComponent(word)}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setLookup(result.found ? { status: "ready", entry: { word, meanings: result.meanings, synonyms: result.synonyms } } : { status: "missing" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setLookup(error instanceof ApiError && error.status === 404 ? { status: "missing" } : { status: "error" });
      });
    return () => controller.abort();
  }, [word]);

  const entry = lookup.status === "ready" ? lookup.entry : null;
  return (
    <Popover open onClose={onClose} anchor={anchor} placement="bottom-start" className="dictionary-card" role="dialog" label={`Dictionary for ${word}`}>
      <div className="dictionary-head" onMouseDown={(event) => event.preventDefault()}>
        <div className="dictionary-title">
          <div className="dictionary-word">{word}</div>
          <div className="dictionary-kicker">Dictionary</div>
        </div>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Close dictionary" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="dictionary-body" onMouseDown={(event) => event.preventDefault()}>
        {lookup.status === "loading" && <p className="dictionary-status">Looking up “{word}”…</p>}
        {lookup.status === "missing" && <p className="dictionary-status">No dictionary entry for “{word}”.</p>}
        {lookup.status === "error" && <p className="dictionary-status">The dictionary couldn’t be reached.</p>}
        {entry?.meanings.map((meaning) => (
          <section key={meaning.partOfSpeech} className="dictionary-meaning">
            <div className="dictionary-pos">{meaning.partOfSpeech}</div>
            <ol>
              {meaning.definitions.map((definition) => (
                <li key={definition}>{definition}</li>
              ))}
            </ol>
          </section>
        ))}
        {entry && entry.synonyms.length > 0 && (
          <section className="dictionary-meaning">
            <div className="dictionary-pos">Synonyms</div>
            <div className="dictionary-synonyms">
              {entry.synonyms.map((synonym) => (
                <button
                  key={synonym}
                  type="button"
                  className="dictionary-synonym"
                  disabled={readOnly}
                  aria-label={`Replace with ${synonym}`}
                  title={readOnly ? "Switch to editing to replace this word" : `Replace with ${synonym}`}
                  onClick={() => onReplace(synonym)}
                >
                  {synonym}
                </button>
              ))}
            </div>
          </section>
        )}
        {lookup.status !== "loading" && lookup.status !== "ready" && onAsk && (
          <button type="button" className="btn btn-secondary btn-sm dictionary-ask" onClick={onAsk}>
            Ask AI about “{word}”
          </button>
        )}
      </div>
    </Popover>
  );
}
