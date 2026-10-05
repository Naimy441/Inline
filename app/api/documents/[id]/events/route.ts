import { route, routeDocument, sse } from "@/lib/server/http";
import { documentHub } from "@/lib/server/hub";

type Context = { params: Promise<{ id: string }> };

/**
 * Live document stream. A client that already holds the document passes
 * ?version=N and receives the steps it missed; otherwise it gets a reset
 * with the full document. Every later change arrives as it happens.
 */
export const GET = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const param = new URL(request.url).searchParams.get("version");
  const version = param == null ? null : Number(param);
  documentHub().activeDocumentId = doc.id;
  doc.touch();
  return sse(request, (send) => {
    const missed = version != null && Number.isInteger(version) ? doc.stepsSince(version) : null;
    if (missed) {
      if (missed.steps.length) send({ type: "steps", version: doc.version, steps: missed.steps, clientIDs: missed.clientIDs, hunks: doc.hunksJSON() });
      send({ type: "meta", meta: doc.meta });
      send({ type: "comments", comments: doc.comments });
      send({ type: "activity", activity: doc.activity });
    } else {
      send({ type: "snapshot", snapshot: doc.snapshot() });
    }
    return doc.subscribe((event) => send(event));
  });
});
