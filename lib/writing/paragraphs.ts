/** Heading / Works Cited labels that must stay on their own editor line. */
export function isStandaloneHeadingLine(text: string) {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return false;
  return /^(works cited|references|bibliography|works consulted)\.?$/i.test(value);
}

/**
 * Models often hard-wrap prose as if they were filling a page.
 * Those single newlines should stay in the same paragraph; heading stacks
 * (Name / Instructor / Course / Date) still start with a capital and stay split.
 */
export function isSoftWrapContinuation(previous: string, next: string) {
  const prev = previous.replace(/\s+/g, " ").trim();
  const line = next.replace(/\s+/g, " ").trim();
  if (!prev || !line) return false;
  if (isStandaloneHeadingLine(prev) || isStandaloneHeadingLine(line)) return false;
  if (/^[-*•]\s/.test(line) || /^\d+[.)]\s/.test(line)) return false;
  if (/^[-*•]\s/.test(prev) && /^[-*•]\s/.test(line)) return false;
  if (/^https?:\/\//i.test(line) && !/[.!?]"?$/.test(prev)) return true;
  if (/[-–—,;:]$/.test(prev) && !isStandaloneHeadingLine(line)) return true;
  return /^[\s"'“‘(\[]*[a-z]/.test(line);
}

export function splitEditorParagraphs(text: string) {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, ""));

  const parts: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const trimmed = line.trim();
    const prev = parts[parts.length - 1];
    if (prev && isSoftWrapContinuation(prev, trimmed)) {
      parts[parts.length - 1] = `${prev.replace(/\s+$/g, "")} ${trimmed}`;
    } else {
      parts.push(trimmed);
    }
  }
  return parts.filter(Boolean);
}
