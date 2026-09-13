"use client";

import { useEffect, useState } from "react";

export type ViewMode = "editing" | "suggesting" | "viewing";

type Props = {
  mode: ViewMode;
  readOnly: boolean;
  commentsOpen: boolean;
  commentsMinimized: boolean;
  showInvisibles: boolean;
  isFullscreen: boolean;
  showHeader: boolean;
  showFooter: boolean;
  showPageNumbers: boolean;
  substitutions: boolean;
  screenReader: boolean;
  darkMode: boolean;
  columns: number;
  lineSpacing: string;
  onAction: (action: string, value?: string) => void;
};

export function MenuBar(props: Props) {
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const close = () => setOpen(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, []);

  const menu = (id: string, label: string, items: MenuItem[]) => (
    <div className="menu" onMouseDown={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="menu-item"
        data-open={open === id}
        onClick={() => setOpen((current) => (current === id ? null : id))}
      >
        {label}
      </button>
      {open === id && (
        <div className="menu-dropdown">
          {items.map((item, index) =>
            item === "sep" ? (
              <div key={`sep-${index}`} className="menu-sep" />
            ) : (
              <MenuRow
                key={item.label}
                item={item}
                disabled={Boolean(props.readOnly && item.writes)}
                onPick={() => {
                  setOpen(null);
                  props.onAction(item.action, item.value);
                }}
              />
            ),
          )}
        </div>
      )}
    </div>
  );

  return (
    <nav className="menubar" aria-label="Document menus">
      {menu("file", "File", [
        { label: "Print", action: "print", shortcut: "⌘P" },
      ])}
      {menu("edit", "Edit", [
        { label: "Undo", action: "undo", shortcut: "⌘Z", writes: true },
        { label: "Redo", action: "redo", shortcut: "⌘⇧Z", writes: true },
        "sep",
        { label: "Cut", action: "cut", shortcut: "⌘X", writes: true },
        { label: "Copy", action: "copy", shortcut: "⌘C" },
        { label: "Paste", action: "paste", shortcut: "⌘V", writes: true },
        { label: "Paste without formatting", action: "paste-plain", shortcut: "⌘⇧V", writes: true },
        "sep",
        { label: "Select all", action: "select-all", shortcut: "⌘A" },
        { label: "Delete", action: "delete", writes: true },
        { label: "Find and replace", action: "search", shortcut: "⌘F" },
      ])}
      {menu("view", "View", [
        { label: "Editing", action: "mode", value: "editing", checked: props.mode === "editing" },
        { label: "Suggesting", action: "mode", value: "suggesting", checked: props.mode === "suggesting" },
        { label: "Viewing", action: "mode", value: "viewing", checked: props.mode === "viewing" },
        "sep",
        { label: props.commentsOpen && !props.commentsMinimized ? "Minimize comments" : "Expand comments", action: "comments-toggle" },
        { label: "Show non-printing characters", action: "invisibles", checked: props.showInvisibles },
        { label: "Dark mode", action: "theme", checked: props.darkMode },
        { label: props.isFullscreen ? "Exit full screen" : "Full screen", action: "fullscreen", shortcut: "F11" },
      ])}
      {menu("insert", "Insert", [
        { label: "Image", action: "image", writes: true },
        { label: "Table", action: "table", writes: true },
        { label: "Link", action: "link", shortcut: "⌘K", writes: true },
        { label: "Emoji", action: "emoji", writes: true },
        { label: "Special characters", action: "special", writes: true },
        { label: "Comment", action: "comment", shortcut: "⌘⌥M", writes: true },
        "sep",
        { label: "Tab", action: "tab", writes: true },
        { label: "Horizontal line", action: "hr", writes: true },
        { label: "Page break", action: "page-break", writes: true },
      ])}
      {menu("format", "Format", [
        { label: "Bold", action: "bold", shortcut: "⌘B", writes: true },
        { label: "Italic", action: "italic", shortcut: "⌘I", writes: true },
        { label: "Underline", action: "underline", shortcut: "⌘U", writes: true },
        { label: "Strikethrough", action: "strikeThrough", writes: true },
        { label: "Superscript", action: "superscript", writes: true },
        { label: "Subscript", action: "subscript", writes: true },
        "sep",
        { label: "Uppercase", action: "caps", value: "upper", writes: true },
        { label: "Lowercase", action: "caps", value: "lower", writes: true },
        { label: "Title case", action: "caps", value: "title", writes: true },
        "sep",
        { label: "Normal text", action: "style", value: "normal", writes: true },
        { label: "Title", action: "style", value: "title", writes: true },
        { label: "Subtitle", action: "style", value: "subtitle", writes: true },
        { label: "Heading 1", action: "style", value: "h1", writes: true },
        { label: "Heading 2", action: "style", value: "h2", writes: true },
        { label: "Heading 3", action: "style", value: "h3", writes: true },
        "sep",
        { label: "Align left", action: "align", value: "left", writes: true },
        { label: "Align center", action: "align", value: "center", writes: true },
        { label: "Align right", action: "align", value: "right", writes: true },
        { label: "Justify", action: "align", value: "justify", writes: true },
        { label: "Increase indent", action: "indent", writes: true },
        { label: "Decrease indent", action: "outdent", writes: true },
        "sep",
        { label: "Line spacing 1", action: "spacing", value: "1", checked: props.lineSpacing === "1" },
        { label: "Line spacing 1.15", action: "spacing", value: "1.15", checked: props.lineSpacing === "1.15" },
        { label: "Line spacing 1.5", action: "spacing", value: "1.5", checked: props.lineSpacing === "1.5" },
        { label: "Line spacing 2", action: "spacing", value: "2", checked: props.lineSpacing === "2" },
        "sep",
        { label: "1 column", action: "columns", value: "1", checked: props.columns === 1 },
        { label: "2 columns", action: "columns", value: "2", checked: props.columns === 2 },
        { label: "3 columns", action: "columns", value: "3", checked: props.columns === 3 },
        "sep",
        { label: "Header", action: "header", checked: props.showHeader },
        { label: "Footer", action: "footer", checked: props.showFooter },
        { label: "Page numbers", action: "page-numbers", checked: props.showPageNumbers },
        { label: "Clear formatting", action: "clear-format", writes: true },
      ])}
      {menu("tools", "Tools", [
        { label: "Word count", action: "word-count" },
        { label: "Compare documents", action: "compare" },
        { label: "Citations", action: "citation", writes: true },
        { label: "eSignature", action: "signature", writes: true },
        { label: "Substitutions", action: "substitutions", checked: props.substitutions },
        { label: "Screen reader", action: "screen-reader", checked: props.screenReader },
      ])}
      {menu("help", "Help", [
        { label: "Keyboard shortcuts", action: "shortcuts" },
      ])}
    </nav>
  );
}

type MenuItem =
  | "sep"
  | {
      label: string;
      action: string;
      value?: string;
      shortcut?: string;
      checked?: boolean;
      writes?: boolean;
    };

function MenuRow({
  item,
  disabled,
  onPick,
}: {
  item: Exclude<MenuItem, "sep">;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <button type="button" className="menu-row" disabled={disabled} onClick={onPick}>
      <span className="menu-check">{item.checked ? "✓" : ""}</span>
      <span className="menu-label">{item.label}</span>
      {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
    </button>
  );
}
