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

export const CANVAS_GUIDE = `## Inline Canvas SDK v1
Canvases are designed, directly editable PAGED documents. Compose content and design together as declarative HTML/CSS. Use read_canvas for the CURRENT markup, CSS, epoch, and revision. User edits are included. All patches require that exact epoch and revision; re-read on conflict.
Author exactly one <Canvas> root. Components: <Section>, <Stack>, <RichText> contain blocks; <Text as="p|h1|h2|h3|h4|h5|h6"> contains inline text; <Columns ratio="2:1" pagination="keep-together"> contains 2–3 <Column> children; <Figure pagination="keep-together"> contains <img src="/api/images/…" alt="…"> and an optional <p> caption. HTML p, headings, strong, em, u, s, code, span class, a href, br, hr, ul/ol/li, blockquote, table/tr/th/td and <PageBreak></PageBreak> are supported. Give meaningful id attributes to targets; preserve existing ids.
Sections/Stack/RichText default to pagination="flow". Flowing containers must be transparent and have no padding or borders: place decoration on keep-together sections or individual paragraphs instead. A paragraph may split across pages and stays one paragraph. Headings stay with the following block when both fit on a page, and otherwise stay with the first line of a long paragraph. A page gap masks painted backgrounds so color does not cross the sheet gap or the margins. Columns are one keep-together grid: they do not flow as independent newspaper columns onto the next page. A columns block or figure taller than a page must be split. Tables break between rows and repeat their header. Figures stay with their captions. Use explicit PageBreak for intentional section starts. There is no flow or pageless mode.
CSS supports component/tag/class selectors, descendant and child selectors; color, background-color, font-family/size/weight/style, line-height, letter-spacing, text alignment/decoration/transform, margins, padding, borders, gap, width/max-width/min-width, and list-style-type. Use literal values. No at-rules, nested rules, variables, URLs, scripts, inline styles, position, height, clipping, display overrides, or arbitrary HTML. Layout comes from SDK components. Classes cannot alter editor chrome. Use Inline's font settings for font loading.
read_canvas includes examples and SDK capabilities on request. create_canvas takes html/css. patch_canvas supports replace (whole Canvas), replace_component (html is a complete Canvas with one replacement block), insert_after (one block), remove, move_after, and styles (CSS only). Style-only operations preserve every word. Structural patches preserve untouched model nodes and manual formatting. All operations are atomic, version-checked, and reversible through document history. Locked content cannot be replaced or removed.
Do not call read_document, edit_document, write_document, or other Markdown tools on a Canvas; they are refused and the document stays as it is. After composing, use inspect_canvas and screenshot_page to inspect the actual browser-rendered pages. Fix overflow, oversized components, and invalid flowing decorations, at most a few times. A rejected patch leaves the last valid canvas unchanged. A screenshot's page numbers belong to its revision; pass that epoch and version or the picture is rejected. Patch by content IDs. The editor page follows the app's light or dark theme. Browser Print / Save PDF and Canvas PDF export stay light and use the same paginated HTML, including its CSS. Aim for strong hierarchy, distinct composition, restrained color, readable type, and generous deliberate space. Do not put every paragraph in a card.`;
