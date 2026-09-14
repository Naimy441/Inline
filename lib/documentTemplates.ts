import { createPageLayout, type PageLayout } from "@/lib/pagination";
import type { HeaderAlign, PageNumberLocation } from "@/lib/documentStore";

export type DocumentTemplate = {
  id: string;
  title: string;
  description: string;
  html: string;
  headerText: string;
  footerText: string;
  showHeader: boolean;
  showFooter: boolean;
  showPageNumbers: boolean;
  pageNumberLocation: PageNumberLocation;
  headerAlign: HeaderAlign;
  footerAlign: HeaderAlign;
  lineSpacing: string;
  fontFamily: string;
  fontSize: string;
  pageLayout: PageLayout;
  preview: TemplatePreview;
};

export type TemplatePreview = {
  header?: string;
  footer?: string;
  pageInHeader?: boolean;
  pageInFooter?: boolean;
  align?: HeaderAlign;
  font?: "sans" | "serif";
  lines: Array<{ text: string; tone?: "title" | "heading" | "muted" | "body" | "center" | "plus" }>;
};

const RESUME_MARGINS = {
  marginTop: 48,
  marginRight: 54,
  marginBottom: 48,
  marginLeft: 54,
};

function formatLongDate(now: Date) {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
}

export function documentTemplates(now = new Date()): DocumentTemplate[] {
  const mlaDate = formatLongDate(now);
  const letterDate = formatLongDate(now);

  return [
    {
      id: "blank",
      title: "Blank document",
      description: "A clean letter page",
      html: "<div><br></div>",
      headerText: "",
      footerText: "",
      showHeader: false,
      showFooter: false,
      showPageNumbers: false,
      pageNumberLocation: "footer",
      headerAlign: "center",
      footerAlign: "center",
      lineSpacing: "1.15",
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "11pt",
      pageLayout: createPageLayout("letter"),
      preview: {
        font: "sans",
        lines: [{ text: "+", tone: "plus" }],
      },
    },
    {
      id: "resume",
      title: "Resume",
      description: "One page, tight margins, contact footer",
      html: resumeHtml(),
      headerText: "",
      footerText: "you@email.com  ·  (555) 555-0100",
      showHeader: false,
      showFooter: true,
      showPageNumbers: false,
      pageNumberLocation: "footer",
      headerAlign: "center",
      footerAlign: "center",
      lineSpacing: "1.15",
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "11pt",
      pageLayout: createPageLayout("letter", RESUME_MARGINS),
      preview: {
        footer: "you@email.com  ·  (555) 555-0100",
        font: "sans",
        lines: [
          { text: "Your Name", tone: "title" },
          { text: "Role · City", tone: "muted" },
          { text: "Experience", tone: "heading" },
          { text: "Company — Role", tone: "body" },
          { text: "Education", tone: "heading" },
        ],
      },
    },
    {
      id: "mla",
      title: "MLA report",
      description: "Times, double-spaced, last name + page",
      html: mlaHtml(mlaDate),
      headerText: "Last Name",
      footerText: "",
      showHeader: true,
      showFooter: false,
      showPageNumbers: true,
      pageNumberLocation: "header",
      headerAlign: "right",
      footerAlign: "center",
      lineSpacing: "2",
      fontFamily: '"Times New Roman", Times, serif',
      fontSize: "12pt",
      pageLayout: createPageLayout("letter"),
      preview: {
        header: "Last Name",
        pageInHeader: true,
        align: "right",
        font: "serif",
        lines: [
          { text: "Your Name", tone: "body" },
          { text: "Instructor Name", tone: "body" },
          { text: "Course Title", tone: "body" },
          { text: "Paper Title", tone: "center" },
          { text: "The opening paragraph begins here…", tone: "body" },
        ],
      },
    },
    {
      id: "letter",
      title: "Business letter",
      description: "Letterhead, block format, page numbers",
      html: letterHtml(letterDate),
      headerText: "Your Name",
      footerText: "",
      showHeader: true,
      showFooter: true,
      showPageNumbers: true,
      pageNumberLocation: "footer",
      headerAlign: "center",
      footerAlign: "center",
      lineSpacing: "1.15",
      fontFamily: '"Times New Roman", Times, serif',
      fontSize: "12pt",
      pageLayout: createPageLayout("letter"),
      preview: {
        header: "Your Name",
        pageInFooter: true,
        align: "center",
        font: "serif",
        lines: [
          { text: letterDate, tone: "muted" },
          { text: "Dear Name,", tone: "body" },
          { text: "I am writing to…", tone: "body" },
          { text: "Sincerely,", tone: "body" },
        ],
      },
    },
  ];
}

export function documentTemplateById(id: string, now = new Date()) {
  return documentTemplates(now).find((template) => template.id === id) ?? null;
}

function resumeHtml() {
  return [
    `<div class="resume-name">Your Name</div>`,
    `<div class="resume-contact">City, Country  ·  you@email.com  ·  (555) 555-0100</div>`,
    `<div class="resume-heading">Summary</div>`,
    `<div>Replace this with two sentences on the work you want to be hired for. Keep it specific and current.</div>`,
    `<div class="resume-heading">Experience</div>`,
    `<div><strong>Company Name</strong> — Role</div>`,
    `<div class="resume-meta">City  ·  2022–Present</div>`,
    `<ul><li>Shipped a project that improved [result] for [audience].</li><li>Led [team or craft] and set the standard for [work].</li><li>Wrote, designed, or launched [thing] now used by [who].</li></ul>`,
    `<div><strong>Previous Company</strong> — Role</div>`,
    `<div class="resume-meta">City  ·  2020–2022</div>`,
    `<ul><li>Owned [area] from first draft to launch.</li><li>Partnered with [team] to deliver [outcome].</li></ul>`,
    `<div class="resume-heading">Education</div>`,
    `<div><strong>University Name</strong> — Degree</div>`,
    `<div class="resume-meta">City  ·  2020</div>`,
    `<div class="resume-heading">Skills</div>`,
    `<div>Writing  ·  Research  ·  Design systems  ·  Figma  ·  HTML/CSS</div>`,
  ].join("");
}

function mlaHtml(date: string) {
  return [
    `<div>Your Name</div>`,
    `<div>Instructor Name</div>`,
    `<div>Course Title</div>`,
    `<div>${date}</div>`,
    `<div class="mla-title">Paper Title</div>`,
    `<div class="mla-indent">The opening paragraph states the claim in plain language and names the text or question you are answering. Keep Times New Roman, 12 point, and double spacing as you write.</div>`,
    `<div class="mla-indent">The next paragraph develops one idea with evidence. When you quote or paraphrase a source, add an in-text citation (Author 12) and list the full work on the Works Cited page.</div>`,
    `<div class="mla-works">Works Cited</div>`,
    `<div class="mla-hanging">Author, First. “Title of Source.” <em>Title of Container</em>, Publisher, Day Month Year, URL.</div>`,
  ].join("");
}

function letterHtml(date: string) {
  return [
    `<div>${date}</div>`,
    `<div><br></div>`,
    `<div>Recipient Name</div>`,
    `<div>Title</div>`,
    `<div>Company Name</div>`,
    `<div>123 Address Street</div>`,
    `<div>City, State 00000</div>`,
    `<div><br></div>`,
    `<div>Dear Recipient Name,</div>`,
    `<div><br></div>`,
    `<div>I am writing to [state the purpose in one sentence]. The next paragraph can add the necessary context, dates, or request.</div>`,
    `<div><br></div>`,
    `<div>Please let me know if you would like any further information. I would be glad to follow up by [date].</div>`,
    `<div><br></div>`,
    `<div>Sincerely,</div>`,
    `<div><br></div>`,
    `<div><br></div>`,
    `<div>Your Name</div>`,
    `<div>Title</div>`,
  ].join("");
}
