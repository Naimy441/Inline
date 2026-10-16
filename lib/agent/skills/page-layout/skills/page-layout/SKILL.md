---
name: page-layout
description: Use when the user wants the document to look good, look polished, or have its layout fixed, including spacing, fonts, images, tables, page breaks, a last page with only a line or two, or anything that looks uneven on the page. Look at the pages, then fix the problems in the document.
---

# Make the document look good

The user wants the pages to look right. Look first, then fix what you find. Don't only comment. In Agent mode, make the edits. In Ask mode you cannot edit; describe the exact fixes and say to switch to Agent mode.

Do not change the author's wording to solve a layout problem unless spacing, breaks, size or alignment cannot. Do not change margins, page size, or the document's default font to hide a layout problem unless the user asks.

## Look

1. read_document (the open document may already be in the message) and get_page_count. get_page_count says how many pages there are, where each page starts, and how full the last page is. Use that before guessing.
2. get_document_settings when the default font, size, line spacing or paragraph spacing matters.
3. screenshot_page when the picture is the right signal. It shows one page as the editor lays it out (page is 1-based), including when that document is not open, in the light or dark appearance the user is using. Pass theme light or dark when you need the other one. Markdown hides fonts and most spacing, and it cannot show a crowded table, an image that overflows, or a gap you can only see. After you change a page you judged from a picture, screenshot that page again.

Skip a screenshot when get_page_count already answers the question (for example how full the last page is) and you do not need to see how the page looks.

## What to find, and how to fix it

### Fit a page range into a height

When the user wants laid-out pages squeezed into a height (half a page, one page, two pages, or any other fraction or count), call get_page_count once. from_page and to_page are the range. pages is the height: 0.5 is half a page, 1 is one page. The tool measures the open editor, including a page that is only partly full, and sets font size and line spacing. Do not try sizes with format_text, set_paragraph_style, or update_document_settings, and do not change named styles or the document font. The document has to be open. If the tool says nothing was changed, stop.

### A last page with only a line or two

get_page_count reports how full the last page is. A few percent, or a page start on the last lines, means the last page is almost empty. screenshot_page that page when you need to see whether it is two leftover lines, a heading by itself, or a figure with nothing under it.

Pull the spill back onto the previous page. Tighten the gap above it with set_paragraph_style (space_before, space_after, line_spacing) on the blocks that open it, or shorten a paragraph if the user asked you to fit a length. Remove an empty paragraph (`&nbsp;`) that is only acting as a spacer. If a heading sits alone at the bottom, keep it with the text that follows: put `\pagebreak` on its own line before the heading when the heading and its paragraph will not fit together. Check get_page_count again. Stop when the last page is clearly used, or when the user asked for a length you have already hit.

### A table split across a page break

get_page_count names a page start inside a table ("table"). screenshot_page the page where it breaks and the next page. A header row alone at the bottom, or a couple of rows stranded on the next page, should be fixed. A crowded table (text jammed in the cells, or columns running into the margin) shows up in the same picture.

If the whole table fits on one page, either tighten the spacing above it so it stays put, or put `\pagebreak` on its own line before the table so it starts together on the next page. If the table is taller than a page, break it between rows and repeat the header row on the continuation. Edit the table with edit_document. For a crowded table, set a slightly smaller font_size on the table's text with format_text rather than shrinking the whole document. Do not change the words in the cells just to make it fit.

### Random font changes

screenshot_page is how you see a word or paragraph in a different face or size: read_document usually does not show fonts. Also scan for `{font=...}`, `size=`, and `<span style="font-family...">` when they are in the Markdown.

Make body text match the document default from get_document_settings, and keep each heading level to one size. format_text sets font_family (null resets it) and font_size (null resets it) on the exact text or a line range. Leave a font the user clearly chose on purpose (a title, one emphasized name). Fix only changes that look accidental.

### Images that are too big

screenshot_page shows an image that runs past the text, crowds the margins, or eats a page. read_document shows `![alt](url){width=320}` or `width=80%`. Shrink it with edit_document: set width to a percentage of the text width (`width=70%`) or a smaller pixel width, and `align=center` for a figure. An image that forces a nearly blank page should shrink so the caption and the following text sit with it.

### Inconsistent spacing

screenshot_page shows uneven gaps: a large hole above one paragraph, a heading jammed against the line above, a list much tighter than the paragraphs around it. Markdown usually omits this.

set_paragraph_style sets space_before, space_after and line_spacing (null uses the document default) on a line range. Give the same kind of block the same spacing, matching paragraph spacing from get_document_settings. Replace spacer paragraphs (`&nbsp;`) with that spacing.

## Finish

After the edits, get_page_count again. screenshot_page again for every page you changed because of a picture. Keep going until the problem you looked at is gone. Then tell the user, in a sentence or two, what you changed.
