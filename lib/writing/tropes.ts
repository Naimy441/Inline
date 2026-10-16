import { cleanAiTellText, findAiSymbols, stripInvisible } from "@/lib/writing/aiTells";

export type TropeHit = {
  id: string;
  kind: "emdash" | "phrase" | "watermark" | "structure" | "bullet" | "symbol";
  title: string;
  find: string;
  replace?: string;
};

const PHRASES: Array<{ pattern: RegExp; title: string; replace?: string }> = [
  { pattern: /\bdelve(?:s|d)? into\b/gi, title: "AI verb: delve into", replace: "look at" },
  { pattern: /\ba tapestry of\b/gi, title: "AI metaphor: tapestry", replace: "a mix of" },
  { pattern: /\bin the realm of\b/gi, title: "AI filler: in the realm of", replace: "in" },
  { pattern: /\bit['’]s important to note that\b/gi, title: "AI hedge", replace: "" },
  { pattern: /\bit is important to note that\b/gi, title: "AI hedge", replace: "" },
  { pattern: /\bin today['’]s (?:fast-paced |digital |modern )?(?:world|society|landscape)\b/gi, title: "AI opener" },
  { pattern: /\bplay(?:s)? a crucial role\b/gi, title: "AI cliché: crucial role" },
  { pattern: /\ba testament to\b/gi, title: "AI cliché: testament" },
  { pattern: /\bunderscore(?:s|d)?\b/gi, title: "AI verb: underscore", replace: "show" },
  { pattern: /\bmultifaceted\b/gi, title: "AI adjective: multifaceted", replace: "complex" },
  { pattern: /\bever-evolving\b/gi, title: "AI adjective: ever-evolving", replace: "changing" },
  { pattern: /\bshed light on\b/gi, title: "AI idiom: shed light", replace: "explain" },
  { pattern: /\bat the end of the day\b/gi, title: "AI filler", replace: "finally" },
  { pattern: /\bgame-?changer\b/gi, title: "AI hype: game-changer" },
  { pattern: /\bin conclusion,?\s/gi, title: "AI closer: in conclusion" },
  { pattern: /\bnot only\b[\s\S]{0,80}\bbut also\b/gi, title: "AI cadence: not only / but also" },
  { pattern: /\bas an ai(?: language model)?(?:,)?\s*/gi, title: "Model disclaimer", replace: "" },
  { pattern: /\bi['’]d be happy to\b/gi, title: "Assistant leftover", replace: "I can" },
  { pattern: /\bleverage\b/gi, title: "Corporate AI verb: leverage", replace: "use" },
  { pattern: /\bunlock(?:s|ing)? the potential\b/gi, title: "AI hype: unlock potential" },
];

export function detectAiTropes(text: string): TropeHit[] {
  const hits: TropeHit[] = [];
  for (const symbol of findAiSymbols(text)) {
    hits.push({
      id: symbol.kind,
      kind: symbol.kind === "emdash" ? "emdash" : symbol.kind === "bullet" ? "bullet" : "symbol",
      title: symbol.title,
      find: symbol.kind === "emdash" ? "—" : symbol.find,
      replace: symbol.replace,
    });
  }
  // Invisible junk is a watermark. Script joiners and real line breaks are not.
  if (stripInvisible(text).removed > 0) {
    hits.push({
      id: "watermark",
      kind: "watermark",
      title: "Hidden AI tokens / watermarks",
      find: "",
    });
  }
  let index = 0;
  for (const item of PHRASES) {
    item.pattern.lastIndex = 0;
    const match = item.pattern.exec(text);
    if (!match) continue;
    hits.push({
      id: `phrase-${index}`,
      kind: item.title.includes("cadence") ? "structure" : "phrase",
      title: item.title,
      find: match[0],
      replace: item.replace,
    });
    index += 1;
  }
  return hits;
}

export function cleanAiArtifacts(text: string) {
  let next = cleanAiTellText(text).text;
  next = next.replace(/\bas an ai(?: language model)?(?:,)?\s*/gi, "");
  next = next.replace(/\bit['’]s important to note that\s*/gi, "");
  next = next.replace(/\bit is important to note that\s*/gi, "");
  return next.replace(/[ \t]{2,}/g, " ");
}

export function summarizeTropes(hits: TropeHit[]) {
  if (!hits.length) return "No common AI tropes or hidden tokens found.";
  return hits.map((hit) => hit.title).join("; ");
}
