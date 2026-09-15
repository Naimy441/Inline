import { lookup as dnsLookup } from "node:dns/promises";
import type { AgentCitation } from "@/lib/agent/types";

export const WEB_SEARCH_MAX = 8;
export const WEB_FETCH_MAX = 8;
export const WEB_QUERY_CHARS = 400;
export const WEB_SNIPPET_CHARS = 420;
export const WEB_FETCH_CHARS = 8_000;
export const WEB_FETCH_CHARS_CAP = 12_000;

export type WebRecency = "any" | "day" | "week" | "month" | "year";
export type WebTopic = "general" | "news";
export type WebProvider = "tavily" | "brave" | "exa" | "duckduckgo";

export type WebHit = {
  title: string;
  url: string;
  snippet: string;
  published?: string;
  site: string;
  score?: number;
};

export type WebSearchArgs = {
  query: string;
  recency?: WebRecency;
  maxResults?: number;
  topic?: WebTopic;
  site?: string;
};

export type WebSearchResult = {
  ok: boolean;
  query: string;
  provider?: WebProvider;
  answer?: string;
  results: WebHit[];
  citations: AgentCitation[];
  error?: string;
  tried?: WebProvider[];
};

export type WebFetchArgs = {
  url: string;
  maxChars?: number;
};

export type WebFetchResult = {
  ok: boolean;
  url: string;
  title?: string;
  text?: string;
  published?: string;
  citation?: AgentCitation;
  error?: string;
};

export type ResearchEnv = Record<string, string | undefined>;

export type ResearchIO = {
  fetch: typeof fetch;
  lookup: (hostname: string) => Promise<string[]>;
  env: ResearchEnv;
  now: () => number;
};

export class ResearchBudget {
  searches = 0;
  fetches = 0;

  constructor(
    readonly maxSearch = WEB_SEARCH_MAX,
    readonly maxFetch = WEB_FETCH_MAX,
  ) {}

  takeSearch() {
    if (this.searches >= this.maxSearch) return false;
    this.searches += 1;
    return true;
  }

  takeFetch() {
    if (this.fetches >= this.maxFetch) return false;
    this.fetches += 1;
    return true;
  }
}

const RATE_STAMPS: number[] = [];
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const BLOCKED_HOST = /^(localhost|metadata\.google\.internal)$|\.(localhost|local|internal|lan)$/i;

export function defaultResearchIO(): ResearchIO {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    lookup: async (hostname) => {
      const rows = await dnsLookup(hostname, { all: true, verbatim: true });
      return rows.map((row) => row.address);
    },
    env: process.env,
    now: () => Date.now(),
  };
}

export function webEnabled(env: ResearchEnv = process.env) {
  return env.INLINE_DISABLE_WEB !== "1";
}

export async function webSearch(args: WebSearchArgs, budget?: ResearchBudget, io: ResearchIO = defaultResearchIO()): Promise<WebSearchResult> {
  const query = sanitizeQuery(args.query);
  if (!query) return { ok: false, query: "", results: [], citations: [], error: "Query is required." };
  if (!webEnabled(io.env)) return { ok: false, query, results: [], citations: [], error: "Web research is disabled." };
  if (budget && !budget.takeSearch()) {
    return { ok: false, query, results: [], citations: [], error: `Search budget is ${budget.maxSearch} queries this turn.` };
  }
  if (!rateOk(io.now())) {
    return { ok: false, query, results: [], citations: [], error: "Too many web searches. Wait a moment." };
  }

  const maxResults = clamp(args.maxResults ?? 5, 1, 8);
  const recency = args.recency ?? "any";
  const topic = args.topic ?? inferTopic(query, args.topic);
  const site = sanitizeSite(args.site);
  const tried: WebProvider[] = [];
  const errors: string[] = [];

  const providers: Array<[WebProvider, () => Promise<{ answer?: string; hits: WebHit[] }>]> = [
    ["tavily", () => searchTavily(query, { maxResults, recency, topic, site }, io)],
    ["brave", () => searchBrave(query, { maxResults, recency, topic, site }, io)],
    ["exa", () => searchExa(query, { maxResults, recency, topic, site }, io)],
    ["duckduckgo", () => searchDuckDuckGo(query, { maxResults, site }, io)],
  ];

  for (const [name, run] of providers) {
    if (!providerReady(name, io.env) && name !== "duckduckgo") continue;
    tried.push(name);
    try {
      const raw = await run();
      const results = dedupeHits(raw.hits).slice(0, maxResults);
      if (!results.length) {
        errors.push(`${name}: no results`);
        continue;
      }
      return {
        ok: true,
        query,
        provider: name,
        answer: raw.answer?.trim() || undefined,
        results,
        citations: results.map(citationFromHit),
        tried,
      };
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }

  return {
    ok: false,
    query,
    results: [],
    citations: [],
    tried,
    error: errors.join(" ") || "No web search provider returned results.",
  };
}

export async function webFetch(args: WebFetchArgs, budget?: ResearchBudget, io: ResearchIO = defaultResearchIO()): Promise<WebFetchResult> {
  const parsed = parsePublicHttpUrl(args.url);
  if (!parsed.ok) return { ok: false, url: String(args.url ?? ""), error: parsed.error };
  if (!webEnabled(io.env)) return { ok: false, url: parsed.href, error: "Web research is disabled." };
  if (budget && !budget.takeFetch()) {
    return { ok: false, url: parsed.href, error: `Read budget is ${budget.maxFetch} pages this turn.` };
  }
  if (!rateOk(io.now())) return { ok: false, url: parsed.href, error: "Too many web requests. Wait a moment." };

  const maxChars = clamp(args.maxChars ?? WEB_FETCH_CHARS, 800, WEB_FETCH_CHARS_CAP);
  try {
    await assertResolvesPublic(parsed.hostname, io);
    const page = await fetchPage(parsed.href, io);
    let title = page.title;
    let text = page.text;
    let published = page.published;
    let finalUrl = page.url;
    if (text.length < 200) {
      const viaJina = await fetchViaJina(finalUrl, io).catch(() => null);
      if (viaJina && viaJina.text.length > text.length) {
        title = viaJina.title || title;
        text = viaJina.text;
        published = viaJina.published || published;
      }
    }
    if (!text.trim()) return { ok: false, url: finalUrl, title, error: "That page had no readable text." };
    const clipped = text.slice(0, maxChars);
    const finalHost = hostnameOf(finalUrl);
    const hit: WebHit = {
      title: title || finalHost,
      url: finalUrl,
      snippet: clipped.slice(0, WEB_SNIPPET_CHARS),
      published,
      site: siteLabel(finalHost),
    };
    return { ok: true, url: finalUrl, title: hit.title, text: clipped, published, citation: citationFromHit(hit) };
  } catch (error) {
    return { ok: false, url: parsed.href, error: error instanceof Error ? error.message : "Fetch failed." };
  }
}

export function parsePublicHttpUrl(raw: string): { ok: true; href: string; hostname: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(String(raw ?? "").trim());
  } catch {
    return { ok: false, error: "That is not a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http and https URLs can be read." };
  }
  if (parsed.username || parsed.password) return { ok: false, error: "URLs with credentials are blocked." };
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    return { ok: false, error: "Only ports 80 and 443 are allowed." };
  }
  const hostname = parsed.hostname.replace(/\.$/, "").toLowerCase();
  if (!hostname || BLOCKED_HOST.test(hostname) || hostname.endsWith(".local")) {
    return { ok: false, error: "That host is blocked." };
  }
  if (isBlockedIp(hostname)) return { ok: false, error: "Private or loopback addresses are blocked." };
  parsed.hash = "";
  return { ok: true, href: parsed.href, hostname };
}

export function htmlToText(html: string) {
  const title =
    attr(html, "og:title") ||
    tagText(html, "title") ||
    tagText(html, "h1") ||
    "";
  const published = attr(html, "article:published_time") || attr(html, "og:updated_time") || undefined;
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(script|style|noscript|iframe|object|embed)[^>]*>/gi, " ");
  const withBreaks = cleaned
    .replace(/<\/(p|div|h1|h2|h3|h4|li|tr|section|article|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ");
  const text = decodeEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();
  return { title: decodeEntities(title).trim(), text, published: published?.slice(0, 10) };
}

export function citationFromHit(hit: WebHit): AgentCitation {
  const year = yearFrom(hit.published);
  const author = hit.site || hostnameOf(hit.url);
  return {
    id: `web:${normalizeUrl(hit.url)}`,
    author,
    title: hit.title || author,
    year: year || "n.d.",
    url: hit.url,
    inline: year ? `(${author}, ${year})` : `(${author})`,
    bibliography: [hit.title || author, author, year || "n.d.", hit.url].filter(Boolean).join(". ") + ".",
  };
}

export function normalizeUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    parsed.searchParams.forEach((_, key) => {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid)/i.test(key)) parsed.searchParams.delete(key);
    });
    let href = parsed.href;
    if (href.endsWith("/") && parsed.pathname === "/") href = href.slice(0, -1);
    else if (href.endsWith("/") && parsed.search === "") href = href.slice(0, -1);
    return href;
  } catch {
    return url.trim();
  }
}

export function decodeDuckUrl(href: string) {
  try {
    const parsed = new URL(href, "https://duckduckgo.com");
    const target = parsed.searchParams.get("uddg") || parsed.searchParams.get("u");
    return target ? decodeURIComponent(target) : parsed.href;
  } catch {
    return href;
  }
}

export function isBlockedIp(value: string) {
  const mapped = value.toLowerCase().startsWith("::ffff:") ? value.slice(7) : value;
  if (mapped.includes(":")) {
    const ip = mapped.toLowerCase();
    return ip === "::1" || ip === "::" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd");
  }
  const expanded = expandIpv4Literal(mapped);
  if (!expanded) return false;
  const parts = expanded.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function expandIpv4Literal(value: string): string | null {
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
    return intToIpv4(n);
  }
  if (/^0x[0-9a-f]+$/i.test(value)) {
    const n = Number.parseInt(value, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
    return intToIpv4(n);
  }
  if (!/^(?:\d+|0x[0-9a-f]+)(?:\.(?:\d+|0x[0-9a-f]+)){0,3}$/i.test(value)) return null;
  const parts = value.split(".").map(parseIpv4Part);
  if (parts.some((part) => part === null)) return null;
  const nums = parts as number[];
  if (nums.length === 1) return nums[0]! <= 0xffffffff ? intToIpv4(nums[0]!) : null;
  if (nums.length === 2) {
    if (nums[0]! > 255 || nums[1]! > 0xffffff) return null;
    return intToIpv4((nums[0]! << 24) + nums[1]!);
  }
  if (nums.length === 3) {
    if (nums[0]! > 255 || nums[1]! > 255 || nums[2]! > 0xffff) return null;
    return intToIpv4((nums[0]! << 24) + (nums[1]! << 16) + nums[2]!);
  }
  if (nums.some((part) => part > 255)) return null;
  return nums.join(".");
}

function parseIpv4Part(part: string): number | null {
  if (/^0x/i.test(part)) {
    const n = Number.parseInt(part, 16);
    return Number.isInteger(n) ? n : null;
  }
  if (!/^\d+$/.test(part)) return null;
  const n = Number(part);
  return Number.isInteger(n) ? n : null;
}

function intToIpv4(n: number) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function providerReady(name: WebProvider, env: ResearchEnv) {
  if (name === "tavily") return Boolean(env.TAVILY_API_KEY?.trim());
  if (name === "brave") return Boolean((env.BRAVE_SEARCH_API_KEY || env.BRAVE_API_KEY)?.trim());
  if (name === "exa") return Boolean(env.EXA_API_KEY?.trim());
  return true;
}

function inferTopic(query: string, explicit?: WebTopic): WebTopic {
  if (explicit) return explicit;
  return /\b(news|today|latest|breaking|this week|yesterday|headline)\b/i.test(query) ? "news" : "general";
}

async function searchTavily(
  query: string,
  opts: { maxResults: number; recency: WebRecency; topic: WebTopic; site?: string },
  io: ResearchIO,
) {
  const key = io.env.TAVILY_API_KEY?.trim();
  if (!key) throw new Error("missing key");
  const body: Record<string, unknown> = {
    query,
    max_results: opts.maxResults,
    search_depth: "basic",
    topic: opts.topic,
    include_answer: false,
    include_raw_content: false,
  };
  if (opts.recency !== "any") body.time_range = opts.recency;
  if (opts.site) body.include_domains = [opts.site];
  const data = await readJson(
    await io.fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    }),
  );
  const rows = Array.isArray(data.results) ? data.results : [];
  return {
    answer: typeof data.answer === "string" ? data.answer : undefined,
    hits: rows.map((row) => hitFromUnknown(row, ["title", "url", "content", "published_date", "score"])).filter(Boolean) as WebHit[],
  };
}

async function searchBrave(
  query: string,
  opts: { maxResults: number; recency: WebRecency; topic: WebTopic; site?: string },
  io: ResearchIO,
) {
  const key = (io.env.BRAVE_SEARCH_API_KEY || io.env.BRAVE_API_KEY)?.trim();
  if (!key) throw new Error("missing key");
  const q = opts.site ? `${query} site:${opts.site}` : query;
  const params = new URLSearchParams({
    q,
    count: String(opts.maxResults),
    text_decorations: "false",
    extra_snippets: "true",
  });
  if (opts.recency !== "any") params.set("freshness", braveFreshness(opts.recency));
  if (opts.topic === "news") params.set("result_filter", "web");
  const data = await readJson(
    await io.fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": key,
      },
      signal: AbortSignal.timeout(12_000),
    }),
  );
  const web = asObject(data.web);
  const rows = Array.isArray(web?.results) ? web.results : [];
  return {
    hits: rows.map((row) => hitFromUnknown(row, ["title", "url", "description", "page_age"])).filter(Boolean) as WebHit[],
  };
}

async function searchExa(
  query: string,
  opts: { maxResults: number; recency: WebRecency; topic: WebTopic; site?: string },
  io: ResearchIO,
) {
  const key = io.env.EXA_API_KEY?.trim();
  if (!key) throw new Error("missing key");
  const body: Record<string, unknown> = {
    query,
    numResults: opts.maxResults,
    type: "auto",
    contents: { text: { maxCharacters: WEB_SNIPPET_CHARS } },
  };
  if (opts.site) body.includeDomains = [opts.site];
  if (opts.topic === "news") body.category = "news";
  if (opts.recency !== "any") body.startPublishedDate = recencyDate(opts.recency, io.now());
  const data = await readJson(
    await io.fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    }),
  );
  const rows = Array.isArray(data.results) ? data.results : [];
  return {
    hits: rows.map((row) => {
      const item = asObject(row);
      if (!item) return null;
      const text = asObject(item.text);
      return hitFromUnknown(
        { ...item, content: typeof item.text === "string" ? item.text : text?.text },
        ["title", "url", "content", "publishedDate"],
      );
    }).filter(Boolean) as WebHit[],
  };
}

async function searchDuckDuckGo(
  query: string,
  opts: { maxResults: number; site?: string },
  io: ResearchIO,
) {
  const q = opts.site ? `${query} site:${opts.site}` : query;
  const instant = await searchDuckInstant(q, io).catch(() => ({ hits: [] as WebHit[] }));
  if (instant.hits.length >= opts.maxResults) {
    return { hits: instant.hits.slice(0, opts.maxResults) };
  }
  const htmlHits = await searchDuckHtml(q, io).catch(() => [] as WebHit[]);
  const hits = dedupeHits([...instant.hits, ...htmlHits]);
  if (!hits.length) throw new Error("no results");
  return { hits: hits.slice(0, opts.maxResults) };
}

async function searchDuckInstant(query: string, io: ResearchIO) {
  const params = new URLSearchParams({ q: query, format: "json", no_html: "1", no_redirect: "1", skip_disambig: "1" });
  const data = await readJson(
    await io.fetch(`https://api.duckduckgo.com/?${params}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    }),
  );
  const hits: WebHit[] = [];
  if (typeof data.AbstractURL === "string" && parsePublicHttpUrl(data.AbstractURL).ok) {
    hits.push({
      title: String(data.Heading || data.AbstractSource || "DuckDuckGo"),
      url: data.AbstractURL,
      snippet: String(data.AbstractText || "").slice(0, WEB_SNIPPET_CHARS),
      site: siteLabel(hostnameOf(data.AbstractURL)),
    });
  }
  const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
  for (const row of related) {
    const item = asObject(row);
    if (!item) continue;
    const topics = Array.isArray(item.Topics) ? item.Topics : [item];
    for (const topic of topics) {
      const entry = asObject(topic);
      if (!entry || typeof entry.FirstURL !== "string") continue;
      hits.push({
        title: String(entry.Text || entry.FirstURL).split(" - ")[0] ?? entry.FirstURL,
        url: entry.FirstURL,
        snippet: String(entry.Text || "").slice(0, WEB_SNIPPET_CHARS),
        site: siteLabel(hostnameOf(entry.FirstURL)),
      });
    }
  }
  return { hits: dedupeHits(hits) };
}

async function searchDuckHtml(query: string, io: ResearchIO) {
  const params = new URLSearchParams({ q: query });
  const response = await io.fetch(`https://html.duckduckgo.com/html/?${params}`, {
    headers: {
      Accept: "text/html",
      "User-Agent": "InlineResearch/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`DuckDuckGo HTTP ${response.status}`);
  const html = await response.text();
  const hits: WebHit[] = [];
  const block = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|span|div)>)/gi;
  let match: RegExpExecArray | null;
  while ((match = block.exec(html))) {
    const url = decodeDuckUrl(decodeEntities(match[1] ?? ""));
    if (!parsePublicHttpUrl(url).ok) continue;
    hits.push({
      title: decodeEntities(stripTags(match[2] ?? "")).trim() || hostnameOf(url),
      url,
      snippet: decodeEntities(stripTags(match[3] ?? "")).trim().slice(0, WEB_SNIPPET_CHARS),
      site: siteLabel(hostnameOf(url)),
    });
  }
  if (hits.length) return hits;
  const loose = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = loose.exec(html))) {
    const url = decodeDuckUrl(decodeEntities(match[1] ?? ""));
    if (!parsePublicHttpUrl(url).ok) continue;
    hits.push({
      title: decodeEntities(stripTags(match[2] ?? "")).trim() || hostnameOf(url),
      url,
      snippet: "",
      site: siteLabel(hostnameOf(url)),
    });
  }
  return hits;
}

async function fetchPage(url: string, io: ResearchIO) {
  const { response, url: finalUrl } = await fetchFollowing(url, io, 4);
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const isPdf = /pdf/.test(type) || /\.pdf(\?|#|$)/i.test(finalUrl);
  if (isPdf || (type && !/text\/|json|xml|markdown|html/.test(type))) {
    if (isPdf) {
      const viaJina = await fetchViaJina(finalUrl, io).catch(() => null);
      if (viaJina?.text.trim()) return { ...viaJina, url: finalUrl };
      throw new Error("This is a PDF and could not be read. Fetch the HTML landing page for that report instead, then write. Do not search for another PDF of the same document.");
    }
    throw new Error("That URL is not a readable document.");
  }
  const raw = await readLimited(response, 1_200_000);
  if (/html|xml/.test(type) || /<html|<body|<article/i.test(raw.slice(0, 2_000))) {
    return { ...htmlToText(raw), url: finalUrl };
  }
  return { title: hostnameOf(finalUrl), text: raw.replace(/\s+\n/g, "\n").trim(), published: undefined as string | undefined, url: finalUrl };
}

async function fetchViaJina(url: string, io: ResearchIO) {
  const response = await io.fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: "text/plain", "X-Timeout": "12", "User-Agent": "InlineResearch/1.0" },
    signal: AbortSignal.timeout(14_000),
  });
  if (!response.ok) throw new Error(`Reader HTTP ${response.status}`);
  const raw = await readLimited(response, 1_200_000);
  const title = raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
  const published = raw.match(/^Published Time:\s*(.+)$/m)?.[1]?.trim()?.slice(0, 10);
  const start = raw.search(/\n\n/);
  const text = (start >= 0 ? raw.slice(start) : raw).trim();
  return { title: title || hostnameOf(url), text, published };
}

async function fetchFollowing(url: string, io: ResearchIO, hops: number): Promise<{ response: Response; url: string }> {
  let current = url;
  for (let hop = 0; hop <= hops; hop += 1) {
    const parsed = parsePublicHttpUrl(current);
    if (!parsed.ok) throw new Error(parsed.error);
    await assertResolvesPublic(parsed.hostname, io);
    const response = await io.fetch(parsed.href, {
      redirect: "manual",
      headers: {
        Accept: "text/html,text/plain,application/xhtml+xml,application/json;q=0.8,*/*;q=0.1",
        "User-Agent": "InlineResearch/1.0",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      if (!next) throw new Error("Redirect missing location.");
      current = new URL(next, parsed.href).href;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { response, url: parsed.href };
  }
  throw new Error("Too many redirects.");
}

async function assertResolvesPublic(hostname: string, io: ResearchIO) {
  if (isBlockedIp(hostname)) throw new Error("Private or loopback addresses are blocked.");
  const addresses = await io.lookup(hostname);
  if (!addresses.length) throw new Error("Host could not be resolved.");
  if (addresses.some((address) => isBlockedIp(address))) {
    throw new Error("That host resolves to a private address.");
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await readLimited(response, 800_000);
  const parsed = JSON.parse(text) as unknown;
  return asObject(parsed) ?? {};
}

async function readLimited(response: Response, max: number) {
  if (!response.body) return (await response.text()).slice(0, max);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(concat(chunks));
}

function concat(chunks: Uint8Array[]) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function hitFromUnknown(row: unknown, keys: string[]): WebHit | null {
  const item = asObject(row);
  if (!item) return null;
  const url = String(item.url ?? item.link ?? "").trim();
  if (!parsePublicHttpUrl(url).ok) return null;
  const title = String(item[keys[0]] ?? item.title ?? hostnameOf(url)).trim();
  const snippet = String(item.content ?? item.description ?? item.snippet ?? item.text ?? "").replace(/\s+/g, " ").trim();
  const published = String(item.published_date ?? item.publishedDate ?? item.page_age ?? item.published ?? "").slice(0, 10) || undefined;
  const score = typeof item.score === "number" ? item.score : undefined;
  return {
    title: title || hostnameOf(url),
    url: normalizeUrl(url),
    snippet: snippet.slice(0, WEB_SNIPPET_CHARS),
    published,
    site: siteLabel(hostnameOf(url)),
    score,
  };
}

function dedupeHits(hits: WebHit[]) {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = normalizeUrl(hit.url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeQuery(raw: string) {
  return raw.replace(/\s+/g, " ").trim().slice(0, WEB_QUERY_CHARS);
}

function sanitizeSite(raw?: string) {
  if (!raw?.trim()) return undefined;
  const value = raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./i, "").toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) return undefined;
  return value;
}

function siteLabel(hostname: string) {
  const host = hostname.replace(/^www\./i, "");
  const base = host.split(".")[0] ?? host;
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : host;
}

function hostnameOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "Web";
  }
}

function yearFrom(value?: string) {
  const match = value?.match(/(20\d{2}|19\d{2})/);
  return match?.[1];
}

function braveFreshness(recency: WebRecency) {
  if (recency === "day") return "pd";
  if (recency === "week") return "pw";
  if (recency === "month") return "pm";
  return "py";
}

function recencyDate(recency: WebRecency, now: number) {
  const days = recency === "day" ? 1 : recency === "week" ? 7 : recency === "month" ? 31 : 365;
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

function rateOk(now: number) {
  while (RATE_STAMPS[0] && now - RATE_STAMPS[0] > RATE_WINDOW_MS) RATE_STAMPS.shift();
  if (RATE_STAMPS.length >= RATE_LIMIT) return false;
  RATE_STAMPS.push(now);
  return true;
}

export function resetResearchRateLimit() {
  RATE_STAMPS.length = 0;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function attr(html: string, name: string) {
  const property = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"));
  if (property?.[1]) return property[1];
  const reverse = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, "i"));
  return reverse?.[1];
}

function tagText(html: string, tag: string) {
  return html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1];
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}
