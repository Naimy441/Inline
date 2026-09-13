export type DocParagraph = {
  id: string;
  text: string;
};

export function splitPlainParagraphs(text: string) {
  return text
    .split(/\n+/)
    .map((part) => part.replace(/\u00a0/g, " ").trim())
    .filter(Boolean);
}

export function labelDocument(text: string) {
  const paragraphs = splitPlainParagraphs(text).map((item, index) => ({
    id: `P${index + 1}`,
    text: item,
  }));
  return {
    paragraphs,
    labeled: paragraphs.map((item) => `[${item.id}] ${item.text}`).join("\n\n"),
  };
}

export function stripAnchor(find: string) {
  return find
    .replace(/\u00a0/g, " ")
    .replace(/\[P\d+\]\s*/gi, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|—|–|\d+[.)])\s+/, "").replace(/^["'“”]+|["'“”]+$/g, "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function locateInText(document: string, find: string): { start: number; end: number } | null {
  const needle = stripAnchor(find);
  if (!needle.trim()) return null;
  const exact = document.indexOf(needle);
  if (exact >= 0) return { start: exact, end: exact + needle.length };

  const compact = compactMap(document);
  const compactNeedle = needle.replace(/\s+/g, "");
  if (compactNeedle) {
    let at = compact.text.indexOf(compactNeedle);
    if (at < 0) at = compact.text.toLowerCase().indexOf(compactNeedle.toLowerCase());
    const start = compact.map[at];
    const end = compact.map[at + compactNeedle.length - 1];
    if (at >= 0 && start != null && end != null) return { start, end: end + 1 };
  }

  const paragraphs = splitPlainParagraphs(document);
  const want = normalize(needle);
  if (!want) return null;
  const matches = paragraphs.filter((paragraph) => {
    const have = normalize(paragraph);
    return have === want || have.includes(want) || (want.length > 48 && want.includes(have));
  });
  if (matches.length === 1) {
    const at = document.indexOf(matches[0]);
    if (at >= 0) return { start: at, end: at + matches[0].length };
  }

  if (want.length >= 40) {
    const prefix = want.slice(0, 48);
    const prefixed = paragraphs.filter((paragraph) => normalize(paragraph).includes(prefix));
    if (prefixed.length === 1) {
      const at = document.indexOf(prefixed[0]);
      if (at >= 0) return { start: at, end: at + prefixed[0].length };
    }
  }

  const findLines = splitPlainParagraphs(needle).map(normalize).filter(Boolean);
  if (findLines.length > 1) {
    for (let index = 0; index <= paragraphs.length - findLines.length; index += 1) {
      const slice = paragraphs.slice(index, index + findLines.length).map(normalize);
      const matched = slice.every(
        (have, line) => have === findLines[line] || have.includes(findLines[line]) || findLines[line].includes(have),
      );
      if (!matched) continue;
      const first = paragraphs[index];
      const last = paragraphs[index + findLines.length - 1];
      const start = document.indexOf(first);
      const end = document.indexOf(last, start);
      if (start >= 0 && end >= 0) return { start, end: end + last.length };
    }
  }
  return null;
}

export function validateEdits(document: string, edits: Array<{ find: string; replace: string }>) {
  const missed = edits.filter((edit) => edit.find.trim() && !locateInText(document, edit.find));
  return { missed, ok: missed.length === 0 };
}

export function wantsListFormat(prompt: string) {
  return /\b(bullet(?:\s+points?)?|bulleted|unordered list|numbered list|checklist|as a list|into (?:a |an )?(?:list|bullets?)|make .* list)\b/i.test(
    prompt,
  );
}

export function replaceHasListMarkup(replace: string) {
  return /^\s*(?:[-*•]|—|–|\d+[.)])\s+\S/m.test(replace);
}

function compactMap(text: string) {
  let compact = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i])) continue;
    map.push(i);
    compact += text[i];
  }
  return { text: compact, map };
}

function normalize(value: string) {
  return value
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|—|–|\d+[.)])\s+/, "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
