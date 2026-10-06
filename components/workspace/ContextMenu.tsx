"use client";

import { BookPlus, ClipboardPaste, Copy, Link2, Lock, LockOpen, MessageSquarePlus, RemoveFormatting, Scissors, Sparkles, Trash2 } from "lucide-react";
import { deleteSelection } from "prosemirror-commands";
import { TextSelection } from "prosemirror-state";
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, isInTable } from "prosemirror-tables";
import { useEffect, useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { clearFormatting } from "@/lib/editor/commands";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { toast } from "@/components/ui/Toast";
import { isTouch } from "@/lib/client/viewport";
import { selectedWord } from "@/lib/editor/spelling";
import { preferences } from "@/lib/client/preferences";

/**
 * The editor's right-click menu. Shift+right-click still opens the browser's own
 * menu (spelling suggestions live there).
 */
export function ContextMenu({
  session,
  onAsk,
  onComment,
  onLink,
  hideClaude = false,
  readOnly = false,
}: {
  session: DocumentSession;
  hideClaude?: boolean;
  /** Viewing mode: only copying, commenting and asking are offered. */
  readOnly?: boolean;
  onAsk: () => void;
  onComment: () => void;
  onLink: () => void;
}) {
  const [point, setPoint] = useState<DOMRect | null>(null);

  useEffect(() => {
    const view = session.view;
    const dom = view?.dom;
    if (!view || !dom) return;
    const onContextMenu = (event: MouseEvent) => {
      // Touch long-presses keep the system's own selection handles and menu.
      if (event.shiftKey || (event as PointerEvent).pointerType === "touch" || isTouch()) return;
      event.preventDefault();
      // Right-clicking outside the selection moves the cursor there first.
      const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
      const { from, to } = view.state.selection;
      if (hit && (hit.pos < from || hit.pos > to)) {
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(hit.pos))));
      }
      view.focus();
      setPoint(new DOMRect(event.clientX, event.clientY, 0, 0));
    };
    dom.addEventListener("contextmenu", onContextMenu);
    return () => dom.removeEventListener("contextmenu", onContextMenu);
    // The editor view is created once the document loads.
  }, [session, session.view]);

  const state = session.view?.state;
  const hasSelection = Boolean(state && !state.selection.empty);
  const inTable = state ? isInTable(state) : false;
  const run = session.run.bind(session);
  const locked = hasSelection && session.selectionLocked();
  const lockSelection = (lock: boolean) =>
    void session
      .setSelectionLocked(lock)
      .then(() => toast(lock ? "Locked. Claude can't change this text." : "Unlocked. Claude can edit this text again."))
      .catch((error: Error) => toast(error.message, { tone: "error" }));
  const word = session.view ? selectedWord(session.view) : null;
  const spellcheck = preferences.get().spellcheck;
  const paste = (plain: boolean) => void session.paste(plain).catch((error: Error) => toast(error.message, { tone: "error" }));

  const items: MenuItem[] = [
    { label: "Cut", icon: <Scissors size={14} />, shortcut: `⌘X`, disabled: !hasSelection || readOnly, onSelect: () => session.clipboard("cut") },
    { label: "Copy", icon: <Copy size={14} />, shortcut: `⌘C`, disabled: !hasSelection, onSelect: () => session.clipboard("copy") },
    { label: "Paste", icon: <ClipboardPaste size={14} />, shortcut: `⌘V`, disabled: readOnly, onSelect: () => paste(false) },
    { label: "Paste without formatting", shortcut: `⌘⇧V`, disabled: readOnly, onSelect: () => paste(true) },
    { label: "Delete", icon: <Trash2 size={14} />, disabled: !hasSelection || readOnly, onSelect: () => run(deleteSelection) },
    { kind: "separator" },
    ...(hideClaude ? [] : [{ label: hasSelection ? "Ask Claude about this" : "Ask Claude", icon: <Sparkles size={14} />, shortcut: `⌘L`, onSelect: onAsk }]),
    { label: "Comment", icon: <MessageSquarePlus size={14} />, shortcut: `⌘⌥M`, disabled: !hasSelection, onSelect: onComment },
    { label: "Link", icon: <Link2 size={14} />, shortcut: `⌘K`, disabled: readOnly, onSelect: onLink },
    ...(hideClaude
      ? []
      : [
          locked
            ? { label: "Unlock for Claude", icon: <LockOpen size={14} />, disabled: readOnly, onSelect: () => lockSelection(false) }
            : { label: "Lock from Claude's edits", icon: <Lock size={14} />, disabled: !hasSelection || readOnly, onSelect: () => lockSelection(true) },
        ]),
    ...(inTable && !readOnly
      ? ([
          { kind: "separator" },
          {
            label: "Table",
            submenu: [
              { label: "Insert row above", onSelect: () => run(addRowBefore) },
              { label: "Insert row below", onSelect: () => run(addRowAfter) },
              { label: "Insert column left", onSelect: () => run(addColumnBefore) },
              { label: "Insert column right", onSelect: () => run(addColumnAfter) },
              { kind: "separator" },
              { label: "Delete row", onSelect: () => run(deleteRow) },
              { label: "Delete column", onSelect: () => run(deleteColumn) },
              { label: "Delete table", danger: true, onSelect: () => run(deleteTable) },
            ],
          },
        ] as MenuItem[])
      : []),
    { kind: "separator" },
    { label: "Clear formatting", icon: <RemoveFormatting size={14} />, shortcut: `⌘\\`, disabled: !hasSelection || readOnly, onSelect: () => run(clearFormatting) },
    { kind: "separator" },
    ...(word && spellcheck
      ? [
          {
            label: `Add “${word.text.length > 24 ? `${word.text.slice(0, 23)}…` : word.text}” to dictionary`,
            hint: "Stop underlining this word",
            icon: <BookPlus size={14} />,
            onSelect: () => {
              session.addToDictionary(word.text);
              toast(`“${word.text}” won't be underlined again.`);
            },
          },
        ]
      : []),
    { label: spellcheck ? "Hide spelling underlines" : "Show spelling underlines", onSelect: () => session.setSpellcheck(!spellcheck) },
    { kind: "label", label: "Shift+right-click for spelling suggestions" },
  ];

  return <Menu open={point !== null} onClose={() => setPoint(null)} anchor={point} items={items} />;
}
