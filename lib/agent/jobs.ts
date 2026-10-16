import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolResult } from "@/lib/agent/tools";

/**
 * Claude's tool calls normally run one at a time and cannot be stopped.
 * Jobs add three abilities on top of that:
 * - stop_job cancels a running job; it stops promptly and reports that it was cancelled.
 * - start_job runs a tool in the background and returns a job id. get_job picks up the result, or says it is still running.
 * - start_jobs runs independent jobs together. Reads and screenshots may overlap. Two jobs that edit the same document do not: the second is rejected and the error names the job already writing.
 *
 * Calling a tool directly still waits for that one tool.
 */

const CONTROL_TOOLS = new Set(["start_job", "get_job", "stop_job", "start_jobs"]);

export type JobExecute = (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

type ToolInfo = { write: boolean };

type Batch = {
  running: Set<string>;
  names: Map<string, string>;
  together: string[] | null;
};

type InternalJob = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  author: string;
  ctx: ToolContext;
  state: "running" | "done" | "cancelled";
  result?: ToolResult;
  targets: string[];
  controller: AbortController;
  done: Promise<ToolResult>;
  batch: Batch;
};

type Planned =
  | { kind: "run"; job: InternalJob }
  | { kind: "rejected"; text: string }
  | { kind: "error"; text: string };

function jobId() {
  return `job_${randomBytes(4).toString("hex")}`;
}

function writeTargets(name: string, args: Record<string, unknown>, ctx: ToolContext, write: boolean) {
  if (!write) return [];
  if (name === "move_documents" && Array.isArray(args.moves)) {
    const ids = args.moves
      .map((move) => (move && typeof move === "object" && "document_id" in move && typeof (move as { document_id?: unknown }).document_id === "string" ? (move as { document_id: string }).document_id : ""))
      .filter(Boolean);
    if (ids.length) return [...new Set(ids)];
  }
  const explicit = typeof args.document_id === "string" ? args.document_id : "";
  const id = explicit || ctx.documentId || "";
  return id ? [id] : [];
}

function cancelledText(job: { id: string; tool: string }) {
  return `Job ${job.id} (${job.tool}) was cancelled.`;
}

export class JobRunner {
  private jobs = new Map<string, InternalJob>();
  /** Document id -> the job id currently writing it. */
  private writers = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly execute: JobExecute,
    private readonly lookup: (name: string) => Promise<ToolInfo | undefined>,
  ) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private release(job: InternalJob) {
    for (const id of job.targets) {
      if (this.writers.get(id) === job.id) this.writers.delete(id);
    }
    job.batch.running.delete(job.id);
  }

  private launch(job: InternalJob) {
    job.done = (async () => {
      job.batch.running.add(job.id);
      if (job.batch.running.size > 1) job.batch.together = [...job.batch.running];
      const ctx: ToolContext = { ...job.ctx, signal: job.controller.signal };
      let result: ToolResult;
      try {
      if (job.state === "cancelled" || job.controller.signal.aborted) result = { text: cancelledText(job), isError: true };
        else result = await this.execute(job.tool, job.args, ctx);
      } catch (error) {
        result = { text: error instanceof Error ? error.message : String(error), isError: true };
      }
      if (job.state === "cancelled" || job.controller.signal.aborted) {
        job.state = "cancelled";
        job.result = { text: cancelledText(job), isError: true };
      } else {
        job.state = "done";
        job.result = result;
      }
      this.release(job);
      return job.result;
    })();
  }

  /** Register every job before any of them runs, so two writes of one document cannot both start. */
  private async admit(requests: Array<{ tool: string; arguments?: Record<string, unknown> }>, ctx: ToolContext, batch: Batch): Promise<Planned[]> {
    return this.exclusive(async () => {
      const planned: Planned[] = [];
      for (const request of requests) {
        const info = await this.lookup(request.tool);
        if (!info) {
          planned.push({ kind: "error", text: `Unknown tool ${request.tool}.` });
          continue;
        }
        if (CONTROL_TOOLS.has(request.tool)) {
          planned.push({ kind: "error", text: `${request.tool} cannot start another job. Call the tool you want directly, or name that tool here.` });
          continue;
        }
        const args = request.arguments ?? {};
        const targets = writeTargets(request.tool, args, ctx, info.write);
        const conflict = targets.map((id) => this.writers.get(id)).find((id): id is string => Boolean(id));
        if (conflict) {
          const writing = this.jobs.get(conflict);
          const documentId = targets.find((id) => this.writers.get(id) === conflict) ?? targets[0];
          planned.push({
            kind: "rejected",
            text: `Job ${conflict} is already writing document ${documentId}${writing ? ` (${writing.tool})` : ""}. This ${request.tool} was not started.`,
          });
          continue;
        }
        const job: InternalJob = {
          id: jobId(),
          tool: request.tool,
          args,
          author: ctx.author,
          state: "running",
          targets,
          controller: new AbortController(),
          done: Promise.resolve({ text: "" }),
          batch,
          ctx,
        };
        // ctx on the job is the caller's context without this job's signal; launch adds the signal.
        for (const id of targets) this.writers.set(id, job.id);
        this.jobs.set(job.id, job);
        batch.names.set(job.id, job.tool);
        this.launch(job);
        planned.push({ kind: "run", job });
      }
      this.trim(ctx.author);
      return planned;
    });
  }

  private trim(author: string) {
    const finished = [...this.jobs.values()].filter((job) => job.author === author && job.state !== "running");
    while (finished.length > 40) {
      const oldest = finished.shift();
      if (oldest) this.jobs.delete(oldest.id);
    }
  }

  async start(request: { tool: string; arguments?: Record<string, unknown> }, ctx: ToolContext): Promise<ToolResult> {
    const batch: Batch = { running: new Set(), names: new Map(), together: null };
    const [planned] = await this.admit([request], ctx, batch);
    if (!planned || planned.kind !== "run") return { text: planned?.text ?? "The job was not started.", isError: true };
    const job = planned.job;
    return {
      text: `Started job ${job.id} (${job.tool}). It is running.\nCall get_job with this id for the result, or stop_job to cancel it.`,
    };
  }

  async startMany(requests: Array<{ tool: string; arguments?: Record<string, unknown> }>, ctx: ToolContext): Promise<ToolResult> {
    const batch: Batch = { running: new Set(), names: new Map(), together: null };
    const planned = await this.admit(requests, ctx, batch);
    await Promise.all(planned.filter((item): item is { kind: "run"; job: InternalJob } => item.kind === "run").map((item) => item.job.done));
    return this.report(planned, batch);
  }

  get(id: string, author: string): ToolResult {
    const job = this.jobs.get(id);
    if (!job || job.author !== author) return { text: `No job ${id}.`, isError: true };
    if (job.state === "running") return { text: `Job ${job.id} (${job.tool}) is still running.` };
    if (job.state === "cancelled") return { text: cancelledText(job), isError: true };
    const result = job.result ?? { text: "" };
    return { ...result, text: `Job ${job.id} (${job.tool}) finished.\n${result.text}` };
  }

  stop(id: string, author: string): ToolResult {
    const job = this.jobs.get(id);
    if (!job || job.author !== author) return { text: `No job ${id}.`, isError: true };
    if (job.state !== "running") {
      const detail = job.result?.text ? `\n${job.result.text}` : "";
      return { text: `Job ${job.id} (${job.tool}) already finished, so it was not cancelled.${detail}`, isError: true };
    }
    job.state = "cancelled";
    job.result = { text: cancelledText(job), isError: true };
    job.controller.abort();
    // The write lock stays until the tool actually returns, so a second edit cannot overlap the one being cancelled.
    return job.result;
  }

  private report(planned: Planned[], batch: Batch): ToolResult {
    const parts: string[] = [];
    const images: NonNullable<ToolResult["images"]> = [];
    const ran = planned.filter((item): item is { kind: "run"; job: InternalJob } => item.kind === "run");
    if (ran.length > 1) parts.push(`Started ${ran.length} jobs together.`);
    if (batch.together && batch.together.length > 1) {
      parts.push(`Ran at the same time: ${batch.together.map((id) => `${id} (${batch.names.get(id) ?? "job"})`).join(", ")}.`);
    }
    let failed = false;
    for (const item of planned) {
      if (item.kind !== "run") {
        failed = true;
        parts.push(item.text);
        continue;
      }
      const result = item.job.result ?? { text: "" };
      if (result.isError || item.job.state === "cancelled") failed = true;
      const status = item.job.state === "cancelled" ? "was cancelled" : result.isError ? "failed" : "finished";
      parts.push(`Job ${item.job.id} (${item.job.tool}) ${status}.\n${result.text}`);
      if (result.images) images.push(...result.images);
    }
    return { text: parts.join("\n\n"), ...(failed ? { isError: true } : {}), ...(images.length ? { images } : {}) };
  }
}

async function defaultLookup(name: string): Promise<ToolInfo | undefined> {
  const { TOOLS } = await import("@/lib/agent/tools");
  const tool = TOOLS.find((item) => item.name === name);
  return tool ? { write: tool.write } : undefined;
}

async function defaultExecute(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  const { runTool } = await import("@/lib/agent/tools");
  return runTool(name, args, ctx);
}

export function createJobRunner(execute: JobExecute = defaultExecute, lookup: (name: string) => Promise<ToolInfo | undefined> = defaultLookup) {
  return new JobRunner(execute, lookup);
}

let shared: JobRunner | null = null;

export function jobRunner() {
  shared ??= createJobRunner();
  return shared;
}

export function resetJobsForTests() {
  shared = null;
}

type Shape = z.ZodRawShape;

const toolNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, "tool name");
const toolArgsSchema = z.record(z.string(), z.unknown()).optional();
const jobIdSchema = z.string().describe("The job id returned by start_job.");
const jobsSchema = z
  .array(z.object({ tool: toolNameSchema, arguments: toolArgsSchema }))
  .min(1)
  .max(8)
  .describe("Tools to run at the same time. Each has a tool name and its arguments.");

export function jobTools(kit: {
  defineTool: <S extends Shape>(tool: ToolDefinition<S>) => ToolDefinition<S>;
  ok: (text: string) => ToolResult;
  fail: (text: string) => ToolResult;
}) {
  const toolName = toolNameSchema;
  const toolArgs = toolArgsSchema;
  return [
    kit.defineTool({
      name: "start_job",
      title: "Start a background job",
      description:
        "Start one tool and keep going. The call returns a job id immediately, while the tool is still running. Later, get_job with that id returns the result, or says the job is still running. stop_job cancels it. Use this when you do not want to wait, for example a screenshot or a long command. To run several tools at once, use start_jobs. Calling a tool by its own name still waits for that one tool.",
      shape: {
        tool: toolName.describe("The tool to run, such as read_document, screenshot_page, or run_command."),
        arguments: toolArgs.describe("Arguments for that tool, the same object you would pass if you called it directly."),
      },
      write: false,
      async handler(args, ctx) {
        return jobRunner().start({ tool: args.tool, arguments: args.arguments }, ctx);
      },
    }),
    kit.defineTool({
      name: "get_job",
      title: "Get a job result",
      description: "Pick up a job started with start_job. Returns the tool's result, or says the job is still running. A cancelled job says it was cancelled.",
      shape: { job_id: jobIdSchema },
      write: false,
      handler(args, ctx) {
        return Promise.resolve(jobRunner().get(args.job_id, ctx.author));
      },
    }),
    kit.defineTool({
      name: "stop_job",
      title: "Stop a job",
      description: "Cancel a running job when you no longer want that work. The job stops promptly and reports that it was cancelled.",
      shape: { job_id: jobIdSchema },
      write: false,
      handler(args, ctx) {
        return Promise.resolve(jobRunner().stop(args.job_id, ctx.author));
      },
    }),
    kit.defineTool({
      name: "start_jobs",
      title: "Run jobs together",
      description:
        "Start several independent tools at once and wait for them. Reads and screenshots of different pages may run at the same time. Two jobs that edit the same document must not: the second is rejected, and the error names the job already writing that document. Pass each tool and the arguments you would have passed to it. For one tool you want to leave running, use start_job instead.",
      shape: {
        jobs: jobsSchema,
      },
      write: false,
      async handler(args, ctx) {
        return jobRunner().startMany(
          args.jobs.map((job) => ({ tool: job.tool, arguments: job.arguments })),
          ctx,
        );
      },
    }),
  ];
}
