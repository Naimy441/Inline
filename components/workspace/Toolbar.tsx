"use client";

import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  ChevronDown,
  Highlighter,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  MessageSquarePlus,
  Minus,
  Plus,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Underline,
  Undo2,
} from "lucide-react";
import { redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import type { EditorState } from "prosemirror-state";
import { useRef, useState, type ReactNode } from "react";
import type { DocumentSession, EditorMode } from "@/lib/client/documentSession";
import { EDITOR_MODES, modeMenuItems } from "@/components/workspace/modes";
import { FONT_FAMILIES, type DocumentMeta } from "@/lib/doc/settings";
import { schema, type Align } from "@/lib/doc/schema";
import {
  blockKind,
  clearFormatting,
  currentAlign,
  currentLineHeight,
  indent,
  listKind,
  markActive,
  markAttr,
  outdent,
  setAlign,
  setBlock,
  setLineHeight,
  setMark,
  toggle,
  toggleList,
  type BlockKind,
} from "@/lib/editor/commands";
import { IconButton } from "@/components/ui/Button";
import { MenuButton, type MenuItem } from "@/components/ui/Menu";
import { Popover } from "@/components/ui/Popover";

const mod = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? "⌘" : "Ctrl+";

const BLOCK_LABELS: Record<BlockKind, string> = {
  paragraph: "Normal text",
  title: "Title",
  subtitle: "Subtitle",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  h4: "Heading 4",
  code: "Code",
};

const ZOOMS = [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2];

const TEXT_COLORS = [
  "#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#d9d9d9", "#ffffff",
  "#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#4a86e8", "#0000ff",
  "#9900ff", "#ff00ff", "#c5221f", "#e37400", "#f9ab00", "#188038", "#1967d2", "#9334e6",
];

const HIGHLIGHTS = ["#fff2a8", "#fde68a", "#fbcfe8", "#fecaca", "#bbf7d0", "#bae6fd", "#ddd6fe", "#e5e7eb"];

function fontLabel(value: string | null, fallback: string) {
  const family = value ?? fallback;
  return FONT_FAMILIES.find((font) => font.value === family)?.label ?? family.split(",")[0]!.replace(/"/g, "");
}

export function Toolbar({
  session,
  state,
  meta,
  zoom,
  zoomFit,
  onZoom,
  onLink,
  onComment,
  onImage,
  mode,
}: {
  session: DocumentSession;
  state: EditorState | null;
  meta: DocumentMeta | null;
  zoom: number;
  zoomFit: boolean;
  onZoom: (zoom: number | "fit") => void;
  onLink: () => void;
  onComment: () => void;
  onImage: () => void;
  mode: EditorMode;
}) {
  const run = session.run.bind(session);
  const viewing = mode === "viewing";
  const disabled = !state || viewing;
  const kind = state ? blockKind(state) : null;
  const align = state ? currentAlign(state) : "left";
  const list = state ? listKind(state) : null;
  const defaultSize = meta?.settings.fontSize ?? 11;
  const sizeAttr = state ? markAttr(state, schema.marks.font_size!, "size") : null;
  const size = sizeAttr ? Number.parseFloat(sizeAttr) : defaultSize;
  const family = state ? markAttr(state, schema.marks.font_family!, "family") : null;
  const active = (name: keyof typeof schema.marks) => (state ? markActive(state, schema.marks[name]!) : false);
  const lineHeight = state ? currentLineHeight(state) : null;

  const setSize = (next: number) => {
    const value = Math.max(4, Math.min(144, Math.round(next * 2) / 2));
    run(setMark(schema.marks.font_size!, value === defaultSize ? null : { size: `${value}pt` }));
  };

  const alignIcon = { left: <AlignLeft size={16} />, center: <AlignCenter size={16} />, right: <AlignRight size={16} />, justify: <AlignJustify size={16} /> }[align];

  return (
    <div className={`toolbar${viewing ? " is-viewing" : ""}`} role="toolbar" aria-label="Formatting">
      <Group>
        <IconButton label="Undo" shortcut={`${mod}Z`} disabled={disabled || !undoDepth(state)} onClick={() => run(undo)}>
          <Undo2 size={16} />
        </IconButton>
        <IconButton label="Redo" shortcut={`${mod}⇧Z`} disabled={disabled || !redoDepth(state)} onClick={() => run(redo)}>
          <Redo2 size={16} />
        </IconButton>
      </Group>
      <Group edit={false} className="tb-zoom-group">
        <MenuButton
          className="tb-select tb-zoom"
          label="Zoom"
          items={[
            { label: "Fit", hint: "Shrink pages that don't fit the window", checked: zoomFit, onSelect: () => onZoom("fit") },
            { kind: "separator" },
            ...ZOOMS.map<MenuItem>((value) => ({ label: `${Math.round(value * 100)}%`, checked: !zoomFit && value === zoom, onSelect: () => onZoom(value) })),
          ]}
        >
          {Math.round(zoom * 100)}% <ChevronDown size={13} />
        </MenuButton>
      </Group>
      <Group>
        <MenuButton
          className="tb-select tb-style"
          label="Paragraph style"
          items={(Object.keys(BLOCK_LABELS) as BlockKind[]).map((key) => ({
            label: BLOCK_LABELS[key],
            checked: kind === key,
            shortcut: key === "paragraph" ? `${mod}⌥0` : key.startsWith("h") ? `${mod}⌥${key.slice(1)}` : undefined,
            onSelect: () => run(setBlock(key)),
          }))}
        >
          <span className="tb-select-text">{kind ? BLOCK_LABELS[kind] : "Mixed"}</span> <ChevronDown size={13} />
        </MenuButton>
        <MenuButton
          className="tb-select tb-font"
          label="Font"
          items={FONT_FAMILIES.map((font) => ({
            label: font.label,
            checked: (family ?? meta?.settings.fontFamily) === font.value,
            onSelect: () => run(setMark(schema.marks.font_family!, font.value === meta?.settings.fontFamily ? null : { family: font.value })),
          }))}
        >
          <span className="tb-select-text">{fontLabel(family, meta?.settings.fontFamily ?? "Arial")}</span> <ChevronDown size={13} />
        </MenuButton>
      </Group>
      <Group>
        <IconButton label="Decrease font size" size="sm" disabled={disabled} onClick={() => setSize(size - 1)}>
          <Minus size={14} />
        </IconButton>
        <FontSizeInput value={size} onCommit={setSize} />
        <IconButton label="Increase font size" size="sm" disabled={disabled} onClick={() => setSize(size + 1)}>
          <Plus size={14} />
        </IconButton>
      </Group>
      <Group>
        <IconButton label="Bold" shortcut={`${mod}B`} active={active("bold")} disabled={disabled} onClick={() => run(toggle("bold"))}>
          <Bold size={16} />
        </IconButton>
        <IconButton label="Italic" shortcut={`${mod}I`} active={active("italic")} disabled={disabled} onClick={() => run(toggle("italic"))}>
          <Italic size={16} />
        </IconButton>
        <IconButton label="Underline" shortcut={`${mod}U`} active={active("underline")} disabled={disabled} onClick={() => run(toggle("underline"))}>
          <Underline size={16} />
        </IconButton>
        <IconButton label="Strikethrough" shortcut={`${mod}⇧X`} active={active("strike")} disabled={disabled} onClick={() => run(toggle("strike"))}>
          <Strikethrough size={16} />
        </IconButton>
        <ColorButton
          label="Text color"
          icon={<Baseline size={16} />}
          colors={TEXT_COLORS}
          current={state ? markAttr(state, schema.marks.text_color!, "color") : null}
          onPick={(color) => run(setMark(schema.marks.text_color!, color ? { color } : null))}
        />
        <ColorButton
          label="Highlight"
          icon={<Highlighter size={16} />}
          colors={HIGHLIGHTS}
          current={state ? markAttr(state, schema.marks.highlight!, "color") : null}
          onPick={(color) => run(setMark(schema.marks.highlight!, color ? { color } : null))}
        />
      </Group>
      <Group>
        <IconButton label="Insert link" shortcut={`${mod}K`} disabled={disabled} active={active("link")} onClick={onLink}>
          <Link2 size={16} />
        </IconButton>
        <IconButton label="Add comment" shortcut={`${mod}⌥M`} disabled={!state || state.selection.empty} onClick={onComment}>
          <MessageSquarePlus size={16} />
        </IconButton>
        <IconButton label="Insert image" disabled={disabled} onClick={onImage}>
          <ImagePlus size={16} />
        </IconButton>
      </Group>
      <Group className="tb-align-group">
        <MenuButton
          className="icon-btn icon-btn-md tb-menu-icon"
          label="Align"
          items={(["left", "center", "right", "justify"] as Align[]).map((value) => ({
            label: value[0]!.toUpperCase() + value.slice(1),
            checked: align === value,
            shortcut: `${mod}⇧${{ left: "L", center: "E", right: "R", justify: "J" }[value]}`,
            onSelect: () => run(setAlign(value)),
          }))}
        >
          {alignIcon}
          <ChevronDown size={11} />
        </MenuButton>
        <MenuButton
          className="tb-select tb-spacing"
          label="Line spacing"
          items={[
            { label: "Document default", checked: !lineHeight, onSelect: () => run(setLineHeight(null)) },
            { kind: "separator" },
            ...["1", "1.15", "1.5", "2"].map<MenuItem>((value) => ({
              label: value === "1" ? "Single" : value === "2" ? "Double" : value,
              checked: lineHeight === value,
              onSelect: () => run(setLineHeight(value)),
            })),
          ]}
        >
          <span className="tb-select-text">{lineHeight ?? meta?.settings.lineSpacing ?? 1.15}</span> <ChevronDown size={13} />
        </MenuButton>
      </Group>
      <Group>
        <IconButton label="Checklist" shortcut={`${mod}⇧9`} active={list === "task"} disabled={disabled} onClick={() => run(toggleList("task"))}>
          <ListChecks size={16} />
        </IconButton>
        <IconButton label="Bulleted list" shortcut={`${mod}⇧8`} active={list === "bullet"} disabled={disabled} onClick={() => run(toggleList("bullet"))}>
          <List size={16} />
        </IconButton>
        <IconButton label="Numbered list" shortcut={`${mod}⇧7`} active={list === "ordered"} disabled={disabled} onClick={() => run(toggleList("ordered"))}>
          <ListOrdered size={16} />
        </IconButton>
        <IconButton label="Decrease indent" className="tb-indent" shortcut={`${mod}[`} disabled={disabled} onClick={() => run(outdent)}>
          <IndentDecrease size={16} />
        </IconButton>
        <IconButton label="Increase indent" className="tb-indent" shortcut={`${mod}]`} disabled={disabled} onClick={() => run(indent)}>
          <IndentIncrease size={16} />
        </IconButton>
      </Group>
      <Group className="tb-clear-group">
        <IconButton label="Clear formatting" shortcut={`${mod}\\`} disabled={disabled} onClick={() => run(clearFormatting)}>
          <RemoveFormatting size={16} />
        </IconButton>
      </Group>
      <div className="tb-spacer" />
      <MenuButton className={`tb-select tb-mode is-${mode}`} label="Mode" placement="bottom-end" items={() => modeMenuItems(mode, (next) => void session.setMode(next))}>
        {EDITOR_MODES[mode].icon(15)}
        <span className="tb-select-text">{EDITOR_MODES[mode].label}</span> <ChevronDown size={13} />
      </MenuButton>
    </div>
  );
}

/** A group of controls; editing groups are disabled in viewing mode. */
function Group({ children, edit = true, className }: { children: ReactNode; edit?: boolean; className?: string }) {
  return <div className={`tb-group${edit ? " tb-edit" : ""}${className ? ` ${className}` : ""}`}>{children}</div>;
}

function FontSizeInput({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="tb-size"
      aria-label="Font size"
      value={draft ?? String(value)}
      onFocus={(event) => {
        setDraft(String(value));
        event.target.select();
      }}
      onChange={(event) => setDraft(event.target.value.replace(/[^\d.]/g, ""))}
      onBlur={() => {
        if (draft && Number(draft) > 0 && Number(draft) !== value) onCommit(Number(draft));
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") {
          setDraft(null);
          (event.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function ColorButton({
  label,
  icon,
  colors,
  current,
  onPick,
}: {
  label: string;
  icon: ReactNode;
  colors: string[];
  current: string | null;
  onPick: (color: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`icon-btn icon-btn-md color-btn${open ? " is-open" : ""}`}
        aria-label={label}
        data-tip={label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
      >
        {icon}
        <span className="color-swatch-bar" style={{ background: current ?? "transparent" }} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} className="color-popover">
        <div className="color-grid">
          {colors.map((color) => (
            <button
              key={color}
              type="button"
              className={`color-swatch${current === color ? " is-active" : ""}`}
              style={{ background: color }}
              aria-label={color}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onPick(color);
                setOpen(false);
              }}
            />
          ))}
        </div>
        <div className="color-actions">
          <button
            type="button"
            className="link-btn"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onPick(null);
              setOpen(false);
            }}
          >
            Reset
          </button>
          <label className="color-custom">
            Custom
            <input type="color" onChange={(event) => onPick(event.target.value)} />
          </label>
        </div>
      </Popover>
    </>
  );
}
