import { z } from "zod";
import { EditError } from "@/lib/doc/editing";
import { LockedContentError } from "@/lib/doc/merge";
import { StepConflictError } from "@/lib/server/hub";

/** Small helpers shared by the API route handlers. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what = "Not found") => new HttpError(404, what);

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, { ...init, headers: { "Cache-Control": "no-store", ...init?.headers } });
}

export async function readJson<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  }
  return parsed.data;
}

type Handler<C> = (request: Request, context: C) => Promise<Response>;

/** Wrap a route handler so thrown errors become JSON responses. */
export function route<C>(handler: Handler<C>): Handler<C> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message, ...error.extra }, { status: error.status });
      if (error instanceof StepConflictError) return json({ error: "Version conflict.", version: error.version }, { status: 409 });
      if (error instanceof EditError || error instanceof LockedContentError) return json({ error: error.message }, { status: 422 });
      if (error instanceof Error && error.message === "Invalid id.") return json({ error: "Invalid id." }, { status: 400 });
      console.error("[inline] request failed", error);
      return json({ error: "Something went wrong on the server." }, { status: 500 });
    }
  };
}

/**
 * A Server-Sent Events response. `start` receives a `send` function and
 * returns a cleanup callback, called when the client disconnects.
 */
export function sse(request: Request, start: (send: (event: unknown, id?: number) => void) => () => void) {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        cleanup?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const send = (event: unknown, id?: number) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${id != null ? `id: ${id}\n` : ""}data: ${JSON.stringify(event)}\n\n`));
        } catch {
          close();
        }
      };
      controller.enqueue(encoder.encode("retry: 1500\n\n"));
      cleanup = start(send);
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          close();
        }
      }, 15_000);
      request.signal.addEventListener("abort", close);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      cleanup?.();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

type IdParams = { params: Promise<{ id: string }> };

/** The live document named by a route's [id] segment, or a 404. */
export async function routeDocument(context: IdParams, options: { allowTrashed?: boolean } = {}) {
  const { documentHub } = await import("@/lib/server/hub");
  const { id } = await context.params;
  const doc = await documentHub().get(id);
  if (!doc || (doc.meta.trashedAt && !options.allowTrashed)) throw notFound("Document not found.");
  return doc;
}
