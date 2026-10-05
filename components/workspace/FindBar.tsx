"use client";

import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from "lucide-react";
import type { EditorState } from "prosemirror-state";
import { useEffect, useRef, useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { findState, findStep, replaceAll, replaceCurrent, setFindQuery, type FindQuery } from "@/lib/editor/find";
import { toast } from "@/components/ui/Toast";

export function FindBar({
  session,
  state,
  replace,
  onClose,
}: {
  session: DocumentSession;
  state: EditorState | null;
  replace: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState<FindQuery>(() => {
    const view = session.view;
    const selected = view && !view.state.selection.empty ? view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, " ") : "";
    return { text: selected.length < 100 ? selected : "", caseSensitive: false, wholeWord: false, regex: false };
  });
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(replace);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setShowReplace((value) => value || replace), [replace]);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [replace]);

  useEffect(() => {
    const view = session.view;
    if (!view) return;
    view.dispatch(setFindQuery(view.state.tr, query.text ? query : null));
  }, [session, query]);

  useEffect(
    () => () => {
      const view = session.view;
      if (view) view.dispatch(setFindQuery(view.state.tr, null));
    },
    [session],
  );

  const result = state ? findState(state) : null;
  const count = result?.matches.length ?? 0;
  const step = (direction: 1 | -1) => session.view && findStep(session.view, direction);

  const toggle = (key: "caseSensitive" | "wholeWord" | "regex") => setQuery((value) => ({ ...value, [key]: !value[key] }));

  return (
    <div className="find-bar" role="search">
      <div className="find-row">
        <div className="find-field">
          <input
            ref={input}
            value={query.text}
            placeholder="Find"
            aria-label="Find"
            onChange={(event) => setQuery((value) => ({ ...value, text: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                session.view?.focus();
              }
            }}
          />
          <button type="button" className={`find-toggle${query.caseSensitive ? " is-active" : ""}`} aria-label="Match case" data-tip="Match case" onClick={() => toggle("caseSensitive")}>
            <CaseSensitive size={15} />
          </button>
          <button type="button" className={`find-toggle${query.wholeWord ? " is-active" : ""}`} aria-label="Whole word" data-tip="Whole word" onClick={() => toggle("wholeWord")}>
            <WholeWord size={15} />
          </button>
          <button type="button" className={`find-toggle${query.regex ? " is-active" : ""}`} aria-label="Regular expression" data-tip="Regular expression" onClick={() => toggle("regex")}>
            <Regex size={15} />
          </button>
        </div>
        <span className="find-count">{query.text ? (count ? `${(result?.current ?? 0) + 1} of ${count}` : "No results") : ""}</span>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Previous match" onClick={() => step(-1)} disabled={!count}>
          <ChevronUp size={15} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Next match" onClick={() => step(1)} disabled={!count}>
          <ChevronDown size={15} />
        </button>
        <button type="button" className="link-btn" onClick={() => setShowReplace((value) => !value)}>
          {showReplace ? "Hide replace" : "Replace"}
        </button>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Close find" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {showReplace && (
        <div className="find-row">
          <div className="find-field">
            <input
              value={replacement}
              placeholder="Replace with"
              aria-label="Replace with"
              onChange={(event) => setReplacement(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && session.view) {
                  event.preventDefault();
                  replaceCurrent(session.view, replacement);
                }
              }}
            />
          </div>
          <button type="button" className="btn btn-secondary btn-sm" disabled={!count} onClick={() => session.view && replaceCurrent(session.view, replacement)}>
            <span className="btn-label">Replace</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!count}
            onClick={() => {
              if (!session.view) return;
              const replaced = replaceAll(session.view, replacement);
              toast(`Replaced ${replaced} occurrence${replaced === 1 ? "" : "s"}.`);
            }}
          >
            <span className="btn-label">Replace all</span>
          </button>
        </div>
      )}
    </div>
  );
}
