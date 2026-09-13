export type RetrievedChunk = {
  id: string;
  text: string;
  score: number;
  index: number;
};

const DIM = 256;

export function chunkDocument(text: string, size = 900, overlap = 140): RetrievedChunk[] {
  const blocks = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const pieces: string[] = [];
  let current = "";
  for (const block of blocks) {
    if ((current + "\n\n" + block).length > size && current) {
      pieces.push(current);
      current = overlapText(current, overlap) + block;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }
  if (current) pieces.push(current);
  if (!pieces.length && text.trim()) pieces.push(text.trim().slice(0, size));
  return pieces.map((item, index) => ({
    id: `chunk-${index}`,
    text: item,
    score: 0,
    index,
  }));
}

export function embedText(text: string) {
  const vec = new Array<number>(DIM).fill(0);
  for (const token of tokenize(text)) {
    vec[hash(token) % DIM] += 1;
    vec[hash(`${token}#`) % DIM] += 0.45;
  }
  return normalize(vec);
}

export function retrieveChunks(document: string, query: string, limit = 6): RetrievedChunk[] {
  const chunks = chunkDocument(document);
  if (!chunks.length) return [];
  const qVec = embedText(query);
  const qTokens = new Set(tokenize(query));
  return chunks
    .map((chunk) => {
      const lexical = tokenize(chunk.text).reduce((score, token) => score + (qTokens.has(token) ? 1 : 0), 0);
      const cosine = dot(qVec, embedText(chunk.text));
      return { ...chunk, score: cosine * 2 + lexical * 0.15 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function documentOutline(text: string, max = 1800) {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headings = lines.filter((line) => line.length < 90 && /^(#{1,3}\s|[A-Z].{0,70})$/.test(line)).slice(0, 16);
  const opening = lines.slice(0, 4).join("\n");
  const outline = headings.length ? headings.join("\n") : opening;
  return outline.slice(0, max);
}

export function shouldRetrieve(document: string) {
  return document.trim().length > 12_000;
}

function tokenize(text: string) {
  return (text.toLowerCase().match(/[a-z0-9’']{2,}/g) ?? []).map((token) => token.replace(/^[’']|[’']$/g, ""));
}

function overlapText(text: string, overlap: number) {
  return text.slice(Math.max(0, text.length - overlap)).trimStart();
}

function hash(value: string) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function normalize(vec: number[]) {
  const mag = Math.sqrt(vec.reduce((sum, n) => sum + n * n, 0)) || 1;
  return vec.map((n) => n / mag);
}

function dot(a: number[], b: number[]) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}
