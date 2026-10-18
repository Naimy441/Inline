export const CANVAS_EXAMPLES = {
  editorial: {
    title: "Editorial canvas",
    html: `<Canvas>
<Section id="opening" class="opening" pagination="keep-together">
  <Text id="eyebrow" class="eyebrow">PROJECT PROPOSAL / 2026</Text>
  <Text id="title" as="h1">A better beginning.</Text>
  <Text id="intro" class="lead">A considered proposal for what comes next. Edit any text directly, or ask Claude to make this canvas yours.</Text>
</Section>
<Columns id="overview" ratio="2:1" pagination="keep-together">
  <Column id="approach"><Text as="h2">The approach</Text><RichText><p>Start with the people who will use it. Make the important things clear. Build something useful, then refine it with care.</p></RichText></Column>
  <Column id="details" class="aside"><Text class="eyebrow">AT A GLANCE</Text><Text>Discover. Design. Deliver.</Text></Column>
</Columns>
<Section id="next"><Text as="h2">What happens next</Text><Text>Replace this starting point with your own ideas, notes, and plans.</Text></Section>
</Canvas>`,
    css: `Canvas { color: #25392f; font-family: Georgia; font-size: 12pt; line-height: 1.5; }
.opening { padding: 26px; background-color: #eef1e7; margin-bottom: 30px; }
.eyebrow { font-family: Arial; font-size: 9pt; letter-spacing: 2px; font-weight: 700; }
h1 { font-size: 42pt; line-height: 1.05; margin: 20px 0; }
h2 { font-size: 22pt; margin-top: 24px; margin-bottom: 12px; }
.lead { font-size: 16pt; line-height: 1.5; }
.aside { border-left: 2px solid #789079; padding-left: 18px; }
Columns { gap: 26px; margin-bottom: 24px; }`,
  },
  research: {
    title: "Research canvas",
    html: `<Canvas><Section id="summary"><Text class="label">RESEARCH BRIEF</Text><Text as="h1">Evidence before assumptions.</Text><Text class="lead">A working brief for a clear, defensible decision.</Text></Section><Section id="findings"><Text as="h2">Key findings</Text><RichText><ul><li><p>Describe the strongest evidence and its source.</p></li><li><p>Separate observations from interpretation.</p></li><li><p>Identify what still needs to be tested.</p></li></ul></RichText></Section><Section id="comparison"><Text as="h2">Options at a glance</Text><Table><tr><th>Option</th><th>Strength</th><th>Question</th></tr><tr><td>Approach A</td><td>Established foundation</td><td>How far can it scale?</td></tr><tr><td>Approach B</td><td>Greater flexibility</td><td>What will integration require?</td></tr></Table></Section><Section id="recommendation"><Text as="h2">Recommendation</Text><Text>State a recommendation, its evidence, and the condition that would change it.</Text></Section></Canvas>`,
    css: `Canvas { font-family: Arial; font-size: 11pt; color: #243342; line-height: 1.6; } .label { font-size: 9pt; font-weight: 700; letter-spacing: 2px; color: #38658a; } h1 { font-size: 32pt; line-height: 1.15; margin: 14px 0; } h2 { font-size: 17pt; border-bottom: 1px solid #bbc9d4; padding-bottom: 8px; margin-top: 26px; } .lead { font-size: 14pt; } th { background-color: #eaf0f5; } td { padding: 10px; }`,
  },
  guide: {
    title: "Field guide canvas",
    html: `<Canvas><Section id="cover" class="cover" pagination="keep-together"><Text class="label">A PRACTICAL FIELD GUIDE</Text><Text as="h1">Make room for discovery.</Text><Text class="lead">An illustrated way to explain an idea, teach a skill, or plan an experience.</Text></Section><Columns id="steps" ratio="1:1" pagination="keep-together"><Column class="step"><Text class="label">01 / OBSERVE</Text><Text as="h2">Look closely.</Text><Text>Begin with what you can see. Record details, questions, and surprises.</Text></Column><Column class="step"><Text class="label">02 / EXPERIMENT</Text><Text as="h2">Try something.</Text><Text>Make a small change. Notice what happens and refine the next step.</Text></Column></Columns><Section id="notes"><Text as="h2">Notes from the field</Text><Text>Add your observations here. Ask Claude to add a figure using an uploaded image, or adapt the entire guide to your topic.</Text></Section></Canvas>`,
    css: `Canvas { color: #4b3425; font-family: Georgia; font-size: 12pt; line-height: 1.6; } .cover { background-color: #f4e9d6; padding: 28px; border-top: 5px solid #a55c35; margin-bottom: 28px; } h1 { font-size: 38pt; line-height: 1.1; margin: 20px 0; } h2 { font-size: 22pt; } .label { color: #99532d; font-size: 9pt; letter-spacing: 1px; font-family: Arial; font-weight: 700; } .lead { font-size: 16pt; } Columns { gap: 20px; margin-bottom: 28px; } .step { padding: 16px; border: 1px solid #d8c7b3; }`,
  },
} as const;

/**
 * Syntax fragments for the guide. These are not page designs. The home-screen
 * templates in CANVAS_EXAMPLES stay complete documents for that API only.
 */
export const CANVAS_FRAGMENTS = [
  {
    name: "displayed equation beside text",
    html: `<Text>Say what the equation is for.</Text>\n<Math display id="relation" class="rule">a^2 + b^2</Math>`,
    css: `.rule { margin: 16px 0; padding: 8px 0; border-top: 1px solid #cccccc; border-bottom: 1px solid #cccccc; }`,
  },
  {
    name: "keep-together block",
    html: `<Section id="band" class="band" pagination="keep-together"><Text>One point, kept on a single page.</Text></Section>`,
    css: `.band { padding: 12px; background-color: #f3f3f3; }`,
  },
  {
    name: "two columns",
    html: `<Columns ratio="1:1"><Column><Text>First.</Text></Column><Column><Text>Second.</Text></Column></Columns>`,
    css: `Columns { gap: 24px; }`,
  },
  {
    name: "sized figure",
    html: `<Figure><img src="/api/documents/docid/files/chart.png" alt="Describe the chart" width="330"></Figure>`,
    css: `Figure img { max-width: 330px; }`,
  },
  {
    name: "linear gradient, optional page bleed",
    html: `<Section id="wash" class="wash" pagination="keep-together" bleed><Text>A band whose background can reach the page edge.</Text></Section>`,
    css: `.wash { padding: 20px; background: linear-gradient(#f7f7f7, #e4e4e4); }`,
  },
] as const;

export const CANVAS_GUIDE = `## Inline Canvas SDK v1
Create a Canvas when the layout is part of the piece: a problem set, proposal, brief, poster, or other composed page. Use a Markdown document (create_document, read_document, edit_document) for ordinary writing, notes, and drafts.
Canvases are designed, directly editable PAGED documents. Compose content and design together as declarative HTML/CSS. Use read_canvas for the CURRENT markup, CSS, epoch, and revision. User edits are included. All patches require that exact epoch and revision; re-read on conflict.
Author exactly one <Canvas> root. Components: <Section>, <Stack>, <RichText> contain blocks; <Text as="p|h1|h2|h3|h4|h5|h6"> contains inline text; <Columns ratio="2:1" pagination="keep-together"> contains 2–3 <Column> children; <Figure pagination="keep-together"> contains an image and an optional <p> caption; <Math> is inline LaTeX inside text, and <Math display> is a displayed equation as its own block beside text, not inside <Text> (write < as &lt;). Tables are <table> with <tr>, <th>, and <td> (<Table> is the same tag). HTML p, headings, strong, em, u, s, code, span class, a href, br, hr, ul/ol/li, blockquote, and <PageBreak></PageBreak> are supported. id attributes are patch targets, not CSS selectors. Preserve existing ids. The document title is the first h1, not an eyebrow or label above it.
The fragments with this guide are syntax only. Invent the composition for the subject. Do not reuse that skeleton, and do not reuse a title, equation, or palette from a previous canvas.
A file in this document's folder is a lasting image at /api/documents/<document id>/files/<file>, for example /api/documents/docid/files/graphs.png. Put that URL in <Figure><img src="…" alt="…"></Figure>. The editor and the PDF both load it. insert_image writes Markdown and is refused on a Canvas. Size a picture with <img width="330"> (also 330px, 60%, 4.5in) or with Figure img { max-width: 330px } or Figure { max-width: 330px }. Ids are patch targets: add a class or set <img width>, and do not write a selector such as #fig2 img. Figure p is the caption. text-align on Figure centers the caption and a picture that is narrower than the column; it does not crop or shrink the picture. On letter paper with 1in margins the content column is 6.5in (624px at 96px per inch). Columns gap defaults to 24px. A ratio of 3:2 gives the columns 3/5 and 2/5 of the width left after that gap.
Sections/Stack/RichText default to pagination="flow". Flowing containers must be transparent and have no padding or borders: place decoration on keep-together sections or individual paragraphs instead. A paragraph may split across pages and stays one paragraph. Headings stay with the following block when both fit on a page, and otherwise stay with the first line of a long paragraph. A page gap masks painted backgrounds, including a linear gradient, so color does not cross the sheet gap or paint the wrong page. Columns are one keep-together grid: they do not flow as independent newspaper columns onto the next page. A columns block or figure taller than a page must be split. Tables break between rows and repeat their header. Figures stay with their captions. Use explicit PageBreak for intentional section starts. There is no flow or pageless mode. A keep-together Section may set bleed so its background reaches the page edge; text and images stay inside the margins. Flowing containers cannot bleed.
CSS supports component/tag/class selectors, descendant and child selectors; color, background-color, one linear-gradient() as background, font-family/size/weight/style, line-height, letter-spacing, text alignment/decoration/transform, margins, padding, borders, gap, width/max-width/min-width, and list-style-type. Use literal values. No at-rules, nested rules, variables, URLs, scripts, inline styles, position, height, clipping, display overrides, radial gradients, blend modes, background images, or arbitrary HTML. Layout comes from SDK components. Classes cannot alter editor chrome. Use Inline's font settings for font loading. Display math honors the same box styles (border, padding, margin, background) when the class is on <Math display>.
read_canvas includes these syntax fragments and SDK capabilities on request. create_canvas takes html/css. patch_canvas supports replace (whole Canvas), replace_component (html is a complete Canvas with one replacement block), insert_after (one block), remove, move_after, and styles (CSS only). Pass dry_run to validate and measure that patch without writing it; the result is the same page measurements as inspect_canvas, and the editor does not change. Pass operations, at most 12, instead of operation to apply several edits together. replace_component keeps the ids you write. A replacement root with no id inherits the id it replaces, unless a child already uses that id; the result says which id landed where. The result's steps field is how many steps the revision advanced. A duplicate id that has to be rekeyed adds a step, which is why a revision number can skip. A style patch names a class that is not on any element, because that rule does nothing. Style-only operations preserve every word. Structural patches preserve untouched model nodes and manual formatting. All operations are atomic, version-checked, and reversible through document history. Locked content cannot be replaced or removed.
Do not call read_document, edit_document, write_document, insert_image, or other Markdown tools on a Canvas; they are refused and the document stays as it is. After composing, use check_layout for overflow and unsupported decorations, and inspect_canvas and screenshot_page to inspect the actual browser-rendered pages. Measure with patch_canvas dry_run before the first overflowing layout goes live. inspect_canvas includes each block's top and height in CSS pixels, the content box, and the free space on each page. A PageBreak counts only its own height, not the rest of the page. It flags a mostly empty page, a heading left at the bottom of a page, a last page that holds only a short block, and a page with very little content before a PageBreak. The page a PageBreak starts is not flagged for being short. A one-page document is not flagged for being short. Overflow names the child and says width or height, with the overflow in px. screenshot_page returns the image and a short issue summary; pass include_blocks for the blocks on that page. Fix overflow, oversized components, and invalid flowing decorations, at most a few times. A rejected patch leaves the last valid canvas unchanged. A screenshot's page numbers belong to its revision; pass that epoch and version or the picture is rejected. Patch by content IDs. The editor page follows the app's light or dark theme. Browser Print / Save PDF and Canvas PDF export stay light and use the same paginated HTML, including its CSS. Aim for strong hierarchy, distinct composition, restrained color, readable type, and generous deliberate space. Do not put every paragraph in a card.`;
