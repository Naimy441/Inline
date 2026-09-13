export type PromptTemplate = {
  id: string;
  label: string;
  group: "email" | "letter" | "essay" | "fiction" | "nonfiction" | "school";
  hint: string;
  prompt: string;
  skeleton?: string;
};

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: "email",
    label: "Email",
    group: "email",
    hint: "Clear, scannable, one ask",
    prompt:
      "Turn this into a concise professional email: subject-ready opening, short paragraphs, one clear ask, and a polite close. Preserve facts and names.",
    skeleton: "<div>Hi [Name],</div><div><br></div><div>I'm writing because [reason].</div><div><br></div><div>Could you [ask] by [date]?</div><div><br></div><div>Thanks,<br>[You]</div>",
  },
  {
    id: "follow-up",
    label: "Follow-up email",
    group: "email",
    hint: "Polite nudge",
    prompt: "Write a short follow-up email that reminds without pressure. Keep the original request and add a new, easy next step.",
  },
  {
    id: "business-letter",
    label: "Business letter",
    group: "letter",
    hint: "Formal block letter",
    prompt:
      "Rewrite this as a formal business letter: sender block, date, recipient, salutation, purpose paragraph, supporting paragraph, closing, and signature. Keep a reserved tone.",
    skeleton:
      "<div>[Your name]<br>[Address]</div><div><br></div><div>[Date]</div><div><br></div><div>[Recipient]<br>[Company]</div><div><br></div><div>Dear [Name],</div><div><br></div><div>I am writing to [purpose].</div><div><br></div><div>Sincerely,<br>[Your name]</div>",
  },
  {
    id: "essay",
    label: "Essay",
    group: "essay",
    hint: "Thesis and argument",
    prompt:
      "Shape this into an essay with a thesis, topic sentences, evidence, and a closing that does not say 'in conclusion'. Keep the author's voice.",
    skeleton: "<h1>Title</h1><div>Thesis: [claim].</div><div><br></div><div>[Body paragraph 1]</div><div><br></div><div>[Body paragraph 2]</div><div><br></div><div>[Closing]</div>",
  },
  {
    id: "mla",
    label: "MLA report",
    group: "school",
    hint: "School paper",
    prompt:
      "Format this as an MLA-style report: heading, centered title, double-spaced body, in-text citations where sources exist, and a Works Cited section. Do not invent sources.",
  },
  {
    id: "fiction",
    label: "Fiction scene",
    group: "fiction",
    hint: "Scene, not summary",
    prompt:
      "Develop this as fiction: concrete sensory detail, character action, and dialogue. Avoid summarizing feelings. Stay in the current tense/person.",
    skeleton: "<div>The room held its breath.</div><div><br></div><div>\"[Line],\" [Name] said.</div>",
  },
  {
    id: "nonfiction",
    label: "Nonfiction",
    group: "nonfiction",
    hint: "Reported explainer",
    prompt:
      "Turn this into clear nonfiction: lede, context, one or two specific examples, and a close that leaves the reader with a fact rather than a slogan.",
  },
  {
    id: "resume",
    label: "Resume",
    group: "letter",
    hint: "Bullet impact",
    prompt:
      "Rewrite experience bullets so each starts with a strong verb, includes a result, and stays under two lines. Do not invent metrics.",
  },
];

export function templateById(id: string) {
  return PROMPT_TEMPLATES.find((item) => item.id === id);
}

export const QUICK_PROMPTS = [
  { id: "grammar", label: "Fix grammar", prompt: "Fix grammar, spelling, and formatting only. Do not change meaning, voice, or structure except where required for correctness. Preserve existing tone." },
  { id: "tropes", label: "Clean AI writing", prompt: "Remove AI tropes, em-dash habits, stock transitions, and hidden watermarks. Keep meaning. Prefer plain, human sentences." },
  { id: "summarize", label: "Summarize", prompt: "Summarize the document in 5 bullets, then list the three best ways to improve it." },
  { id: "tone", label: "Suggest tone", prompt: "Diagnose the current tone. Propose three style directions (with a 2-sentence sample of each) and recommend one." },
  { id: "ideate", label: "Ideate", prompt: "Ask nothing extra. Ideate 8 concrete improvements to this draft, grouped as structure, evidence, and voice." },
  { id: "cite", label: "Bibliography", prompt: "Generate inline citations and a bibliography only from the attached sources or the citation catalog. Do not invent works." },
] as const;
