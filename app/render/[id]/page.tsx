import { Suspense } from "react";
import { HeadlessPages } from "@/components/render/HeadlessPages";

/** The document's pages, with no editor chrome, for a headless screenshot. */
export default async function RenderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<div data-render-status="loading" />}>
      <HeadlessPages documentId={id} />
    </Suspense>
  );
}
