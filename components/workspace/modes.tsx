import { Eye, Pencil, PencilLine } from "lucide-react";
import type { ReactNode } from "react";
import type { EditorMode } from "@/lib/client/documentSession";
import type { MenuItem } from "@/components/ui/Menu";

const mod = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? "⌘⌥⇧" : "Ctrl+Alt+Shift+";

export const EDITOR_MODES: Record<EditorMode, { label: string; hint: string; icon: (size: number) => ReactNode; key: string }> = {
  editing: { label: "Editing", hint: "Edit the document directly", icon: (size) => <Pencil size={size} />, key: "Z" },
  suggesting: { label: "Suggesting", hint: "Edits become suggestions to keep or undo", icon: (size) => <PencilLine size={size} />, key: "X" },
  viewing: { label: "Viewing", hint: "Read or print the final document", icon: (size) => <Eye size={size} />, key: "C" },
};

export function modeMenuItems(current: EditorMode, onSelect: (mode: EditorMode) => void): MenuItem[] {
  return (Object.keys(EDITOR_MODES) as EditorMode[]).map((mode) => ({
    label: EDITOR_MODES[mode].label,
    hint: EDITOR_MODES[mode].hint,
    icon: EDITOR_MODES[mode].icon(14),
    checked: current === mode ? true : undefined,
    shortcut: `${mod}${EDITOR_MODES[mode].key}`,
    onSelect: () => onSelect(mode),
  }));
}
