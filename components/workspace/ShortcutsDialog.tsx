"use client";

import { Dialog } from "@/components/ui/Dialog";

const mac = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);
const mod = mac ? "⌘" : "Ctrl";
const alt = mac ? "⌥" : "Alt";

const GROUPS: Array<[string, Array<[string, string]>]> = [
  [
    "Claude",
    [
      ["Ask Claude about the selection", `${mod} L`],
      ["Show or hide Claude", `${mod} J`],
      ["Keep the change at the cursor", `${mod} ⇧ ⏎`],
      ["Undo the change at the cursor", `${mod} ⇧ ⌫`],
      ["Next / previous change", `${alt} ] / ${alt} [`],
      ["Stop Claude (in the chat box)", "Esc"],
    ],
  ],
  [
    "Text",
    [
      ["Bold / italic / underline", `${mod} B / I / U`],
      ["Strikethrough", `${mod} ⇧ X`],
      ["Inline code", `${mod} E`],
      ["Superscript / subscript", `${mod} . / ,`],
      ["Link", `${mod} K`],
      ["Open link", `${mod} click`],
      ["Paste without formatting", `${mod} ⇧ V`],
      ["Clear formatting", `${mod} \\`],
    ],
  ],
  [
    "Paragraphs",
    [
      ["Normal text", `${mod} ${alt} 0`],
      ["Heading 1–4", `${mod} ${alt} 1–4`],
      ["Align left / center / right / justify", `${mod} ⇧ L / E / R / J`],
      ["Numbered / bulleted / checklist", `${mod} ⇧ 7 / 8 / 9`],
      ["Indent / outdent", `Tab / ⇧ Tab`],
      ["Line break / page break", `⇧ ⏎ / ${mod} ⏎`],
    ],
  ],
  [
    "Document",
    [
      ["Find / replace", `${mod} F / ${mod} H`],
      ["Comment", `${mod} ${alt} M`],
      ["Undo / redo", `${mod} Z / ${mod} ⇧ Z`],
      ["Editing / suggesting / viewing", `${mod} ${alt} ⇧ Z / X / C`],
      ["Show non-printing characters", `${mod} ⇧ P`],
      ["Print", `${mod} P`],
      ["Shortcuts", `${mod} /`],
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
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" width={720}>
      <div className="shortcut-grid">
        {GROUPS.map(([title, rows]) => (
          <section key={title}>
            <h3>{title}</h3>
            {rows.map(([label, keys]) => (
              <div key={label} className="shortcut-row">
                <span>{label}</span>
                <kbd>{keys}</kbd>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
