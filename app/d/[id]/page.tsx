import { Suspense } from "react";
import { Workspace } from "@/components/workspace/Workspace";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<div className="workspace" aria-busy="true" />}>
      <Workspace key={id} documentId={id} />
    </Suspense>
  );
}
