"use client";

import { redo, undo } from "prosemirror-history";
import { AllSelection } from "prosemirror-state";
import { createRef, useRef, useState, type RefObject } from "react";
import type { DocumentSession, EditorMode } from "@/lib/client/documentSession";
import { currentRevealLabel } from "@/lib/client/fileManager";
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
import { insertEquation } from "@/lib/editor/math";

export type MenuActions = {
  newDocument: () => void;
  goHome: () => void;
  duplicate: () => void;
  /** Show the document's Word copy on disk ("Show in Finder"). */
  reveal: () => void;
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
  addTab: () => void;
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
  /** Zoom follows the window ("Fit"), shrinking pages that don't fit. */
  zoomFit: boolean;
  /** Phones: text reflows to the screen, so zoom and the outline don't apply. */
  flow: boolean;
  fullScreen: () => void;
  focusMode: boolean;
  toggleFocusMode: () => void;
  notice: (message: string) => void;
  mode: EditorMode;
  setMode: (mode: EditorMode) => void;
  showInvisibles: boolean;
  toggleInvisibles: () => void;
  /** The browser's spelling underlines. */
  spellcheck: boolean;
  toggleSpellcheck: () => void;
  substitutions: boolean;
  toggleSubstitutions: () => void;
};

const MENU_TIPS: Record<string, string> = {
  File: "New, copy, download, print and history",
  Edit: "Undo, clipboard and find",
  View: "Zoom, mode, panels and theme",
  Insert: "Links, images, tables and breaks",
  Format: "Text, paragraph and list styles",
  Tools: "Spelling, word count and Claude",
  Help: "Shortcuts and connecting Claude Code",
};

export function MenuBar({ session, actions, zoom, hunks }: { session: DocumentSession; actions: MenuActions; zoom: number; hunks: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const anchors = useRef<Record<string, RefObject<HTMLButtonElement | null>>>({});
  const anchor = (name: string) => (anchors.current[name] ??= createRef<HTMLButtonElement>());
  const menus = documentMenus(session, actions, zoom, hunks);

  return (
    <nav className="menubar" aria-label="Menu">
      {Object.entries(menus).map(([name, items]) => (
        <span key={name}>
          <button
            ref={anchor(name)}
            type="button"
            className={`menubar-item${open === name ? " is-open" : ""}`}
            aria-haspopup="menu"
            aria-expanded={open === name}
            data-tip={open ? undefined : MENU_TIPS[name]}
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

/** The menu bar's menus (File, Edit, View, …), shared with the phone's overflow menu. */
export function documentMenus(session: DocumentSession, actions: MenuActions, zoom: number, hunks: number): Record<string, MenuItem[]> {
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
      { label: "Print", shortcut: `⌘P`, onSelect: actions.print },
      { label: currentRevealLabel(), onSelect: actions.reveal },
      { kind: "separator" },
      { label: "Version history", onSelect: actions.history },
      { label: "Page setup", onSelect: () => actions.pageSetup("page") },
      { kind: "separator" },
      { label: "Move to trash", danger: true, onSelect: actions.trash },
    ],
    Edit: [
      { label: "Undo", shortcut: `⌘Z`, onSelect: () => run(undo) },
      { label: "Redo", shortcut: `⌘⇧Z`, onSelect: () => run(redo) },
      { kind: "separator" },
      { label: "Cut", shortcut: `⌘X`, onSelect: () => actions.clipboard("cut") },
      { label: "Copy", shortcut: `⌘C`, onSelect: () => actions.clipboard("copy") },
      { label: "Paste", shortcut: `⌘V`, onSelect: () => actions.paste(false) },
      { label: "Paste without formatting", shortcut: `⌘⇧V`, onSelect: () => actions.paste(true) },
      {
        label: "Select all",
        shortcut: `⌘A`,
        onSelect: () => {
          const view = session.view;
          if (!view) return;
          session.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
          view.focus();
        },
      },
      { kind: "separator" },
      { label: "Find", shortcut: `⌘F`, onSelect: () => actions.find(false) },
      { label: "Find and replace", shortcut: `⌘H`, onSelect: () => actions.find(true) },
      { kind: "separator" },
      { label: "Keep all pending changes", hint: "Claude's edits and suggestions", disabled: !hunks, onSelect: () => void session.review("accept", "all") },
      { label: "Undo all pending changes", disabled: !hunks, onSelect: () => void session.review("reject", "all") },
      { label: "Next change", shortcut: "⌥]", disabled: !hunks, onSelect: () => session.gotoChange(1) },
    ],
    View: [
      { label: "Mode", submenu: modeMenuItems(actions.mode, actions.setMode) },
      ...(actions.flow
        ? []
        : ([
            { kind: "separator" },
            { label: "Zoom in", onSelect: () => actions.zoom(Math.min(2, Math.round((zoom + 0.1) * 10) / 10)) },
            { label: "Zoom out", onSelect: () => actions.zoom(Math.max(0.5, Math.round((zoom - 0.1) * 10) / 10)) },
            { label: "Actual size", checked: !actions.zoomFit && zoom === 1, onSelect: () => actions.zoom(1) },
            { label: "Fit to window", hint: "Shrink pages that don't fit", checked: actions.zoomFit, onSelect: actions.fitWidth },
            { kind: "separator" },
            { label: "Tabs & outline", onSelect: actions.toggleOutline },
          ] as MenuItem[])),
      { kind: "separator" },
      ...(actions.focusMode ? [] : [{ label: "Claude panel", shortcut: `⌘J`, onSelect: actions.toggleAgent }]),
      { label: "Focus mode", hint: "Hide Claude while you write", checked: actions.focusMode, onSelect: actions.toggleFocusMode },
      { label: "Show non-printing characters", shortcut: `⌘⇧P`, checked: actions.showInvisibles, onSelect: actions.toggleInvisibles },
      { label: "Show spelling underlines", checked: actions.spellcheck, onSelect: actions.toggleSpellcheck },
      { label: "Dark theme", checked: actions.dark, onSelect: actions.toggleTheme },
      { label: "Full screen", onSelect: actions.fullScreen },
    ],
    Insert: [
      { label: "Image…", onSelect: actions.image },
      { label: "Tab", onSelect: actions.addTab },
      {
        label: "Table",
        submenu: [2, 3, 4, 5].map((size) => ({ label: `${size} × ${size}`, onSelect: () => run(insertTable(size, size)) })),
      },
      { label: "Link", shortcut: `⌘K`, onSelect: actions.link },
      { label: "Comment", shortcut: `⌘⌥M`, onSelect: actions.comment },
      { kind: "separator" },
      {
        label: "Equation",
        submenu: [
          { label: "Inline equation", hint: "Type $…$", onSelect: () => !run(insertEquation(false)) && actions.notice("Put the cursor in a paragraph to add an equation.") },
          { label: "Display equation", hint: "Type $$ and a space", onSelect: () => !run(insertEquation(true)) && actions.notice("Put the cursor in a paragraph to add an equation.") },
        ],
      },
      { label: "Special characters…", onSelect: actions.specialCharacters },
      { label: "Table of contents", onSelect: () => !run(insertTableOfContents) && actions.notice("Add some headings first; the table of contents lists them.") },
      { kind: "separator" },
      { label: "Horizontal line", onSelect: () => run(insertHorizontalRule) },
      { label: "Page break", shortcut: `⌘⏎`, onSelect: () => run(insertPageBreak) },
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
          { label: "Bold", shortcut: `⌘B`, onSelect: () => run(toggle("bold")) },
          { label: "Italic", shortcut: `⌘I`, onSelect: () => run(toggle("italic")) },
          { label: "Underline", shortcut: `⌘U`, onSelect: () => run(toggle("underline")) },
          { label: "Strikethrough", shortcut: `⌘⇧X`, onSelect: () => run(toggle("strike")) },
          { label: "Superscript", shortcut: `⌘.`, onSelect: () => run(toggle("superscript")) },
          { label: "Subscript", shortcut: `⌘,`, onSelect: () => run(toggle("subscript")) },
          { label: "Code", shortcut: `⌘E`, onSelect: () => run(toggle("code")) },
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
          { label: "Left", shortcut: `⌘⇧L`, onSelect: () => run(setAlign("left")) },
          { label: "Center", shortcut: `⌘⇧E`, onSelect: () => run(setAlign("center")) },
          { label: "Right", shortcut: `⌘⇧R`, onSelect: () => run(setAlign("right")) },
          { label: "Justified", shortcut: `⌘⇧J`, onSelect: () => run(setAlign("justify")) },
        ],
      },
      {
        label: "Lists",
        submenu: [
          { label: "Bulleted list", shortcut: `⌘⇧8`, onSelect: () => run(toggleList("bullet")) },
          { label: "Numbered list", shortcut: `⌘⇧7`, onSelect: () => run(toggleList("ordered")) },
          { label: "Checklist", shortcut: `⌘⇧9`, onSelect: () => run(toggleList("task")) },
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
      { label: "Clear formatting", shortcut: `⌘\\`, onSelect: () => run(clearFormatting) },
    ],
    Tools: [
      { label: "Word count", onSelect: actions.wordCount },
      { label: "Automatic substitutions", hint: "Smart quotes, dashes, ©, →, ½", checked: actions.substitutions, onSelect: actions.toggleSubstitutions },
      ...(actions.focusMode
        ? []
        : ([
            { kind: "separator" },
            { label: "Check spelling & grammar here", shortcut: `⌘⌥X`, onSelect: actions.checkSpelling },
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
      { label: "Keyboard shortcuts", shortcut: `⌘/`, onSelect: actions.shortcuts },
      { label: "Connect Claude Code…", hint: "Copy the command to use Inline from your terminal", onSelect: actions.connectClaudeCode },
    ],
  };
  return menus;
}
