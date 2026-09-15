import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  ResearchBudget,
  citationFromHit,
  decodeDuckUrl,
  htmlToText,
  isBlockedIp,
  normalizeUrl,
  parsePublicHttpUrl,
  resetResearchRateLimit,
  webFetch,
  webSearch,
  type ResearchIO,
} from "./webResearch";
import { parseToolPayload } from "./mcp/register";
import { stepHits, stepTitle } from "./mcp/prompt";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, type: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": type } });
}

function io(overrides: Partial<ResearchIO> & { fetch: ResearchIO["fetch"] }): ResearchIO {
  return {
    lookup: async () => ["93.184.216.34"],
    env: {},
    now: () => Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  resetResearchRateLimit();
});

describe("URL hardening", () => {
  it("accepts public https pages", () => {
    const parsed = parsePublicHttpUrl("https://www.example.com/path?utm_source=x#frag");
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.match(parsed.href, /^https:\/\/www\.example\.com\/path/);
  });

  it("blocks private, local, credentialed, and odd-protocol URLs", () => {
    const blocked = [
      "http://localhost/admin",
      "http://127.0.0.1/",
      "http://10.0.0.8/secret",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
      "ftp://example.com/file",
      "https://user:pass@example.com/",
      "https://example.com:22/",
      "http://metadata.google.internal/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
    ];
    for (const url of blocked) {
      const parsed = parsePublicHttpUrl(url);
      assert.equal(parsed.ok, false, url);
    }
  });

  it("detects loopback, RFC1918, and IPv6 local addresses", () => {
    assert.equal(isBlockedIp("127.0.0.1"), true);
    assert.equal(isBlockedIp("10.1.2.3"), true);
    assert.equal(isBlockedIp("172.16.0.1"), true);
    assert.equal(isBlockedIp("192.168.0.9"), true);
    assert.equal(isBlockedIp("::1"), true);
    assert.equal(isBlockedIp("::ffff:127.0.0.1"), true);
    assert.equal(isBlockedIp("127.1"), true);
    assert.equal(isBlockedIp("2130706433"), true);
    assert.equal(isBlockedIp("93.184.216.34"), false);
  });
});

describe("page extraction", () => {
  it("pulls title, date, and paragraphs from HTML", () => {
    const page = htmlToText(`
      <html><head>
        <title>Ignored</title>
        <meta property="og:title" content="Street trees in cities" />
        <meta property="article:published_time" content="2024-04-12T08:00:00Z" />
        <script>alert(1)</script>
      </head>
      <body>
        <h1>Street trees</h1>
        <p>Cities plant canopy for shade.</p>
        <p>Second paragraph stays.</p>
      </body></html>
    `);
    assert.equal(page.title, "Street trees in cities");
    assert.equal(page.published, "2024-04-12");
    assert.match(page.text, /Cities plant canopy/);
    assert.doesNotMatch(page.text, /alert/);
  });

  it("builds a citation a writer can insert", () => {
    const citation = citationFromHit({
      title: "Street trees in cities",
      url: "https://www.example.com/trees?utm_source=x",
      snippet: "Cities plant canopy for shade.",
      published: "2024-04-12",
      site: "Example",
    });
    assert.equal(citation.author, "Example");
    assert.equal(citation.year, "2024");
    assert.equal(citation.inline, "(Example, 2024)");
    assert.match(citation.bibliography, /example.com/);
    assert.match(citation.id, /^web:/);
  });

  it("normalizes tracking URLs and decodes DuckDuckGo redirects", () => {
    assert.equal(
      normalizeUrl("https://www.Example.com/a/?utm_source=x&id=1"),
      "https://example.com/a/?id=1",
    );
    assert.equal(
      decodeDuckUrl("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage"),
      "https://example.com/page",
    );
  });
});

describe("web_search", () => {
  it("uses Tavily when a key is present", async () => {
    const result = await webSearch(
      { query: "street trees cooling cities", maxResults: 3 },
      undefined,
      io({
        env: { TAVILY_API_KEY: "tvly-test" },
        fetch: async (url) => {
          assert.match(String(url), /tavily.com\/search/);
          return jsonResponse({
            results: [
              { title: "Canopy study", url: "https://example.com/canopy", content: "Shade lowers street temperatures.", published_date: "2023-06-01", score: 0.9 },
              { title: "Canopy study", url: "https://example.com/canopy?utm_source=x", content: "duplicate" },
              { title: "Local host", url: "http://127.0.0.1/secret", content: "nope" },
            ],
          });
        },
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.provider, "tavily");
    assert.equal(result.results.length, 1);
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0]?.inline, "(Example, 2023)");
  });

  it("falls through to DuckDuckGo when paid providers are unset", async () => {
    const result = await webSearch(
      { query: "Ada Lovelace", maxResults: 2 },
      undefined,
      io({
        env: {},
        fetch: async (url) => {
          const href = String(url);
          if (href.includes("api.duckduckgo.com")) {
            return jsonResponse({
              Heading: "Ada Lovelace",
              AbstractURL: "https://en.wikipedia.org/wiki/Ada_Lovelace",
              AbstractText: "English mathematician.",
              RelatedTopics: [],
            });
          }
          return textResponse("", "text/html", 404);
        },
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.provider, "duckduckgo");
    assert.match(result.results[0]?.url ?? "", /wikipedia.org/);
  });

  it("respects the per-turn search budget", async () => {
    const budget = new ResearchBudget(1, 8);
    const searchIo = io({
      env: { TAVILY_API_KEY: "tvly-test" },
      fetch: async () => jsonResponse({ results: [{ title: "A", url: "https://example.com/a", content: "a" }] }),
    });
    const first = await webSearch({ query: "one" }, budget, searchIo);
    const second = await webSearch({ query: "two" }, budget, searchIo);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.match(second.error ?? "", /budget/i);
  });

  it("rejects an empty query", async () => {
    const result = await webSearch({ query: "   " });
    assert.equal(result.ok, false);
  });

  it("can be disabled with INLINE_DISABLE_WEB", async () => {
    const result = await webSearch(
      { query: "anything" },
      undefined,
      io({
        env: { INLINE_DISABLE_WEB: "1", TAVILY_API_KEY: "tvly-test" },
        fetch: async () => {
          throw new Error("should not search");
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /disabled/i);
  });
});

describe("web_fetch", () => {
  it("reads a public HTML page and returns a citation", async () => {
    const result = await webFetch(
      { url: "https://example.com/trees", maxChars: 800 },
      undefined,
      io({
        fetch: async (url, init) => {
          assert.equal(init?.redirect, "manual");
          assert.equal(String(url), "https://example.com/trees");
          return textResponse(
            `<html><head><title>Trees</title></head><body><p>${"Shade. ".repeat(40)}</p></body></html>`,
            "text/html",
          );
        },
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.title, "Trees");
    assert.match(result.text ?? "", /Shade/);
    assert.equal(result.citation?.author, "Example");
  });

  it("refuses a host that resolves privately", async () => {
    const result = await webFetch(
      { url: "https://example.com/internal" },
      undefined,
      io({
        lookup: async () => ["10.0.0.4"],
        fetch: async () => {
          throw new Error("should not fetch");
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /private/i);
  });

  it("follows one public redirect and re-checks the next host", async () => {
    let hops = 0;
    const result = await webFetch(
      { url: "https://example.com/old" },
      undefined,
      io({
        fetch: async (url) => {
          hops += 1;
          if (String(url).includes("/old")) {
            return new Response(null, { status: 302, headers: { location: "https://example.org/new" } });
          }
          return textResponse(
            `<html><head><title>Moved</title></head><body><p>${"Arrived at the new page. ".repeat(12)}</p></body></html>`,
            "text/html",
          );
        },
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.url, "https://example.org/new");
    assert.equal(hops, 2);
  });

  it("tells the agent to use an HTML page when a PDF cannot be read", async () => {
    const result = await webFetch(
      { url: "https://example.com/ai-report.pdf" },
      undefined,
      io({
        fetch: async (url) => {
          if (String(url).includes("r.jina.ai")) return new Response("", { status: 404 });
          return textResponse("%PDF-1.4", "application/pdf");
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /PDF/);
    assert.match(result.error ?? "", /HTML landing page/);
  });
});

describe("agent wiring", () => {
  it("surfaces fetched pages as citations, not search snippets", () => {
    const search = parseToolPayload("web_search", {
      ok: true,
      citations: [{ id: "web:1", author: "Example", title: "Trees", year: "2024", inline: "(Example, 2024)", bibliography: "Trees." }],
    });
    assert.equal(search.citations, undefined);
    const fetched = parseToolPayload("web_fetch", {
      ok: true,
      citation: { id: "web:2", author: "Nature", title: "Paper", year: "2021", inline: "(Nature, 2021)", bibliography: "Paper." },
    });
    assert.equal(fetched.citations?.[0]?.title, "Paper");
  });

  it("labels search and fetch steps", () => {
    assert.match(stepTitle("web_search", { query: "street trees" }), /street trees/);
    assert.match(stepTitle("web_fetch", { url: "https://www.example.com/a" }), /example.com/);
    const hits = stepHits("web_search", { results: [{ title: "Canopy" }, { title: "Shade" }] });
    assert.deepEqual(hits, ["Canopy", "Shade"]);
  });
});
