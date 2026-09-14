"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DocumentWorkspace } from "@/components/DocumentWorkspace";
import { HomePage } from "@/components/HomePage";

function InlineApp() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const documentId = searchParams.get("doc");

  if (documentId) {
    return <DocumentWorkspace key={documentId} documentId={documentId} onGoHome={() => router.push("/")} />;
  }

  return <HomePage onOpenDocument={(id) => router.push(`/?doc=${encodeURIComponent(id)}`)} />;
}

export default function Home() {
  return (
    <Suspense fallback={<HomePage onOpenDocument={() => undefined} />}>
      <InlineApp />
    </Suspense>
  );
}
