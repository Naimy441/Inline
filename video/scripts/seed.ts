// Builds the demo account the video is filmed with: folders, documents, comments and saved
// versions, written straight into an Inline data folder.
// Run from the repository root: INLINE_DATA_DIR=<dir> npx tsx video/scripts/seed.ts
import fs from "node:fs";
import path from "node:path";

import type { Node as PMNode } from "prosemirror-model";

import { compileCanvas } from "../../lib/canvas/compiler";
import { createFolder } from "../../lib/server/folders";
import { documentHub } from "../../lib/server/hub";
import { saveUpload } from "../../lib/server/store";

if (!process.env.INLINE_DATA_DIR) throw new Error("Set INLINE_DATA_DIR to the demo data folder.");

const GEORGIA = "Georgia, serif";
const TIMES = '"Times New Roman", Times, serif';
const INTER = "Inter, system-ui, sans-serif";
const GARAMOND = '"EB Garamond", Garamond, serif';

/** Position of the nth occurrence of `text` in the document. */
function find(doc: PMNode, text: string, occurrence = 1): { from: number; to: number } {
  let seen = 0;
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found || !node.isTextblock) return !found;
    const plain = node.textContent;
    let at = plain.indexOf(text);
    while (at >= 0 && !found) {
      seen += 1;
      if (seen === occurrence) {
        // Map the character offset to a document position (text-only paragraphs).
        let offset = 0;
        node.forEach((child, childOffset) => {
          if (found) return;
          const len = child.isText ? child.text!.length : 1;
          if (at >= offset && at < offset + len) {
            const from = pos + 1 + childOffset + (at - offset);
            found = { from, to: from + text.length };
          }
          offset += len;
        });
      }
      at = plain.indexOf(text, at + 1);
    }
    return false;
  });
  if (!found) throw new Error(`"${text}" not found`);
  return found;
}

const THESIS = `# Living Shorelines in a Changing Climate {.title}

Measuring how oyster reefs and salt marshes protect the North Carolina coast {.subtitle}

\\tableofcontents {depth=2}

## Introduction

Every year, coastal communities along the Atlantic seaboard spend hundreds of millions of dollars on bulkheads and seawalls, structures that hold the line against erosion but also cut the shoreline off from the habitats that once protected it naturally. As sea levels rise and storms intensify, it has become increasingly important to understand whether there might be better, more sustainable, and more ecologically sound alternatives that could potentially offer comparable protection while also restoring some of the ecological functions that hardened shorelines remove. Living shorelines, which combine planted marsh with a low sill of rock or oyster shell, are one such alternative. {first-line=0.5}

This proposal asks a simple question: how much wave energy does a living shoreline actually absorb, and how does that change as the marsh matures? Answering it would give planners the evidence they need to choose nature-based defenses with confidence. {first-line=0.5}

## Background

Hardened shorelines now line roughly 14 percent of the continental United States coast <cite>(Gittman et al., 2015)</cite>. Bulkheads reflect wave energy rather than dissipating it, which scours the bed in front of the wall and accelerates erosion on neighboring properties. Living shorelines take the opposite approach: they slow water down. {first-line=0.5}

Field studies after Hurricane Irene found that marsh-fronted shorelines suffered significantly less damage than bulkheaded ones <cite>(Smith et al., 2018)</cite>. What remains unclear is how quickly that protection develops after construction, and how it varies with marsh width and sill design. {first-line=0.5}

## Research questions

1. How much does significant wave height decrease across a living shoreline, compared with a bulkhead on the same reach?
2. How does that attenuation change over the first three growing seasons as the marsh fills in?
3. Which design variables, such as sill height, marsh width, or oyster cover, explain the most variation?

## Methods

I will deploy pressure sensors in transects at three sites in Carteret County, recording at 4 Hz through two storm seasons. Wave height decays roughly exponentially with distance through vegetation, so for each transect I will fit

$$
H(x) = H_0 \\, e^{-k x}
$$

where $H_0$ is the incident wave height and $k$ is an attenuation coefficient. Comparing $k$ across sites and seasons is the core of the analysis.

| Site | Shoreline type | Marsh width | Sill | Built |
| --- | --- | --- | --- | --- |
| Pivers Island | Marsh + oyster sill | 18 m | Oyster shell bags | 2023 |
| Gallants Channel | Oyster reef sill | 6 m | Recycled shell | 2024 |
| Taylors Creek | Bulkhead (control) | None | Timber wall | 1998 |

![Modeled wave height across three shoreline types](/api/uploads/wavechart01.png){width=88%}

Figure 1. Preliminary model of wave height shoreward of each structure, using attenuation coefficients from pilot data. {align=center}

## Timeline

| Phase | Months | Deliverable |
| --- | --- | --- |
| Sensor deployment | Nov 2026 to Jan 2027 | Calibrated array at all three sites |
| Storm season one | Jun to Nov 2027 | First attenuation estimates |
| Storm season two | Jun to Nov 2028 | Seasonal comparison and model |
| Writing | Dec 2028 to Apr 2029 | Thesis and two manuscripts |

## Expected contribution

This work will produce the first multi-season record of wave attenuation at paired living and hardened shorelines in North Carolina, and a simple design guide that coastal managers can use when they permit new projects. {first-line=0.5}

## References

Gittman, R. K., Fodrie, F. J., Popowich, A. M., et al. (2015). Engineering away our natural defenses: an analysis of shoreline hardening in the US. *Frontiers in Ecology and the Environment*, 13(6), 301–307. {.bibliography}

Smith, C. S., Puckett, B., Gittman, R. K., & Peterson, C. H. (2018). Living shorelines enhanced the resilience of saltmarshes to Hurricane Matthew. *Ecological Applications*, 28(4), 871–877. {.bibliography}

Morris, R. L., Konlechner, T. M., Ghisalberti, M., & Swearer, S. E. (2018). From grey to green: Efficacy of eco-engineering solutions for nature-based coastal defence. *Global Change Biology*, 24(5), 1827–1842. {.bibliography}`;

const FIELD_NOTES = `# Field notes: Pivers Island

October 19, 2026. Low tide 9:42 a.m., wind SW 8 to 12 kt.

## Checklist

- [x] Swap batteries on sensors P1 to P4
- [x] Photograph quadrats Q1 to Q6
- [x] Measure sill crest height at three stations
- [ ] Re-anchor P3, it shifted about 20 cm
- [ ] Upload pressure logs to the lab drive

## Observations

Spartina is filling in behind the sill much faster than last fall. Shoot density in Q2 is roughly double what we counted in April. Oyster recruitment on the shell bags looks strong on the seaward face, weaker on the crest.

A boat wake at 11:05 gave a clean test: visible wave height dropped from about 30 cm at the sill to almost nothing by the marsh edge.

## Questions for Dr. Alvarez

- Should Q5 be dropped? It sits in a drainage creek and floods on every tide.
- Is 4 Hz enough sampling for boat wakes, or should P1 run at 8 Hz?`;

const LIT_REVIEW = `# Literature review

Working notes for chapter 2 {.subtitle}

## Shoreline hardening

The scale of hardening is larger than most people assume. Gittman et al. estimate that 14 percent of the US coast is armored, and that at current rates a third of the southeast coast could be hardened by 2100 <cite>(Gittman et al., 2015)</cite>. {first-line=0.5}

## Nature-based defenses

Morris et al. review 72 studies and find that vegetated shorelines reduce wave height by 30 to 70 percent over the first 20 m, with the largest effects in dense, mature marsh <cite>(Morris et al., 2018)</cite>. Most of the studies they review, however, measure a single season. {first-line=0.5}

## The gap

No study I have found follows the same living shoreline through several growing seasons with paired controls. That is the gap this thesis fills. {first-line=0.5}`;

const LAUNCH = `# Launch plan: Sync 2.0 {.title}

Product marketing · Owner: Jordan Lee · Updated October 24, 2026 {.subtitle}

## Problem

Teams who write together in Sync lose track of who changed what once a document passes ten collaborators. Support tickets about "lost edits" doubled this quarter, and two enterprise renewals named it as a blocker.

## Proposed solution

Sync 2.0 ships a review mode: every edit is a suggestion until its owner accepts it, with a per-paragraph history and one-click restore.

## Goals

- Cut "lost edit" tickets by 50 percent within 60 days of launch
- Convert 25 percent of active teams to review mode in the first month
- Close both blocked enterprise renewals before the end of Q4

## Timeline

| Milestone | Date | Owner |
| --- | --- | --- |
| Beta to 40 design partners | Nov 3 | Priya |
| Pricing and packaging final | Nov 10 | Jordan |
| Launch blog and docs | Nov 17 | Sam |
| General availability | Nov 19 | Everyone |

## Risks

- **Performance on large documents.** Review mode adds a history layer. Mitigation: load history lazily, per paragraph.
- **Change fatigue.** Existing teams may not want suggestions by default. Mitigation: make it opt in per workspace for the first release.

## Budget

| Item | Cost |
| --- | --- |
| Launch video and design | $18,000 |
| Paid social, 4 weeks | $25,000 |
| Customer events | $9,500 |
| **Total** | **$52,500** |`;

const SYNC = `# Weekly sync: October 21

Attendees: Jordan, Priya, Sam, Dev

## Agenda

1. Beta feedback from design partners
2. Launch date
3. Docs status

## Notes

Priya shared beta feedback: 31 of 40 partners are active, and the most requested change is a keyboard shortcut to accept a suggestion. Dev thinks it is a one-day change.

We agreed to keep November 19 as the launch date. Sam has drafts of four of the six docs pages.

## Decisions

- Ship with **Cmd+Enter** to accept a suggestion
- Review mode stays opt in for the first release

## Action items

- [ ] Dev: accept shortcut, by Oct 28
- [ ] Sam: last two docs pages, by Nov 4
- [x] Priya: send beta survey
- [ ] Jordan: pricing page copy, by Oct 31`;

const INVESTOR = `October update

Hi everyone,

October was our strongest month yet. Revenue grew 18 percent to $142,000 MRR, and net retention reached 121 percent. We closed two new enterprise customers and the Sync 2.0 beta is in the hands of 40 teams.

**Highlights**

- 18 percent month over month revenue growth
- Sync 2.0 beta: 31 of 40 design partners active weekly
- Hired our first solutions engineer

**Challenges**

Sales cycles for enterprise deals are running about three weeks longer than we planned. We are adding a security review packet to shorten them.

**Asks**

Introductions to heads of operations at mid-size legal and consulting firms would help most right now.

Thank you for your support,

Jordan`;

const PSET = `# STAT 512: Problem Set 6 {.title}

Jordan Lee · Due October 30, 2026 {.subtitle}

## Problem 1

Let $X_1, \\dots, X_n$ be independent draws from $\\mathcal{N}(\\mu, \\sigma^2)$. Show that the sample mean is unbiased and find its variance.

**Solution.** By linearity of expectation,

$$
\\mathbb{E}[\\bar{X}] = \\frac{1}{n}\\sum_{i=1}^{n} \\mathbb{E}[X_i] = \\mu
$$

and since the draws are independent,

$$
\\operatorname{Var}(\\bar{X}) = \\frac{1}{n^2}\\sum_{i=1}^{n} \\operatorname{Var}(X_i) = \\frac{\\sigma^2}{n}
$$

## Problem 2

Find the maximum likelihood estimator of $\\lambda$ for a Poisson sample.

**Solution.** The log-likelihood is

$$
\\ell(\\lambda) = \\sum_{i=1}^{n} \\left( x_i \\log \\lambda - \\lambda - \\log x_i! \\right)
$$

Setting $\\ell'(\\lambda) = \\frac{1}{\\lambda}\\sum x_i - n = 0$ gives $\\hat{\\lambda} = \\bar{x}$.

## Problem 3

A 95 percent confidence interval for $\\mu$ with known $\\sigma$ is

$$
\\bar{x} \\pm z_{0.975} \\frac{\\sigma}{\\sqrt{n}}
$$

With $\\bar{x} = 12.4$, $\\sigma = 3$ and $n = 36$, the interval is $12.4 \\pm 0.98$, or $(11.42, 13.38)$.`;

const ESSAY = `Jordan Lee

Professor Okafor

ENGL 214: Writing in the Digital Age

20 October 2026

The Ethics of Attention {align=center}

We tend to think of attention as something we pay, as if it were a currency we control. But the platforms that compete for it are designed by people who understand it better than we do, and they are not neutral. This essay argues that the design of attention-seeking technology is an ethical question, not merely a commercial one, and that writers have a particular responsibility to resist it. {first-line=0.5}

Consider the infinite feed. It removes the natural stopping points that once ended a reading session: the bottom of the page, the last article in the paper. As Tristan Harris has argued, the absence of a stopping cue is itself a design decision (Harris 12). When a reader cannot tell where an essay ends and the next distraction begins, the writer loses the reader's full attention before the argument is complete. {first-line=0.5}

Writers are not innocent here. Headlines written to provoke, paragraphs broken into single sentences for scrolling, and conclusions that tease the next post all borrow the logic of the feed. The alternative is not to write longer, but to write with an ending in mind, to give the reader a reason to stop and think. {first-line=0.5}

\\pagebreak

Works Cited {align=center}

Harris, Tristan. "How Technology Hijacks People's Minds." *Thrive Global*, 18 May 2016. {hanging=0.5}

Wu, Tim. *The Attention Merchants*. Knopf, 2016. {hanging=0.5}`;

const COVER = `October 24, 2026

Selection Committee

Ocean Futures Fellowship

1200 Harbor Way

Woods Hole, MA 02543

Dear Members of the Selection Committee,

I am writing to apply for the 2027 Ocean Futures Fellowship. I am a second-year master's student at Duke University's Nicholas School of the Environment, where I study how living shorelines protect coastal communities from storms.

Over the past year I have built and maintained a network of pressure sensors at three sites in Carteret County, and I have trained six undergraduates to run field surveys. The fellowship would let me extend that record through a second storm season, which is the difference between a promising pilot and evidence that coastal managers can act on.

Before graduate school I spent three years in product marketing at a software company, and I learned there how to explain technical work to people who have to make decisions with it. I would bring that skill to the fellowship's public engagement program.

Thank you for your consideration. I would welcome the chance to discuss my work.

Sincerely,

Jordan Lee`;

const RESUME = `# Jordan Lee {align=center}

Beaufort, NC · jordan.lee@example.com · (555) 014-2290 {align=center}

## Education

**Duke University**, M.E.M. Coastal Environmental Management · 2025 to 2027

**University of North Carolina**, B.S. Environmental Science · 2018 to 2022

## Experience

**Graduate Research Assistant**, Duke Marine Lab · 2025 to present

- Designed a 12-sensor wave monitoring array across three living shoreline sites
- Trained and supervised six undergraduate field technicians

**Product Marketing Manager**, Sync · 2022 to 2025

- Led launches for four major releases, growing trial sign-ups 40 percent
- Wrote the company's first public documentation site

## Skills

Python, R, field instrumentation, technical writing, public speaking`;

const READING = `# Reading list 2026

## Finished

- [x] *The Overstory*, Richard Powers
- [x] *Braiding Sweetgrass*, Robin Wall Kimmerer
- [x] *The Attention Merchants*, Tim Wu

## Reading now

- [ ] *Rising*, Elizabeth Rush
- [ ] *Four Thousand Weeks*, Oliver Burkeman

## Next

- [ ] *The Water Will Come*, Jeff Goodell
- [ ] *On Writing Well*, William Zinsser`;

const GUIDE_HTML = `<Canvas>
<Section id="cover" class="cover" pagination="keep-together">
<Text class="label">FIELD GUIDE / PIVERS ISLAND</Text>
<Text as="h1">Reading the marsh</Text>
<Text class="lead">How a living shoreline turns a storm wave into a ripple, and what to look for on your next visit.</Text>
</Section>
<Columns id="zones" ratio="1:1:1" pagination="keep-together">
<Column class="zone"><Text class="label">01 / SILL</Text><Text as="h2">Break the wave</Text><Text>Oyster shell bags trip incoming waves and start the energy loss before water reaches the plants.</Text></Column>
<Column class="zone"><Text class="label">02 / MARSH</Text><Text as="h2">Slow the water</Text><Text>Dense Spartina stems add drag. Most attenuation happens in the first ten meters.</Text></Column>
<Column class="zone"><Text class="label">03 / SHORE</Text><Text as="h2">Hold the ground</Text><Text>Roots bind sediment, so the bank builds up instead of washing out.</Text></Column>
</Columns>
<Section id="math" class="mathbox" pagination="keep-together">
<Text class="label">THE ONE EQUATION</Text>
<Math display>H(x) = H_0 \\, e^{-kx}</Math>
<Text class="small">Wave height falls off exponentially with distance through the marsh. A bigger k means better protection.</Text>
</Section>
<Section id="notes">
<Text as="h2">What to record</Text>
<Table><tr><th>Measure</th><th>Where</th><th>How often</th></tr><tr><td>Shoot density</td><td>Quadrats Q1 to Q6</td><td>Monthly</td></tr><tr><td>Sill crest height</td><td>Three stations</td><td>Each season</td></tr><tr><td>Wave pressure</td><td>Sensors P1 to P4</td><td>Continuous, 4 Hz</td></tr></Table>
</Section>
</Canvas>`;

const GUIDE_CSS = `Canvas { color: #1f3b34; font-family: Georgia; font-size: 11.5pt; line-height: 1.55; } .cover { background: linear-gradient(135deg, #e3efe8, #f6efe1); padding: 32px; border-top: 6px solid #2f6f5e; margin-bottom: 26px; } h1 { font-size: 40pt; line-height: 1.05; margin: 14px 0 12px; color: #173a31; } h2 { font-size: 17pt; margin: 6px 0; color: #173a31; } .label { color: #b0562f; font-size: 8.5pt; letter-spacing: 1.5px; font-family: Arial; font-weight: 700; } .lead { font-size: 15pt; color: #3d5a52; } Columns { gap: 16px; margin-bottom: 26px; } .zone { padding: 16px; border: 1px solid #cfe0d7; background-color: #f7fbf8; } .mathbox { padding: 20px 24px; background-color: #fbf3ea; border-left: 4px solid #b0562f; margin-bottom: 24px; } .small { font-size: 10pt; color: #5b6f69; } th { background-color: #2f6f5e; color: #ffffff; font-family: Arial; font-size: 9.5pt; } td { font-size: 10.5pt; }`;

async function main() {
  const hub = documentHub();
  await saveUpload("wavechart01", "png", fs.readFileSync(path.join(__dirname, "..", "seed", "wave-chart.png")));

  const thesis = await createFolder({ name: "Thesis", color: "teal" });
  const work = await createFolder({ name: "Work", color: "clay" });
  const classes = await createFolder({ name: "Classes", color: "blue" });
  const personal = await createFolder({ name: "Personal", color: "violet" });

  const docs: { title: string; md: string; folder: string | null; settings?: unknown }[] = [
    { title: "Reading list 2026", md: READING, folder: null },
    { title: "Resume", md: RESUME, folder: personal.id, settings: { fontFamily: INTER, fontSize: 10.5, lineSpacing: 1.1, paragraphSpacing: 4, pageSetup: { margins: { top: 0.6, right: 0.7, bottom: 0.6, left: 0.7 } } } },
    { title: "Cover letter: Ocean Futures Fellowship", md: COVER, folder: personal.id, settings: { fontFamily: GEORGIA, fontSize: 11.5, lineSpacing: 1.2, paragraphSpacing: 10 } },
    { title: "The Ethics of Attention", md: ESSAY, folder: classes.id, settings: { fontFamily: TIMES, fontSize: 12, lineSpacing: 2, paragraphSpacing: 0, headerFooter: { header: "Lee {page}", headerAlign: "right" } } },
    { title: "STAT 512: Problem Set 6", md: PSET, folder: classes.id, settings: { fontFamily: GARAMOND, fontSize: 12, lineSpacing: 1.2, paragraphSpacing: 8, pageNumbers: { enabled: true, position: "footer", align: "center" } } },
    { title: "October investor update", md: INVESTOR, folder: work.id, settings: { fontFamily: INTER, fontSize: 11, lineSpacing: 1.3 } },
    { title: "Weekly sync: October 21", md: SYNC, folder: work.id, settings: { fontFamily: INTER } },
    { title: "Launch plan: Sync 2.0", md: LAUNCH, folder: work.id, settings: { fontFamily: INTER, fontSize: 11, lineSpacing: 1.2, headerFooter: { header: "Sync 2.0 · Confidential", headerAlign: "right" } } },
    { title: "Literature review", md: LIT_REVIEW, folder: thesis.id, settings: { fontFamily: GEORGIA, fontSize: 11.5, lineSpacing: 1.5 } },
    { title: "Field notes: Pivers Island", md: FIELD_NOTES, folder: thesis.id, settings: { fontFamily: INTER } },
  ];
  const created: Record<string, string> = {};
  for (const d of docs) {
    const live = await hub.create({ title: d.title, markdown: d.md, folderId: d.folder, settings: d.settings });
    created[d.title] = live.id;
  }

  // A designed Canvas from the built-in field guide example.
  const canvas = compileCanvas(GUIDE_HTML, GUIDE_CSS);
  const canvasDoc = await hub.create({ title: "Field guide: Reading the marsh", doc: canvas.toJSON(), folderId: thesis.id });
  created.canvas = canvasDoc.id;

  // The thesis is the hero document: comments from an advisor, and a saved version.
  const th = await hub.create({
    title: "Living Shorelines Thesis Proposal",
    markdown: THESIS,
    folderId: thesis.id,
    settings: { fontFamily: GEORGIA, fontSize: 11.5, lineSpacing: 1.45, paragraphSpacing: 8, headerFooter: { header: "Thesis proposal · Jordan Lee", headerAlign: "left", footer: "{page}", footerAlign: "right", differentFirstPage: true } },
  });
  created.thesis = th.id;
  await th.saveVersion("First full draft", "user");
  const origin = { kind: "system" as const, label: "Seeded comment" };
  const comment = (text: string, body: string, occurrence = 1) => th.addComment({ ...find(th.doc, text, occurrence), body, author: "user" }, origin);
  comment("it has become increasingly important to understand", "Way too wordy. Can this sentence be half as long?");
  comment("significantly less damage", "Significantly by what measure? Add the number from the paper.");
  comment("Expected contribution", "Add one sentence on who will use the design guide.");

  // Launch plan: one comment from a teammate.
  const lp = (await hub.get(created["Launch plan: Sync 2.0"]))!;
  lp.addComment({ ...find(lp.doc, "Cut \"lost edit\" tickets by 50 percent"), body: "Priya: is 50% realistic in 60 days? Support thinks 35%.", author: "user" }, origin);

  for (const id of Object.values(created)) await (await hub.get(id))!.flush();
  fs.writeFileSync(path.join(process.env.INLINE_DATA_DIR!, "demo-ids.json"), JSON.stringify(created, null, 2));
  console.log(created);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
