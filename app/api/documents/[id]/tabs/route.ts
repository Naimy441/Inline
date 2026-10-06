import { z } from "zod";
import { HttpError, json, readJson, route, routeDocument } from "@/lib/server/http";
import { documentHub } from "@/lib/server/hub";

type Context = { params: Promise<{ id: string }> };

/** The tabs of the document this tab belongs to. */
export const GET = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  return json({ tabs: await documentHub().tabs(doc.id) });
});

const CreateBody = z.object({ title: z.string().max(100).optional(), markdown: z.string().max(5_000_000).optional() });

/** Adds a tab after the last one. */
export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, CreateBody);
  const hub = documentHub();
  const tab = await hub.createTab(doc.id, body);
  return json({ id: tab.id, tabs: await hub.tabs(doc.id) }, { status: 201 });
});

const PatchBody = z.object({ title: z.string().max(100).optional(), index: z.number().int().min(1).optional() });

/** Renames or moves this tab. */
export const PATCH = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, PatchBody);
  const hub = documentHub();
  try {
    if (body.title !== undefined) await hub.renameTab(doc.id, body.title);
    if (body.index !== undefined) await hub.moveTab(doc.id, body.index);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  return json({ tabs: await hub.tabs(doc.id) });
});

/** Deletes this tab for good (not the first tab). */
export const DELETE = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  const hub = documentHub();
  const root = doc.meta.parentId;
  try {
    await hub.deleteTab(doc.id);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  return json({ tabs: root ? await hub.tabs(root) : [] });
});
