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

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" width={720}>
      <div className="shortcut-grid">
        {GROUPS.map(([title, rows]) => (
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
