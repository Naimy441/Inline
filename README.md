<div align="center">

<img src="desktop/resources/icon.png" alt="Inline" width="112" height="112">

# Inline

**Google Docs-style documents with Claude Code built in.**

[![Latest release](https://img.shields.io/github/v/release/Naimy441/Inline?label=release&color=2f6feb)](https://github.com/Naimy441/Inline/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Naimy441/Inline/total?color=2f6feb)](https://github.com/Naimy441/Inline/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/Naimy441/Inline/ci.yml?branch=main&label=CI)](https://github.com/Naimy441/Inline/actions/workflows/ci.yml)
[![Desktop build](https://img.shields.io/github/actions/workflow/status/Naimy441/Inline/desktop.yml?label=desktop%20build)](https://github.com/Naimy441/Inline/actions/workflows/desktop.yml)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-555)
[![Powered by Claude Code](https://img.shields.io/badge/powered%20by-Claude%20Code-d97757)](https://www.anthropic.com/claude-code)

[![Download for macOS (Apple silicon)](https://img.shields.io/badge/macOS-Apple%20silicon-000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/Naimy441/Inline/releases/latest/download/Inline-mac-arm64.dmg)
[![Download for macOS (Intel)](https://img.shields.io/badge/macOS-Intel-000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/Naimy441/Inline/releases/latest/download/Inline-mac-x64.dmg)
[![Download for Windows](https://img.shields.io/badge/Windows-x64-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/Naimy441/Inline/releases/latest/download/Inline-windows-x64-setup.exe)
[![Download for Linux](https://img.shields.io/badge/Linux-AppImage-FCC624?style=for-the-badge&logo=linux&logoColor=black)](https://github.com/Naimy441/Inline/releases/latest/download/Inline-linux-x86_64.AppImage)

</div>

TLDR: Inline is an open-source project that bridges AI coding-agent tools (like Cursor) with Google Docs-style rich-text editing. Today, AI agents work well in code/markdown environments but not inside a WYSIWYG document editor, while tools like Google Docs lack deep agentic capabilities. Inline aims to combine both, letting an AI agent work directly inside a collaborative rich-text document.

## Running Inline

Inline's agent is Claude Code. It runs on your own Claude account through the Claude Agent SDK, so there are no API keys to paste into the app.

**Requirements:** Node.js 20 or newer, and Claude Code signed in on the machine that runs Inline (run `claude`, then `/login`).

```bash
npm install
npm run dev        # http://localhost:3000
```

For a production build, run `npm run build && npm start`.

### Desktop app

Inline also comes as an app for macOS, Windows and Linux:

| Platform | Download | Notes |
| --- | --- | --- |
| macOS (Apple silicon) | [Inline-mac-arm64.dmg](https://github.com/Naimy441/Inline/releases/latest/download/Inline-mac-arm64.dmg) | Signed and notarized by Apple. Updates itself. |
| macOS (Intel) | [Inline-mac-x64.dmg](https://github.com/Naimy441/Inline/releases/latest/download/Inline-mac-x64.dmg) | Signed and notarized by Apple. Updates itself. |
| Windows 10/11 | [Inline-windows-x64-setup.exe](https://github.com/Naimy441/Inline/releases/latest/download/Inline-windows-x64-setup.exe) | Not yet signed: on first launch choose **More info › Run anyway**. |
| Linux | [Inline-linux-x86_64.AppImage](https://github.com/Naimy441/Inline/releases/latest/download/Inline-linux-x86_64.AppImage) | `chmod +x` it, then run it. A `.tar.gz` is on the [release page](https://github.com/Naimy441/Inline/releases/latest). |

Older versions are on the [Releases](https://github.com/Naimy441/Inline/releases) page. The app runs Inline's server on your computer and includes Claude Code, so there's nothing else to install. Sign in from the Claude panel with **Sign in with Claude**.

You can use the browser at the same time. While the app is open, **File › Open in Browser** opens the page you're on at `http://localhost:4319`, and both show the same documents live.

The app's code is in [`desktop/`](desktop/README.md). It's a separate npm package, so `npm install` and `npm run dev` here stay web-only. To work on the app, run `npm install --prefix desktop` once, then `npm run desktop:dev`. To build installers, run `npm run desktop:dist`.

Open a document and press <kbd>Ctrl/⌘</kbd>+<kbd>J</kbd> to open the Claude panel. Claude reads and edits the document through Inline's MCP tools. Each edit shows up as a tracked change that you can keep or undo, one at a time or all at once. Select text and press <kbd>Ctrl/⌘</kbd>+<kbd>L</kbd> to ask about just that passage.

### Use Inline from Claude Code (or any MCP client)

The same document tools are served over MCP at `/api/mcp`. This means a Claude Code session in your terminal can work on your Inline documents while you watch the edits appear live in the browser:

In Inline, choose **Help > Connect Claude Code** to copy the command. It looks like this:

```bash
claude mcp add --transport http inline http://localhost:3000/api/mcp --header "Authorization: Bearer <token>"
```

The token keeps other programs on your machine from editing your documents. Inline creates it on first run and keeps it in the data folder as `mcp-token`.

The tools are `list_documents`, `open_document`, `create_document`, `read_document`, `get_outline`, `search_document`, `get_editor_context`, `edit_document`, `multi_edit_document`, `insert_content`, `write_document`, `format_text`, `set_paragraph_style`, `get_document_settings`, `update_document_settings`, `get_pending_changes`, `keep_changes`, `revert_changes`, `list_comments`, `add_comment`, `reply_to_comment`, `resolve_comment`, `list_versions`, `save_version`, `restore_version`, `analyze_writing`, `export_document`, and for organizing: `list_library`, `list_folders`, `move_documents`, `create_folder`, `update_folder` and `delete_folder`.

On the home page, **Organize with Claude** (or <kbd>Ctrl/⌘</kbd>+<kbd>J</kbd>) opens Claude to sort your documents into folders. It works from titles and the first few words of each document rather than reading every document, so sorting a large library uses little of your Claude usage.

### Your documents on your computer

Inline keeps a Word (.docx) copy of every document in a folder on your computer, `~/Documents/Inline` by default, arranged in the same folders as on the home page. Each copy is updated a couple of seconds after you stop typing and keeps everything the page shows: fonts, margins, page size, headers and footers, page numbers, images and tables. Renaming or moving a document moves its file, trashed documents go to an `Inline Trash` folder, and deleting one for good removes its file. Inline never overwrites a Word file it didn't write.

Choose the folder, or turn copies off, with **On this computer** on the home page. **Show in Finder** (File Explorer on Windows) on any document or folder opens it there, and **Download all** gives you the same folder as a ZIP.

### Moving from Google Docs

Export your Google Drive with [Google Takeout](https://takeout.google.com/) (Drive only, Documents as DOCX) and choose **Import files** on the home page with the .zip. Every Google Doc becomes an Inline document in the same folders it had in Drive, and page previews are drawn in the background.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `INLINE_DATA_DIR` | `.inline` in the project folder | Where documents, versions, chats and uploads are stored. |
| `INLINE_MIRROR_DIR` | `~/Documents/Inline` (or the folder chosen on the home page) | Where the Word copy of every document is kept. Set it to `off` to turn copies off. When set, it overrides the choice on the home page. |
| `INLINE_ALLOWED_HOSTS` | local hostnames only | Comma-separated extra hostnames to accept, for serving Inline on a network. Requests for other hosts are refused, which blocks DNS-rebinding attacks. |
| `INLINE_ACCESS_TOKEN` | unset | When set, every request must carry this secret, either as a `Bearer` token or as the `inline_token` cookie. Visit any page with `?token=<secret>` once to set the cookie. Set this whenever Inline is reachable by anyone but you, because the agent acts with your Claude account. |
| `INLINE_MCP_TOKEN` | generated | The token MCP clients must send to `/api/mcp`. Set it to choose your own, or to `off` to accept any local client. |
| `INLINE_LOG_LEVEL` | errors and warnings | Set to `info` to also print informational log lines. Logs are kept in `logs/inline.log` in the data folder. |
| `INLINE_DEBUG_AGENT` | unset | Print Claude Code's stderr to the server log. |

### Development

```bash
npm run typecheck
npm test           # document model, editing engine, review and MCP tool tests
npm run test:e2e   # browser tests (Playwright; set CHROMIUM_PATH to use a system Chromium)
```

---

This is a project that aims to bring capabilities restricted primarily to software developers to a broader audience, including corporate workers, writers, professionals, and students, for the specific purpose of writing or drafting documents.

Cursor IDE is an integrated development environment that brings in an AI or multiple agents that can work on your computer to do various tasks in a folder, such as writing entire files, making specific edits to files, running lints on code, debugging code, access to the terminal to run commands, accessing the web to learn, accessing MCP tools to do tasks, and so much more. It really has gone beyond the scope of simply programming and can be used for many other tools, which is why even writers have switched to Cursor.

Google Docs is a landmark tool that allows for collaborative editing of a document that you can access anywhere with an internet connection. It has many powerful tools to style the document and has templates for you to get started. It is used by a wide variety of people for its simplicity, ease of access, and export ability to various forms, primarily PDFs.

Of course, Cursor can do everything Claude, ChatGPT, or Gemini + Google Docs can and far more (it is the more powerful writing assistant because it has access to more modelsm and more tools), however, it cannot do that in an interface such as Google Docs. Agents works exclusively in the realm of .md, .txt, code, or data, whereas humans work in a rich-text editor that is the page. 

Inline is an open-source project that bridges the gap, where an agent can use all the powerful capabilities that come from an AI IDE and a Google Docs editor.

The user can write documents collaboratively and use all the rich-text editing features of Google Docs, while having an agent do the following:

- Perform specific edits on the document that can be approved or rejected
- Recieve context from the user that they specifically highlighted or selected for precise edits or suggestions
- Recieve comments to address all at once for multiple selected parts of the document
- Recieve prompts from the user to do something from the document itself without the user having to tap the agent chat window
- Preserve existing tone or be locked away from editing certain parts of the document
- Write code and run it or access MCP tools that the user doesn't need to see in order to achieve its task
- Use linting tools, such as number of words, number of paragraphs, vocabulary diversity, writing/vocabulary level, page length check, etc. to quickly diagnose issues
- Catch AI-generated tropes like em-dashes or AI-sentence structures and remove AI tokens or watermarks
- Easy rollback to previous states of the document
- Show its CoT (chain-of-thought) reasoning if its a thinking model
- Create a list of tasks for research, drafting, etc.
- Fix grammar, spelling, and formatting with a single hotkey press from the user
- Suggest tone or style of writing changes
- Summarize the document and answer questions about it and ideate on how to improve it
- Generate bibliographies or inline citations using specific MCP integrations
- Use other documents that are attached by the user to mimic style
- Use embeddings and other AI-enginerring techniques on really long documents to maintain quality writing
- Offer templated prompts for common document types: emails, business letters, essays, fiction, nonfictions, etc.
- MCP allows the AI to do anything you can do for you: export as PDF, undo changes, find and insert images or embed links, highlight text, change font sizes, use bullet lists, add a header, add page numbers, etc.
- Hide itself in focus mode so the user doesn't see any AI tools

The user doesn't need to copy and paste from an app or website and then reformat and flip between the AI and their document. The AI does everything inside their document instantly.   

In regards to the features necessary for a simple clone of Google Docs:

HOME PAGE
Logo
Search

Template gallery
- Blank document
- Resume
- MLA report

Recent documents
- Documents (Last opened, Rename, Remove, Open in new tab)
- Grid view, List view
- Folders (nested, colored, with a breadcrumb; drag documents in or use Move to…; shift-click to pick several)

DOCUMENT EDITOR
Logo
Title

File
- Make a copy
- Share
- Download (.docx, .pdf, .txt, .md)
- Trash
- Page setup (margins, paper size)
- Print
Edit
- Undo, Redo, Cut, Copy, Paste, Paste without formatting, Select all, Delete, Search and replace
View
- Mode (editing, suggesting, viewing)
- Comments (minimize, expand)
- Show non-printing characters
- Full screen
Insert
- Image
- Table
- Link
- Emojis, Special characters
- Tab
- Horizontal line
- Page break
Format
- Text (Bold, Italics, Underline, Strikethrough, Superscript, Subscript, Capitalization)
- Global styles
- Align and indent
- Line spacing
- Columns (1 column, 2 columns, 3 columns)
- Headers/footers
- Page numbers
- Clear formatting
Tools
- Word count
- Compare documents
- Citations
- eSignature
- Substitutions (copyright, em dashes, etc.)
- Screen reader
Help
- Privacy Policy
- Terms of Service
- Keyboard shortcuts

Version Control
Share 
- Add via email
- Copy link
- Restricted/Anyone with link (viewer, commenter, editor)
Account

Toolbar
- Search
- Undo
- Redo
- Print
- Spell/grammar check
- Zoom
- Normal text, Title, Subtitle, Heading 1/2/3
- Fonts: Arial, Times New Roman, Robot Mono, Courier New, EB Garamond, etc.
- Font Size
- Bold, Italics, Underline, Text Color, Highlight Color
- Insert Link, Image
- Left align, Center align, Right align, Justify
- Line spacing
- Bullet lists, Numbered lists
- Decrease indent, Increase indent
- Clear formatting

Tabs, Table of Contents
Page (8.5” x 11”, 1” margins)

Select+Right click
- Cut, Copy, Paste, Paste without formatting, Delete, Clear Formatting

GENERAL FEATURES
- WYSIWYG
- Focus Mode (no or less AI)
- Collaborative Editing
- Light/Dark Mode