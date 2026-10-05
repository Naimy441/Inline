/**
 * Randomized (property-style) test of the document hub: browser clients,
 * suggesting-mode edits and agent edits interleave with accept/reject, and
 * after every operation the hub must keep its invariants.
 *
 * Reproduce a failure with FUZZ_SEED=<seed> (and optionally FUZZ_OPS=<n>;
 * FUZZ_DEBUG=1 logs the document before each agent edit):
 *   FUZZ_SEED=1234 npx tsx --test tests/hub-fuzz.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Node as PMNode } from "prosemirror-model";
import { Step, Transform } from "prosemirror-transform";

import { applyStringEdits, EditError } from "@/lib/doc/editing";
import { ensureBlockIds } from "@/lib/doc/ids";
import { docToMarkdown, markdownToDoc } from "@/lib/doc/markdown";
import { hunkFromJSON, rejectHunks } from "@/lib/doc/review";
import { schema } from "@/lib/doc/schema";
import { DEFAULT_SETTINGS } from "@/lib/doc/settings";
import { LiveDocument, StepConflictError } from "@/lib/server/hub";

process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-fuzz-"));

// --- seeded PRNG ---------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = ReturnType<typeof mulberry32>;
const int = (rng: Rng, n: number) => Math.floor(rng() * n);
const pick = <T>(rng: Rng, items: readonly T[]) => items[int(rng, items.length)]!;

const WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet",
  "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango",
];

function initialMarkdown(rng: Rng) {
  const paragraphs: string[] = [];
  const count = 3 + int(rng, 3);
  for (let p = 0; p < count; p += 1) {
    const words = Array.from({ length: 5 + int(rng, 8) }, () => pick(rng, WORDS));
    paragraphs.push(`${words.join(" ")}.`);
  }
  return paragraphs.join("\n\n");
}

// --- helpers ------------------------------------------------------------------

function textblocks(doc: PMNode) {
  const blocks: Array<{ pos: number; node: PMNode }> = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      blocks.push({ pos, node });
      return false;
    }
    return true;
  });
  return blocks;
}

function overlapsHunk(live: LiveDocument, from: number, to: number) {
  return live.hunks.some((h) => h.from <= to && from <= h.to);
}

/** The document with every pending change undone. */
function rejectedAll(live: LiveDocument) {
  const { tr, remaining } = rejectHunks(live.doc, live.hunks, "all");
  return { doc: tr.doc, remaining };
}

type Options = { seed: number; ops: number; multiWordAgentEdits: boolean; rawClientEdits?: boolean };

function run({ seed, ops, multiWordAgentEdits, rawClientEdits = false }: Options) {
  const rng = mulberry32(seed);
  const start = ensureBlockIds(markdownToDoc(initialMarkdown(rng)));
  const now = Date.now();
  const live = new LiveDocument({
    format: 3,
    meta: { id: `fuzz${seed}`, title: "Fuzz", createdAt: now, updatedAt: now, lastOpenedAt: now, trashedAt: null, settings: DEFAULT_SETTINGS, wordCount: 0, preview: "" },
    doc: start.toJSON(),
    comments: [],
    hunks: [],
  });

  // A browser replica that only learns about changes through stepsSince.
  let replica = live.doc;
  let replicaVersion = 0;
  // The document with every pending change undone, tracked independently of the
  // hub; null while unknown. Paragraph count never changes in this fuzz (edits stay
  // inside paragraphs), so paragraph i here corresponds to paragraph i in the hub.
  let accepted: PMNode | null = start;
  const trace: string[] = [];

  const fail = (message: string): never =>
    assert.fail(
      `seed=${seed} op=${trace.length}: ${message}\ntrace:\n  ${trace.slice(-12).join("\n  ")}\nhunks: ${JSON.stringify(
        live.hunksJSON().map((h) => ({ id: h.id, from: h.from, to: h.to, author: h.author, inserted: h.insertedText, deleted: h.deletedText })),
      )}`,
    );

  function syncReplica() {
    const since = live.stepsSince(replicaVersion);
    if (!since) fail(`stepsSince(${replicaVersion}) returned null at version ${live.version}`);
    for (const json of since!.steps) {
      const result = Step.fromJSON(schema, json).apply(replica);
      if (result.failed) fail(`replica could not apply a step: ${result.failed}`);
      replica = result.doc!;
    }
    replicaVersion = live.version;
    if (!replica.eq(live.doc)) fail("replica diverged from the hub");
  }

  function checkInvariants() {
    const size = live.doc.content.size;
    try {
      live.doc.check();
    } catch (error) {
      fail(`doc.check() failed: ${(error as Error).message}`);
    }
    let previousTo = -1;
    let previousFrom = -1;
    for (const hunk of live.hunks) {
      if (!(hunk.from >= 0 && hunk.from <= hunk.to && hunk.to <= size)) fail(`hunk out of bounds: ${hunk.from}-${hunk.to} (size ${size})`);
      if (hunk.from < previousFrom) fail("hunks are not sorted");
      if (hunk.from < previousTo) fail(`hunks overlap: ${previousFrom}-${previousTo} and ${hunk.from}-${hunk.to}`);
      if (hunk.from === hunk.to && hunk.deleted.size === 0) fail("empty hunk kept");
      previousFrom = hunk.from;
      previousTo = hunk.to;
    }
    // Hunks survive a JSON round trip.
    for (const json of JSON.parse(JSON.stringify(live.hunksJSON()))) {
      const back = hunkFromJSON(json, schema);
      const original = live.hunks.find((h) => h.id === back.id)!;
      if (!back.deleted.eq(original.deleted) || back.from !== original.from || back.to !== original.to) fail("hunk JSON round trip changed it");
    }
    // Undoing everything is always possible and lands on the accepted text.
    const { doc, remaining } = rejectedAll(live);
    if (remaining.length) fail(`${remaining.length} hunks could not be rejected`);
    if (accepted !== null && docToMarkdown(doc) !== docToMarkdown(accepted)) {
      fail(`reject-all text differs from the accepted text\nexpected: ${JSON.stringify(docToMarkdown(accepted))}\nactual:   ${JSON.stringify(docToMarkdown(doc))}`);
    }
    if (live.doc.childCount !== start.childCount) fail("paragraph count changed");
    syncReplica();
  }

  function clientEdit(suggest: boolean) {
    const blocks = textblocks(live.doc);
    const index = int(rng, blocks.length);
    const { pos, node } = blocks[index]!;
    const blockFrom = pos + 1;
    const blockTo = pos + 1 + node.content.size;
    const tr = new Transform(live.doc);
    const text = node.textContent;
    const words = [...text.matchAll(/[a-z]+/g)];
    const deleting = rng() < 0.4 && words.length > 2;
    let from: number;
    let to: number;
    if (rawClientEdits) {
      // Arbitrary character ranges: leaves double, leading and trailing spaces behind.
      if (deleting && node.content.size > 2) {
        from = blockFrom + int(rng, node.content.size - 1);
        to = Math.min(blockTo, from + 1 + int(rng, 6));
        tr.delete(from, to);
      } else {
        from = to = blockFrom + int(rng, node.content.size + 1);
        tr.insert(from, schema.text(`${rng() < 0.5 ? " " : ""}${pick(rng, WORDS)}${rng() < 0.5 ? " " : ""}`));
      }
    } else if (deleting) {
      // Delete a whole word and one adjacent space, keeping the text tidy.
      const i = int(rng, words.length);
      const word = words[i]!;
      let start = word.index!;
      let end = start + word[0].length;
      if (text[start - 1] === " ") start -= 1;
      else if (text[end] === " ") end += 1;
      else return;
      from = blockFrom + start;
      to = blockFrom + end;
      tr.delete(from, to);
    } else {
      // Insert a word at a word boundary.
      const boundaries = [0, ...words.map((w) => w.index! + w[0].length)];
      const at = pick(rng, boundaries);
      from = to = blockFrom + at;
      tr.insert(from, schema.text(at === 0 ? `${pick(rng, WORDS)} ` : ` ${pick(rng, WORDS)}`));
    }
    // A direct edit touching pending changes muddles what "accepted" means; stop
    // tracking it until the next accept-all / reject-all.
    const untouched = !overlapsHunk(live, pos, pos + node.nodeSize);
    if (!suggest && !untouched) accepted = null;
    if (!suggest && accepted !== null) {
      // A paragraph with no pending change reads the same as its accepted version.
      if (!accepted.child(index).content.eq(node.content)) fail(`paragraph ${index} has no hunk but differs from the accepted text`);
      let acceptedPos = 0;
      for (let i = 0; i < index; i += 1) acceptedPos += accepted.child(i).nodeSize;
      const mirror = new Transform(accepted);
      for (const step of tr.steps) {
        const shifted = Step.fromJSON(schema, { ...step.toJSON(), from: (step.toJSON() as { from: number }).from - pos + acceptedPos, to: (step.toJSON() as { to: number }).to - pos + acceptedPos });
        mirror.step(shifted);
      }
      accepted = mirror.doc;
    }
    const steps = tr.steps.map((s) => s.toJSON());
    trace.push(`${suggest ? "suggest" : "client"} ${deleting ? "delete" : "insert"} ${from}-${to}`);

    // A client that is behind is told the current version and changes nothing.
    if (live.version > 0 && rng() < 0.15) {
      const doc = live.doc;
      try {
        live.receiveClientSteps(live.version - 1, steps, "stale");
        fail("stale steps were accepted");
      } catch (error) {
        if (!(error instanceof StepConflictError) || error.version !== live.version) throw error;
      }
      if (live.doc !== doc) fail("a rejected batch changed the document");
    }

    live.receiveClientSteps(live.version, steps, suggest ? "suggester" : `client${int(rng, 3)}`, { suggest });
  }

  function agentEdit() {
    const markdown = docToMarkdown(live.doc);
    const words = [...markdown.matchAll(/[a-z]+/g)];
    if (!words.length) return;
    const count = multiWordAgentEdits ? 2 + int(rng, 3) : 1;
    const first = int(rng, words.length);
    const span = words.slice(first, first + count);
    const startAt = span[0]!.index!;
    const last = span[span.length - 1]!;
    const endAt = last.index! + last[0].length;
    const old_string = markdown.slice(startAt, endAt);
    if (old_string.includes("\n")) return;
    let new_string = old_string;
    if (multiWordAgentEdits) {
      // Change every other word so one step spans several word-level changes.
      new_string = span.map((m, i) => (i % 2 === 0 ? `${pick(rng, WORDS)}x` : m[0])).join(" ");
      if (span.map((m) => m[0]).join(" ") !== old_string) return; // markup in between
    } else {
      const replacement = pick(rng, WORDS);
      new_string = rng() < 0.2 ? `**${replacement}**` : replacement;
    }
    if (new_string === old_string) return;
    let tr: Transform;
    try {
      tr = applyStringEdits(live.doc, [{ old_string, new_string }]);
    } catch (error) {
      if (error instanceof EditError) return; // ambiguous match; Claude would add context
      throw error;
    }
    trace.push(`agent ${JSON.stringify(old_string)} -> ${JSON.stringify(new_string)}`);
    if (process.env.FUZZ_DEBUG) console.error("agent edit on", JSON.stringify(markdown), "steps", JSON.stringify(tr.steps.map((x) => x.toJSON())));
    live.applyTransform(tr, { kind: "agent", author: `chat${int(rng, 2)}` });
  }

  function review() {
    if (!live.hunks.length) return;
    const roll = rng();
    if (roll < 0.2) {
      trace.push("accept all");
      live.review("accept", "all");
      accepted = live.doc;
    } else if (roll < 0.4) {
      trace.push("reject all");
      live.review("reject", "all");
      if (live.hunks.length) fail("hunks remain after reject all");
      if (accepted !== null && docToMarkdown(live.doc) !== docToMarkdown(accepted)) fail("reject all did not restore the accepted text");
      accepted = live.doc;
    } else if (roll < 0.7) {
      const target = pick(rng, live.hunks);
      trace.push(`accept ${target.from}-${target.to}`);
      live.review("accept", [target.id]);
      if (live.hunks.some((h) => h.id === target.id)) fail("accepted hunk is still pending");
      // Accepting folds that change into the baseline; the rest must still undo cleanly.
      if (accepted !== null) accepted = rejectedAll(live).doc;
    } else {
      const target = pick(rng, live.hunks);
      trace.push(`reject ${target.from}-${target.to}`);
      live.review("reject", [target.id]);
      if (live.hunks.some((h) => h.id === target.id)) fail("rejected hunk is still pending");
    }
  }

  checkInvariants();
  for (let i = 0; i < ops; i += 1) {
    const roll = rng();
    if (roll < 0.3) clientEdit(false);
    else if (roll < 0.42) clientEdit(true);
    else if (roll < 0.75) agentEdit();
    else review();
    checkInvariants();
  }

  // Everything still persists and reloads faithfully.
  const reloaded = new LiveDocument(JSON.parse(JSON.stringify(live.toFile())));
  if (!reloaded.doc.eq(live.doc)) fail("reloaded document differs");
  assert.deepEqual(reloaded.hunksJSON(), live.hunksJSON());
  live.markDeleted();
}

const envSeed = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : null;
const OPS = Number(process.env.FUZZ_OPS) || 200;
const SEEDS = envSeed !== null ? [envSeed] : Array.from({ length: Number(process.env.FUZZ_SEEDS) || 40 }, (_, i) => 1000 + i * 7919);

describe("hub fuzz: single-word agent edits", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => run({ seed, ops: OPS, multiWordAgentEdits: false }));
  }
});

describe("hub fuzz: agent edits spanning several words", () => {
  it(
    "keeps every invariant",
    () => {
      for (const seed of SEEDS) run({ seed, ops: OPS, multiWordAgentEdits: true });
    },
  );
});

describe("hub fuzz: raw character-level client edits", () => {
  it(
    "keeps every invariant",
    () => {
      for (const seed of SEEDS) run({ seed, ops: OPS, multiWordAgentEdits: false, rawClientEdits: true });
    },
  );
});
