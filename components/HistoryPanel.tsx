"use client";

import type { HistorySnapshot } from "@/lib/historyStore";

type Props = {
  snapshots: HistorySnapshot[];
  onRestore: (id: string) => void;
  onSave: () => void;
  onClose: () => void;
};

export function HistoryPanel({ snapshots, onRestore, onSave, onClose }: Props) {
  return (
    <aside className="history-panel">
      <div className="comments-head">
        <strong>Version history</strong>
        <button type="button" className="dialog-text-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <button type="button" className="history-save" onClick={onSave}>
        Save current version
      </button>
      {snapshots.length === 0 ? (
        <p className="comments-empty">Versions appear before AI edits and when you save.</p>
      ) : (
        <ul className="history-list">
          {snapshots.map((snap) => (
            <li key={snap.id}>
              <button type="button" onClick={() => onRestore(snap.id)}>
                <strong>{snap.label}</strong>
                <span>
                  {snap.title} · {new Date(snap.at).toLocaleString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
