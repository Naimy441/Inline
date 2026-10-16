import type { DocumentSettings } from "@/lib/doc/settings";

/** Starting points offered on the home page. Content is Inline Markdown. */

export type DocumentTemplate = {
  id: string;
  title: string;
  description: string;
  documentTitle: string;
  markdown: string;
  settings?: Partial<Omit<DocumentSettings, "pageSetup" | "headerFooter" | "pageNumbers">> & {
    pageSetup?: Partial<DocumentSettings["pageSetup"]>;
    headerFooter?: Partial<DocumentSettings["headerFooter"]>;
    pageNumbers?: Partial<DocumentSettings["pageNumbers"]>;
  };
  /** A short prompt to start Claude with, shown as a suggestion. */
  suggestion?: string;
};

function longDate(now: Date) {
  return now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

const MLA_MONTHS = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];

/** MLA dates read day, month, year: 4 September 2026 (4 Sept. 2026 in Works Cited). */
function mlaDate(now: Date, short = false) {
  const month = short ? MLA_MONTHS[now.getMonth()] : now.toLocaleDateString("en-US", { month: "long" });
  return `${now.getDate()} ${month} ${now.getFullYear()}`;
}

const TIMES = "\"Times New Roman\", Times, serif";

export function documentTemplates(now = new Date()): DocumentTemplate[] {
  const date = longDate(now);
  return [
    {
      id: "blank",
      title: "Blank document",
      description: "Start from an empty page",
      documentTitle: "Untitled document",
      markdown: "",
    },
    {
      id: "essay",
      title: "Essay",
      description: "Title, introduction, body and conclusion",
      documentTitle: "Untitled essay",
      settings: { fontFamily: "Georgia, serif", fontSize: 12, lineSpacing: 1.5, paragraphSpacing: 6 },
      markdown: `# Essay title {.title}

A one-line summary of the argument {.subtitle}

## Introduction

Open with the question your essay answers and why it matters to the reader. Give only the background they need to follow you, then end the paragraph with your thesis in one clear sentence. {first-line=0.5}

## The first point

Make one claim per section and state it in the first sentence. Support it with evidence, a quotation, a figure or an example, then explain what the evidence shows and how it serves the thesis. {first-line=0.5}

## The second point

Build on the first point, or take on the strongest objection to your argument and show why the thesis still holds. {first-line=0.5}

## Conclusion

Return to the thesis in new words and say what follows from it: why it matters, or what question it opens next. Don't introduce new evidence here. {first-line=0.5}`,
      suggestion: "Help me develop this essay. Ask me what it's about first.",
    },
    {
      id: "mla",
      title: "MLA paper",
      description: "MLA 8 heading, page numbers and Works Cited",
      documentTitle: "MLA paper",
      settings: {
        fontFamily: TIMES,
        fontSize: 12,
        lineSpacing: 2,
        paragraphSpacing: 0,
        pageSetup: { margins: { top: 1, right: 1, bottom: 1, left: 1 } },
        headerFooter: { header: "Lastname {page}", headerAlign: "right" },
      },
      markdown: `Your Name

Professor Name

Subject Name

${mlaDate(now)}

Title of Your Paper {align=center}

Begin your introduction here. In MLA style the whole paper is double-spaced in 12-point Times New Roman with one-inch margins, and every paragraph starts half an inch in. Your last name and the page number sit in the top right of every page. End the introduction with your thesis. {first-line=0.5}

SECTION HEADER

*Subsection heading.* Use a run-in heading like this one when a section has parts. Support each claim with a source and cite it in parentheses with the author's last name and the page number, with no comma between them (Lastname 14). If the paper lists steps or ideas inline, number them in parentheses: (1) the first idea, (2) the second idea, (3) the third idea and (4) the fourth. {first-line=0.5}

*Another subsection.* When you name the author in the sentence, as Lastname does, the citation needs only the page number (27). Quotations longer than four lines are set as a block, indented half an inch, with no quotation marks. {first-line=0.5}

CONCLUSION

Bring the argument together. Restate the thesis in light of the evidence and say why it matters, without adding new sources. {first-line=0.5}

\\pagebreak

Works Cited {align=center}

Lastname, Firstname. *Title of the Book*. Publisher, 2020. {hanging=0.5}

Lastname, Firstname, and Firstname Lastname. "Title of the Article." *Name of the Journal*, vol. 12, no. 3, 2019, pp. 45–67. {hanging=0.5}

Organization Name. "Title of the Web Page." *Name of the Website*, ${mlaDate(now, true)}, www.example.com/page. {hanging=0.5}`,
      suggestion: "Help me write this MLA paper. Ask me for the topic and sources first.",
    },
    {
      id: "report",
      title: "Report",
      description: "Executive summary, findings and recommendations",
      documentTitle: "Untitled report",
      settings: { pageNumbers: { enabled: true, position: "footer", align: "right", skipFirst: true }, headerFooter: { header: "{title}", headerAlign: "left", differentFirstPage: true } },
      markdown: `# Report title {.title}

Prepared for [Audience] · ${date} {.subtitle}

## Executive summary

Two or three sentences that state what you found and what you recommend.

## Background

What prompted this report and what it covers.

## Findings

| Area | Finding | Impact |
| --- | --- | --- |
| [Area] | [What you found] | [High / Medium / Low] |
| [Area] | [What you found] | [High / Medium / Low] |

## Recommendations

1. [Recommendation, with owner and timing]
2. [Recommendation, with owner and timing]

## Next steps

- [ ] [Next step]
- [ ] [Next step]`,
    },
    {
      id: "letter",
      title: "Business letter",
      description: "Block format with date and signature",
      documentTitle: "Letter",
      settings: { fontFamily: "\"Times New Roman\", Times, serif", fontSize: 12 },
      markdown: `${date}

&nbsp;

Recipient Name<br>Title<br>Company Name<br>123 Address Street<br>City, State 00000

&nbsp;

Dear Recipient Name,

I am writing to [state the purpose in one sentence]. The next paragraph can add the context, dates or request that matter.

Please let me know if you would like any further information. I would be glad to follow up by [date].

Sincerely,

&nbsp;

Your Name<br>Title`,
    },
    {
      id: "resume",
      title: "Resume",
      description: "One page with tight margins",
      documentTitle: "Resume",
      settings: { fontSize: 10.5, lineSpacing: 1.1, paragraphSpacing: 4, pageSetup: { margins: { top: 0.6, right: 0.7, bottom: 0.6, left: 0.7 } } },
      markdown: `# Your Name {.title align=center}

City, Country · you@email.com · (555) 555-0100 · linkedin.com/in/you {align=center}

## Summary

Two sentences on the work you want to be hired for. Keep it specific and current.

## Experience

**Company Name** · Role · 2022–Present

- Shipped [project] that improved [result] for [audience].
- Led [team or craft] and set the standard for [work].

**Previous Company** · Role · 2020–2022

- Owned [area] from first draft to launch.
- Partnered with [team] to deliver [outcome].

## Education

**University Name** · Degree · 2020

## Skills

Writing · Research · Project management · [Tool] · [Tool]`,
      suggestion: "Tailor my resume to a job description I'll paste.",
    },
    {
      id: "meeting-notes",
      title: "Meeting notes",
      description: "Agenda, notes, decisions and action items",
      documentTitle: `Meeting notes ${now.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
      markdown: `# Meeting notes {.title}

${date} · Attendees: [Names] {.subtitle}

## Agenda

1. [Topic]
2. [Topic]

## Notes

- [Point discussed]

## Decisions

- [Decision]

## Action items

- [ ] [Owner]: [Task] by [date]`,
    },
    {
      id: "proposal",
      title: "Project proposal",
      description: "Problem, solution, scope, timeline and budget",
      documentTitle: "Project proposal",
      settings: { pageNumbers: { enabled: true, position: "footer", align: "center", skipFirst: false } },
      markdown: `# Project name {.title}

Proposal · ${date} {.subtitle}

## Problem

Who has the problem, how often, and what it costs them today.

## Proposed solution

What you'll build or change, and why this approach over the alternatives.

## Scope

**In scope:** [items]

**Out of scope:** [items]

## Timeline

| Milestone | Date |
| --- | --- |
| [Milestone] | [Date] |
| [Milestone] | [Date] |

## Budget

[Estimated cost and what it covers.]

## Risks

- [Risk and how you'll reduce it]`,
    },
    {
      id: "manuscript",
      title: "Manuscript",
      description: "Standard fiction format, double-spaced",
      documentTitle: "Untitled manuscript",
      settings: {
        fontFamily: "\"Times New Roman\", Times, serif",
        fontSize: 12,
        lineSpacing: 2,
        paragraphSpacing: 0,
        headerFooter: { header: "Surname / {title} / {page}", headerAlign: "right" },
      },
      markdown: `&nbsp;

&nbsp;

# Story Title {.title align=center}

by Your Name {align=center}

\\pagebreak

## Chapter One {align=center}

The first line of the story goes here. Manuscripts indent every paragraph half an inch and leave no space between them. {first-line=0.5}`,
      suggestion: "Help me outline the first chapter.",
    },
  ];
}
