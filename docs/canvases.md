# Canvases

Canvases are paginated, directly editable HTML/CSS compositions. The Canvas card on the home screen is an empty page, like Blank document, and opens an empty canvas. Ask Claude to design it. Text editing uses the existing ProseMirror editor, collaboration, comments, locks, and history. There is no Canvas flow mode.

## Authoring contract

`get_canvas_guide` returns the SDK and three complete examples. `read_canvas` returns the current live composition, stylesheet, epoch, and revision, including manual edits. Claude authors declarative markup rather than executable React. The importer translates it into the shared document schema. The live document is authoritative; the authoring markup is derived on read.

Create a Canvas when the layout is part of the piece. Ordinary writing stays a Markdown document.

Components: Canvas, Section, Stack, RichText, Text, Columns, Column, Figure, Math, Table, and PageBreak. Basic semantic paragraphs, headings, lists, emphasis, links, and table rows/cells are supported. Tables are `table`, `tr`, `th`, and `td` (`Table` is the same tag). `Columns` contains two or three `Column` children and an optional ratio such as `2:1`. `Figure` contains an image and an optional paragraph caption. `<Math>` is inline LaTeX; `<Math display>` is a displayed equation. id attributes are patch targets, not CSS selectors. The document title is the first h1, not an eyebrow above it.

An image file in the document folder is a lasting source at `/api/documents/<id>/files/<name>` (for example `/api/documents/<id>/files/graphs.png`). The editor and the PDF both load that URL. `insert_image` is a Markdown tool and is refused on a Canvas. An `img` `width` (`330`, `330px`, `60%`, `4.5in`) or `Figure img { max-width }` / `Figure { max-width }` sizes the picture. `Figure p` is the caption. `text-align` on `Figure` centers the caption and a picture narrower than the column; it does not crop the picture. On letter paper with 1 inch margins the content column is 6.5 inches (624px at 96px per inch). The columns gap defaults to 24px, and a ratio of `3:2` splits the remaining width 3/5 and 2/5.

CSS supports component/tag/class selectors and descendant/child relationships, typography, literal colors, spacing, borders, widths, and gaps. Layout comes from SDK primitives. At-rules, network resources, scripts, inline styles, arbitrary positioning, clipping, heights, nested CSS, and editor-reserved classes are rejected. CSS is parsed with PostCSS and scoped to one editor root. HTML is parsed with parse5 and imported into checked schema nodes.

Flowing sections are transparent, without padding or borders. Decorate their text blocks or set `pagination="keep-together"`. A paragraph may split across pages and remains one paragraph, so selection, deletion, and undo cross the boundary. Headings stay with the following block when both fit on a page, and otherwise stay with the first line of a long paragraph. Page-gap masks cover the margins and the sheet gap, so a painted paragraph background does not cross the gap. Columns are one keep-together grid: compact columns stay together, and they do not flow as independent newspaper columns. A columns block or figure taller than a page must be split. Tables break between rows and repeat a header that fits. Figures stay with their captions. Painted columns inside an indivisible comparison can have backgrounds and padding. Independent newspaper columns, arbitrary cross-page grids, and page-master templates are outside SDK v1. Canvases do not enter reflow.

## Revisions and changes

Canvas design lives in the document root's versioned `canvas` attribute, alongside its content tree. Existing documents default that attribute to null. Canvas metadata carries `kind: "canvas"` for library/workspace identification. Content and CSS therefore save, synchronize, checkpoint, and restore together.

`patch_canvas` accepts the epoch and revision from `read_canvas`. Operations are `styles`, `replace`, `replace_component`, `insert_after`, `remove`, and `move_after`. Pass `operations` (at most 12) instead of `operation` to apply several edits in one revision check. Component operations preserve untouched nodes and formatting. Stale patches and changes to locked content are rejected. A component replacement supplies one replacement block wrapped in Canvas. Ids written on that block are kept. A root with no id inherits the replaced id, unless a child already uses it. The result reports `steps`: how many steps the revision advanced. Rekeying a duplicate id adds a step, so a revision number can skip. A style patch names a class that is not on any element.

CSS changes go through `patch_canvas` and undo with the document. Claude changes use the existing per-turn checkpoints/rewind workflow. Save a named version through the existing history controls when appropriate.

## Rendering and export

Canvas rendering keeps one editable DOM and uses the existing measured pagination engine. Flowing content continues across sheets; indivisible components are measured as boxes. Inline's ordinary named paragraph stylesheet is omitted for Canvas pages so it does not override the authored design. Explicit direct text formatting remains available.

`inspect_canvas` returns real browser measurements, component/page mappings with each block's top and height, the content box, free space on each page, fonts, image assets, layout diagnostics, and revision/profile metadata. Diagnostics include a mostly empty page, a heading left at the bottom, and a short last page. An intentional page break is not treated as a gap, and those page-fit notes do not block PDF export. `screenshot_page` captures the rendered page rectangle directly in Chromium for Canvases, including backgrounds and supported CSS, and returns only that page's blocks. Pass the epoch and version from that inspection to reject a stale page reference. `/api/documents/:id/canvas/render?page=1` exposes PNG capture; optional epoch/version parameters reject stale capture requests. Markdown document tools are refused on a Canvas and leave it unchanged. Invalid markup or CSS is rejected the same way. Repair is a few fresh patches against the current revision, not a loop that replaces a valid canvas with a broken one.

The PDF action uses `/api/documents/:id/canvas/pdf`, which prints the same paginated HTML using Chromium, retaining selectable text and supported CSS. Required missing images, stalled font loading, stale snapshots, and known layout issues produce errors. Browser Print / Save PDF remains available. Match paper size and disable browser-added headers/margins when printing manually.

Server capture and PDF export launch Playwright's Chromium and print the settled pages, including backgrounds and canvas CSS, on light paper. If that headless shell is not downloaded, export launches the Chromium this project's Playwright already installed, or installs that browser and tries again. `CHROMIUM_PATH` still selects a binary explicitly. The render route mounts an offline document session, preventing an inspection window from joining collaboration. Each render verifies its snapshot's epoch/revision and reports a layout fingerprint. The page being edited follows the app's light or dark theme. Print and PDF stay on the light publication palette.

## Verification

`lib/canvas/canvas.test.ts` covers import/export round trips, supported contracts, CSS isolation, stale patches, locks, focused changes, undo, authority validation, persistence, and restoring content with design. `e2e/canvas.spec.ts` covers actual editing, authored CSS, text undo, reopening, stale changes, block reordering, spanning paragraphs, direct browser capture, and HTML-based PDF export.

Use a supported Node runtime for the existing dependency set (Node 24 for the PDF/sandbox suite). The browser suite uses the repository's normal Playwright configuration; `CHROMIUM_PATH` can point at an installed Chrome.
