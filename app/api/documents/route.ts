import { z } from "zod";
import { json, readJson, route } from "@/lib/server/http";
import { documentHub } from "@/lib/server/hub";

export const GET = route(async (request) => {
  const trashed = new URL(request.url).searchParams.get("trashed") === "1";
  return json({ documents: await documentHub().list({ trashed }) });
});

const CreateBody = z.object({
  title: z.string().max(300).optional(),
  markdown: z.string().max(5_000_000).optional(),
  doc: z.unknown().optional(),
  settings: z.unknown().optional(),
});

export const POST = route(async (request) => {
  const body = await readJson(request, CreateBody);
  const doc = await documentHub().create(body);
  return json({ document: doc.snapshot() }, { status: 201 });
});
