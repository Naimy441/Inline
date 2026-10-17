import { Eye, Pencil, PencilLine } from "lucide-react";
import type { ReactNode } from "react";
import type { EditorMode } from "@/lib/client/documentSession";
import type { MenuItem } from "@/components/ui/Menu";

export const EDITOR_MODES: Record<EditorMode, { label: string; icon: (size: number) => ReactNode; key: string }> = {
  editing: { label: "Editing", icon: (size) => <Pencil size={size} />, key: "Z" },
  suggesting: { label: "Suggesting", icon: (size) => <PencilLine size={size} />, key: "X" },
  viewing: { label: "Viewing", icon: (size) => <Eye size={size} />, key: "C" },
};

export function modeMenuItems(current: EditorMode, onSelect: (mode: EditorMode) => void): MenuItem[] {
  return (Object.keys(EDITOR_MODES) as EditorMode[]).map((mode) => ({
    label: EDITOR_MODES[mode].label,
    icon: EDITOR_MODES[mode].icon(14),
    checked: current === mode ? true : undefined,
    shortcut: `⌘⌥⇧${EDITOR_MODES[mode].key}`,
    onSelect: () => onSelect(mode),
  }));
}
