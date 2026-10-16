import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-jobs-"));

import { createJobRunner, resetJobsForTests, type JobExecute } from "@/lib/agent/jobs";
import { runTool, type ToolContext } from "@/lib/agent/tools";
import { docToMarkdown } from "@/lib/doc/markdown";
import { documentHub } from "@/lib/server/hub";

const SAMPLE = `# Field notes {.title}

The quick brown fox jumps over the lazy dog.

## Findings

- Foxes are quick
- Dogs are lazy`;

function writesOf(name: string) {
  return name === "edit_document" || name === "write_document" || name === "run_command";
}

function runner(execute: JobExecute) {
  return createJobRunner(execute, async (name) => (name === "missing_tool" ? undefined : { write: writesOf(name) }));
}

const ctx = (documentId = "doc-1", author = "chat-a"): ToolContext => ({ author, documentId });

describe("job runner", () => {
  test("a background job returns an id immediately and a later call collects the result", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const jobs = runner(async (_name, _args, signalCtx) => {
      await gate;
      if (signalCtx.signal?.aborted) return { text: "should not win", isError: true };
      return { text: "read the second page" };
    });
    const started = await jobs.start({ tool: "read_document", arguments: { page: 2 } }, ctx());
    assert.match(started.text, /Started job (job_[0-9a-f]+) \(read_document\)/);
    assert.match(started.text, /still be running|It is running/);
    const id = /job_[0-9a-f]+/.exec(started.text)![0]!;
    assert.match(jobs.get(id, "chat-a").text, /is still running/);
    assert.equal(jobs.get(id, "chat-a").isError, undefined);
    release();
    const done = await new Promise<string>((resolve) => {
      const timer = setInterval(() => {
        const result = jobs.get(id, "chat-a");
        if (!/still running/.test(result.text)) {
          clearInterval(timer);
          resolve(result.text);
        }
      }, 5);
    });
    assert.match(done, /read the second page/);
    assert.match(done, /finished/);
  });

  test("stop cancels a running job promptly and the result says it was cancelled", async () => {
    let sawAbort = false;
    const jobs = runner(
      (_name, _args, signalCtx) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ text: "finished too late" }), 5_000);
          signalCtx.signal?.addEventListener("abort", () => {
            sawAbort = true;
            clearTimeout(timer);
            resolve({ text: "handler noticed" });
          });
        }),
    );
    const started = await jobs.start({ tool: "screenshot_page", arguments: { page: 1 } }, ctx());
    const id = /job_[0-9a-f]+/.exec(started.text)![0]!;
    const began = Date.now();
    const stopped = jobs.stop(id, "chat-a");
    assert.match(stopped.text, /was cancelled/);
    assert.ok(Date.now() - began < 500, "cancel returns without waiting for the tool");
    assert.equal(sawAbort, true);
    assert.match(jobs.get(id, "chat-a").text, /was cancelled/);
    assert.equal(jobs.get(id, "someone-else").isError, true);
  });

  test("independent reads and screenshots run at the same time", async () => {
    let current = 0;
    let max = 0;
    const jobs = runner(async (name) => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => setTimeout(resolve, 40));
      current -= 1;
      return { text: `done ${name}` };
    });
    const result = await jobs.startMany(
      [
        { tool: "read_document", arguments: { document_id: "one" } },
        { tool: "screenshot_page", arguments: { page: 2, document_id: "two" } },
      ],
      ctx(),
    );
    assert.ok(max >= 2, "the two jobs overlapped");
    assert.match(result.text, /Started 2 jobs together/);
    assert.match(result.text, /Ran at the same time: job_[0-9a-f]+ \(read_document\), job_[0-9a-f]+ \(screenshot_page\)/);
    assert.match(result.text, /done read_document/);
    assert.match(result.text, /done screenshot_page/);
    assert.equal(result.isError, undefined);
  });

  test("a second edit of the same document is rejected and names the job already writing", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let edits = 0;
    const jobs = runner(async (name, args) => {
      if (name === "edit_document") {
        edits += 1;
        await gate;
      }
      return { text: `edited ${args.document_id}` };
    });
    const started = await jobs.start({ tool: "edit_document", arguments: { document_id: "doc-1", old_string: "a", new_string: "b" } }, ctx("doc-1"));
    const id = /job_[0-9a-f]+/.exec(started.text)![0]!;
    const blocked = await jobs.startMany([{ tool: "edit_document", arguments: { document_id: "doc-1", old_string: "c", new_string: "d" } }], ctx("doc-1"));
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, new RegExp(`Job ${id} is already writing document doc-1`));
    assert.match(blocked.text, /was not started/);
    assert.equal(edits, 1);
    release();
    const finished = await new Promise<string>((resolve) => {
      const timer = setInterval(() => {
        const result = jobs.get(id, "chat-a");
        if (!/still running/.test(result.text)) {
          clearInterval(timer);
          resolve(result.text);
        }
      }, 5);
    });
    assert.match(finished, /edited doc-1/);
  });

  test("edits of different documents run together", async () => {
    let current = 0;
    let max = 0;
    const jobs = runner(async (_name, args) => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => setTimeout(resolve, 40));
      current -= 1;
      return { text: `edited ${args.document_id}` };
    });
    const result = await jobs.startMany(
      [
        { tool: "edit_document", arguments: { document_id: "doc-1" } },
        { tool: "edit_document", arguments: { document_id: "doc-2" } },
      ],
      ctx(),
    );
    assert.ok(max >= 2);
    assert.equal(result.isError, undefined);
    assert.match(result.text, /edited doc-1/);
    assert.match(result.text, /edited doc-2/);
  });

  test("unknown tools and job-control tools are not started", async () => {
    const jobs = runner(async () => ({ text: "nope" }));
    const missing = await jobs.start({ tool: "missing_tool" }, ctx());
    assert.match(missing.text, /Unknown tool missing_tool/);
    const nested = await jobs.start({ tool: "start_job" }, ctx());
    assert.match(nested.text, /cannot start another job/);
  });
});

describe("job tools", () => {
  test("direct read_document still waits for its own result", async () => {
    resetJobsForTests();
    const doc = await documentHub().create({ title: "Field notes", markdown: SAMPLE });
    const result = await runTool("read_document", {}, { author: "direct", documentId: doc.id });
    assert.equal(result.isError, undefined, result.text);
    assert.match(result.text, /lazy dog/);
  });

  test("two reads of different documents come back from one call", async () => {
    const first = await documentHub().create({ title: "Alpha", markdown: "Alpha body stays put." });
    const second = await documentHub().create({ title: "Beta", markdown: "Beta body stays put." });
    const result = await runTool(
      "start_jobs",
      {
        jobs: [
          { tool: "read_document", arguments: { document_id: first.id } },
          { tool: "read_document", arguments: { document_id: second.id } },
        ],
      },
      { author: "batch-reads", documentId: first.id },
    );
    assert.equal(result.isError, undefined, result.text);
    assert.match(result.text, /Started 2 jobs together/);
    assert.match(result.text, /Alpha body stays put/);
    assert.match(result.text, /Beta body stays put/);
  });

  test("two edits of one document do not both apply", async () => {
    const doc = await documentHub().create({ title: "Shared", markdown: SAMPLE });
    const ctx = { author: "batch-edits", documentId: doc.id };
    const result = await runTool(
      "start_jobs",
      {
        jobs: [
          { tool: "run_command", arguments: { command: "sleep 0.3; echo first-edit" } },
          { tool: "edit_document", arguments: { old_string: "lazy dog", new_string: "sleepy dog" } },
        ],
      },
      ctx,
    );
    assert.equal(result.isError, true, result.text);
    assert.match(result.text, /Job job_[0-9a-f]+ is already writing document/);
    assert.match(result.text, /edit_document was not started/);
    assert.match(docToMarkdown(doc.doc), /lazy dog/);
    assert.match(result.text, /first-edit/);
  });

  test("a background command can be picked up on a later call", async () => {
    const doc = await documentHub().create({ title: "Later", markdown: "Leave this." });
    const ctx = { author: "background", documentId: doc.id };
    const started = await runTool("start_job", { tool: "run_command", arguments: { command: "sleep 0.4; echo picked-up" } }, ctx);
    assert.match(started.text, /Started job job_[0-9a-f]+/);
    const id = /job_[0-9a-f]+/.exec(started.text)![0]!;
    const early = await runTool("get_job", { job_id: id }, ctx);
    assert.match(early.text, /is still running/);
    let later = early;
    for (let attempt = 0; attempt < 40 && /still running/.test(later.text); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      later = await runTool("get_job", { job_id: id }, ctx);
    }
    assert.match(later.text, /picked-up/);
    assert.match(later.text, /finished/);
  });

  test("cancelling a long command stops it and says so", async () => {
    const doc = await documentHub().create({ title: "Cancel", markdown: "Leave this." });
    const ctx = { author: "cancel", documentId: doc.id };
    const started = await runTool("start_job", { tool: "run_command", arguments: { command: "sleep 30; echo should-not-finish" } }, ctx);
    const id = /job_[0-9a-f]+/.exec(started.text)![0]!;
    const began = Date.now();
    const stopped = await runTool("stop_job", { job_id: id }, ctx);
    assert.match(stopped.text, /was cancelled/);
    assert.ok(Date.now() - began < 1_000, `stop took ${Date.now() - began}ms`);
    assert.doesNotMatch(stopped.text, /should-not-finish/);
    const again = await runTool("get_job", { job_id: id }, ctx);
    assert.match(again.text, /was cancelled/);
  });
});
