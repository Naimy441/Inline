import { Workspace } from "@/components/workspace/Workspace";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // No Suspense fallback: React keeps one on screen for 300ms after the page is ready.
  return <Workspace key={id} documentId={id} />;
}
