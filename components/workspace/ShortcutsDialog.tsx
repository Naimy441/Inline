"use client";

import { Shortcut } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";

/** Written in Mac notation; Shortcut shows Ctrl, Alt and Shift elsewhere. */
const GROUPS: Array<[string, Array<[string, string]>]> = [
  [
    "Claude",
    [
      ["Ask Claude about the selection", "⌘ L"],
      ["Edit with Claude inline", "⌘ K"],
      ["Check spelling & grammar here", "⌘ ⌥ X"],
      ["Show or hide Claude", "⌘ J"],
      ["Keep the change at the cursor", "⌘ ⇧ ⏎"],
      ["Undo the change at the cursor", "⌘ ⇧ ⌫"],
      ["Next / previous change", "⌥ ] / ⌥ ["],
      ["Stop Claude (in the chat box)", "Esc"],
    ],
  ],
  [
    "Text",
    [
      ["Bold / italic / underline", "⌘ B / I / U"],
      ["Strikethrough", "⌘ ⇧ X"],
      ["Inline code", "⌘ E"],
      ["Superscript / subscript", "⌘ . / ,"],
      ["Link", "⌘ K"],
      ["Open link", "⌘ click"],
      ["Paste without formatting", "⌘ ⇧ V"],
      ["Clear formatting", `⌘ \\`],
    ],
  ],
  [
    "Paragraphs",
    [
      ["Normal text", "⌘ ⌥ 0"],
      ["Heading 1–4", "⌘ ⌥ 1–4"],
      ["Align left / center / right / justify", "⌘ ⇧ L / E / R / J"],
      ["Numbered / bulleted / checklist", "⌘ ⇧ 7 / 8 / 9"],
      ["Indent / outdent", "Tab / ⇧ Tab"],
      ["Line break / page break", "⇧ ⏎ / ⌘ ⏎"],
    ],
  ],
  [
    "Document",
    [
      ["Find / replace", "⌘ F / ⌘ H"],
      ["Comment", "⌘ ⌥ M"],
      ["Undo / redo", "⌘ Z / ⌘ ⇧ Z"],
      ["Editing / suggesting / viewing", "⌘ ⌥ ⇧ Z / X / C"],
      ["Show non-printing characters", "⌘ ⇧ P"],
      ["Print", "⌘ P"],
      ["Shortcuts", "⌘ /"],
    ],
  ],
  [
    "Markdown shortcuts",
    [
      ["Heading", "# + space"],
      ["Bulleted / numbered list", "- or 1. + space"],
      ["Checklist", "[ ] + space"],
      ["Quote / code block", "> + space / ```"],
      ["Divider", "---"],
      ["Bold / italic / highlight", "**text** / *text* / ==text=="],
    ],
  ],
];

const AI_SHORTCUTS = new Set(["Ask Claude about the selection", "Edit with Claude inline", "Check spelling & grammar here", "Show or hide Claude", "Stop Claude (in the chat box)"]);

export function ShortcutsDialog({ open, onClose, hideAi = false }: { open: boolean; onClose: () => void; /** Focus mode: drop shortcuts that open Claude. Review shortcuts stay. */ hideAi?: boolean }) {
  if (!open) return null;
  const groups = GROUPS.map(([title, rows]) => (title === "Claude" && hideAi ? (["Review", rows.filter(([label]) => !AI_SHORTCUTS.has(label))] as const) : ([title, rows] as const))).filter(([, rows]) => rows.length > 0);
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" width={720}>
      <div className="shortcut-grid">
        {groups.map(([title, rows]) => (
          <section key={title}>
            <h3>{title}</h3>
            {rows.map(([label, keys]) => (
              <div key={label} className="shortcut-row">
                <span>{label}</span>
                <kbd>
                  <Shortcut keys={keys} />
                </kbd>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
