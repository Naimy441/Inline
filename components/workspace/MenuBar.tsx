"use client";

import { redo, undo } from "prosemirror-history";
import { AllSelection } from "prosemirror-state";
import { createRef, useRef, useState, type RefObject } from "react";
import type { DocumentSession, EditorMode } from "@/lib/client/documentSession";
import { modeMenuItems } from "@/components/workspace/modes";
import {
  changeCase,
  clearFormatting,
  insertHorizontalRule,
  insertTableOfContents,
  insertPageBreak,
  insertTable,
  setAlign,
  setBlock,
  toggle,
  toggleBlockquote,
  toggleList,
} from "@/lib/editor/commands";
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, isInTable, toggleHeaderRow } from "prosemirror-tables";
import { Menu, type MenuItem } from "@/components/ui/Menu";

const mod = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? "⌘" : "Ctrl+";

export type MenuActions = {
  newDocument: () => void;
  goHome: () => void;
  duplicate: () => void;
  download: (format: "docx" | "pdf" | "md" | "html" | "txt") => void;
  print: () => void;
  pageSetup: (tab?: "page" | "text" | "header") => void;
  history: () => void;
  trash: () => void;
  find: (replace: boolean) => void;
  link: () => void;
  comment: () => void;
  image: () => void;
  zoom: (value: number) => void;
  toggleTheme: () => void;
  dark: boolean;
  toggleOutline: () => void;
  toggleAgent: () => void;
  shortcuts: () => void;
  connectClaudeCode: () => void;
  wordCount: () => void;
  ask: (prompt: string) => void;
  /** Spelling and grammar for the selection or the current paragraph. */
  checkSpelling: () => void;
  specialCharacters: () => void;
  paste: (plain: boolean) => void;
  clipboard: (action: "cut" | "copy") => void;
  fitWidth: () => void;
  fullScreen: () => void;
  focusMode: boolean;
  toggleFocusMode: () => void;
  notice: (message: string) => void;
  mode: EditorMode;
  setMode: (mode: EditorMode) => void;
  showInvisibles: boolean;
  toggleInvisibles: () => void;
  substitutions: boolean;
  toggleSubstitutions: () => void;
};

export function MenuBar({ session, actions, zoom, hunks }: { session: DocumentSession; actions: MenuActions; zoom: number; hunks: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const anchors = useRef<Record<string, RefObject<HTMLButtonElement | null>>>({});
  const anchor = (name: string) => (anchors.current[name] ??= createRef<HTMLButtonElement>());
  const run = session.run.bind(session);
  const inTable = session.view ? isInTable(session.view.state) : false;

  const menus: Record<string, MenuItem[]> = {
    File: [
      { label: "New document", onSelect: actions.newDocument },
      { label: "All documents", onSelect: actions.goHome },
      { label: "Make a copy", onSelect: actions.duplicate },
      { kind: "separator" },
      {
        label: "Download",
        submenu: [
          { label: "Word (.docx)", onSelect: () => actions.download("docx") },
          { label: "PDF (.pdf)", onSelect: () => actions.download("pdf") },
          { label: "Markdown (.md)", onSelect: () => actions.download("md") },
          { label: "Web page (.html)", onSelect: () => actions.download("html") },
          { label: "Plain text (.txt)", onSelect: () => actions.download("txt") },
        ],
      },
      { label: "Print", shortcut: `${mod}P`, onSelect: actions.print },
      { kind: "separator" },
      { label: "Version history", onSelect: actions.history },
      { label: "Page setup", onSelect: () => actions.pageSetup("page") },
      { kind: "separator" },
      { label: "Move to trash", danger: true, onSelect: actions.trash },
    ],
    Edit: [
      { label: "Undo", shortcut: `${mod}Z`, onSelect: () => run(undo) },
      { label: "Redo", shortcut: `${mod}⇧Z`, onSelect: () => run(redo) },
      { kind: "separator" },
      { label: "Cut", shortcut: `${mod}X`, onSelect: () => actions.clipboard("cut") },
      { label: "Copy", shortcut: `${mod}C`, onSelect: () => actions.clipboard("copy") },
      { label: "Paste", shortcut: `${mod}V`, onSelect: () => actions.paste(false) },
      { label: "Paste without formatting", shortcut: `${mod}⇧V`, onSelect: () => actions.paste(true) },
      {
        label: "Select all",
        shortcut: `${mod}A`,
        onSelect: () => {
          const view = session.view;
          if (!view) return;
          session.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
          view.focus();
        },
      },
      { kind: "separator" },
      { label: "Find", shortcut: `${mod}F`, onSelect: () => actions.find(false) },
      { label: "Find and replace", shortcut: `${mod}H`, onSelect: () => actions.find(true) },
      { kind: "separator" },
      { label: "Keep all pending changes", hint: "Claude's edits and suggestions", disabled: !hunks, onSelect: () => void session.review("accept", "all") },
      { label: "Undo all pending changes", disabled: !hunks, onSelect: () => void session.review("reject", "all") },
      { label: "Next change", shortcut: "⌥]", disabled: !hunks, onSelect: () => session.gotoChange(1) },
    ],
    View: [
      { label: "Mode", submenu: modeMenuItems(actions.mode, actions.setMode) },
      { kind: "separator" },
      { label: "Zoom in", onSelect: () => actions.zoom(Math.min(2, Math.round((zoom + 0.1) * 10) / 10)) },
      { label: "Zoom out", onSelect: () => actions.zoom(Math.max(0.5, Math.round((zoom - 0.1) * 10) / 10)) },
      { label: "Actual size", checked: zoom === 1, onSelect: () => actions.zoom(1) },
      { label: "Fit to width", onSelect: actions.fitWidth },
      { kind: "separator" },
      { label: "Outline", onSelect: actions.toggleOutline },
      ...(actions.focusMode ? [] : [{ label: "Claude panel", shortcut: `${mod}J`, onSelect: actions.toggleAgent }]),
      { label: "Focus mode", hint: "Hide Claude while you write", checked: actions.focusMode, onSelect: actions.toggleFocusMode },
      { label: "Show non-printing characters", shortcut: `${mod}⇧P`, checked: actions.showInvisibles, onSelect: actions.toggleInvisibles },
      { label: "Dark theme", checked: actions.dark, onSelect: actions.toggleTheme },
      { label: "Full screen", onSelect: actions.fullScreen },
    ],
    Insert: [
      { label: "Image…", onSelect: actions.image },
      {
        label: "Table",
        submenu: [2, 3, 4, 5].map((size) => ({ label: `${size} × ${size}`, onSelect: () => run(insertTable(size, size)) })),
      },
      { label: "Link", shortcut: `${mod}K`, onSelect: actions.link },
      { label: "Comment", shortcut: `${mod}⌥M`, onSelect: actions.comment },
      { kind: "separator" },
      { label: "Special characters…", onSelect: actions.specialCharacters },
      { label: "Table of contents", onSelect: () => !run(insertTableOfContents) && actions.notice("Add some headings first; the table of contents lists them.") },
      { kind: "separator" },
      { label: "Horizontal line", onSelect: () => run(insertHorizontalRule) },
      { label: "Page break", shortcut: `${mod}⏎`, onSelect: () => run(insertPageBreak) },
      {
        label: "Date",
        onSelect: () => {
          const view = session.view;
          if (!view) return;
          const text = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
          session.dispatch(view.state.tr.insertText(text));
          view.focus();
        },
      },
    ],
    Format: [
      {
        label: "Text",
        submenu: [
          { label: "Bold", shortcut: `${mod}B`, onSelect: () => run(toggle("bold")) },
          { label: "Italic", shortcut: `${mod}I`, onSelect: () => run(toggle("italic")) },
          { label: "Underline", shortcut: `${mod}U`, onSelect: () => run(toggle("underline")) },
          { label: "Strikethrough", shortcut: `${mod}⇧X`, onSelect: () => run(toggle("strike")) },
          { label: "Superscript", shortcut: `${mod}.`, onSelect: () => run(toggle("superscript")) },
          { label: "Subscript", shortcut: `${mod},`, onSelect: () => run(toggle("subscript")) },
          { label: "Code", shortcut: `${mod}E`, onSelect: () => run(toggle("code")) },
          { kind: "separator" },
          {
            label: "Capitalization",
            submenu: [
              { label: "lowercase", onSelect: () => run(changeCase("lower")) },
              { label: "UPPERCASE", onSelect: () => run(changeCase("upper")) },
              { label: "Title Case", onSelect: () => run(changeCase("title")) },
              { label: "Sentence case", onSelect: () => run(changeCase("sentence")) },
            ],
          },
        ],
      },
      {
        label: "Paragraph styles",
        submenu: [
          { label: "Normal text", onSelect: () => run(setBlock("paragraph")) },
          { label: "Title", onSelect: () => run(setBlock("title")) },
          { label: "Subtitle", onSelect: () => run(setBlock("subtitle")) },
          { label: "Heading 1", onSelect: () => run(setBlock("h1")) },
          { label: "Heading 2", onSelect: () => run(setBlock("h2")) },
          { label: "Heading 3", onSelect: () => run(setBlock("h3")) },
          { label: "Quote", onSelect: () => run(toggleBlockquote) },
          { label: "Code block", onSelect: () => run(setBlock("code")) },
        ],
      },
      {
        label: "Align",
        submenu: [
          { label: "Left", shortcut: `${mod}⇧L`, onSelect: () => run(setAlign("left")) },
          { label: "Center", shortcut: `${mod}⇧E`, onSelect: () => run(setAlign("center")) },
          { label: "Right", shortcut: `${mod}⇧R`, onSelect: () => run(setAlign("right")) },
          { label: "Justified", shortcut: `${mod}⇧J`, onSelect: () => run(setAlign("justify")) },
        ],
      },
      {
        label: "Lists",
        submenu: [
          { label: "Bulleted list", shortcut: `${mod}⇧8`, onSelect: () => run(toggleList("bullet")) },
          { label: "Numbered list", shortcut: `${mod}⇧7`, onSelect: () => run(toggleList("ordered")) },
          { label: "Checklist", shortcut: `${mod}⇧9`, onSelect: () => run(toggleList("task")) },
        ],
      },
      {
        label: "Table",
        disabled: !inTable,
        submenu: [
          { label: "Insert row above", onSelect: () => run(addRowBefore) },
          { label: "Insert row below", onSelect: () => run(addRowAfter) },
          { label: "Insert column left", onSelect: () => run(addColumnBefore) },
          { label: "Insert column right", onSelect: () => run(addColumnAfter) },
          { kind: "separator" },
          { label: "Toggle header row", onSelect: () => run(toggleHeaderRow) },
          { kind: "separator" },
          { label: "Delete row", onSelect: () => run(deleteRow) },
          { label: "Delete column", onSelect: () => run(deleteColumn) },
          { label: "Delete table", danger: true, onSelect: () => run(deleteTable) },
        ],
      },
      { kind: "separator" },
      { label: "Header & footer…", onSelect: () => actions.pageSetup("header") },
      { label: "Page numbers…", onSelect: () => actions.pageSetup("header") },
      { label: "Document text defaults…", onSelect: () => actions.pageSetup("text") },
      { kind: "separator" },
      { label: "Clear formatting", shortcut: `${mod}\\`, onSelect: () => run(clearFormatting) },
    ],
    Tools: [
      { label: "Word count", onSelect: actions.wordCount },
      { label: "Automatic substitutions", hint: "Smart quotes, dashes, ©, →, ½", checked: actions.substitutions, onSelect: actions.toggleSubstitutions },
      ...(actions.focusMode
        ? []
        : ([
            { kind: "separator" },
            { label: "Check spelling & grammar here", shortcut: `${mod}⌥X`, onSelect: actions.checkSpelling },
            { label: "Ask Claude to proofread", onSelect: () => actions.ask("Proofread the document and fix spelling, grammar and punctuation. Don't change the meaning or voice.") },
            { label: "Ask Claude for feedback", onSelect: () => actions.ask("Read the document and give me your three most important suggestions to improve it. Don't edit yet.") },
            {
              label: "Ask Claude to address all comments",
              onSelect: () =>
                actions.ask(
                  "Work through every open comment in the document (list_comments). For each one: make the change it asks for if it's clear, reply briefly with what you changed and resolve it; if it's a question or you're unsure, reply with your answer or question and leave it open. Finish with a short summary.",
                ),
            },
            { label: "Check for AI-sounding writing", onSelect: () => actions.ask("Run analyze_writing on the document and point out any passages that sound generic or AI-written. Suggest fixes but don't edit yet.") },
          ] as MenuItem[])),
    ],
    Help: [
      { label: "Keyboard shortcuts", shortcut: `${mod}/`, onSelect: actions.shortcuts },
      { label: "Connect Claude Code…", hint: "Copy the command to use Inline from your terminal", onSelect: actions.connectClaudeCode },
    ],
  };

  return (
    <nav className="menubar" aria-label="Menu">
      {Object.entries(menus).map(([name, items]) => (
        <span key={name}>
          <button
            ref={anchor(name)}
            type="button"
            className={`menubar-item${open === name ? " is-open" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setOpen((value) => (value === name ? null : name))}
            onMouseEnter={() => open && open !== name && setOpen(name)}
          >
            {name}
          </button>
          <Menu open={open === name} onClose={() => setOpen((value) => (value === name ? null : value))} anchor={anchor(name)} items={items} />
        </span>
      ))}
    </nav>
  );
}
