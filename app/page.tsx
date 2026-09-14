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

function BootShell() {
  return <div className="app" aria-busy="true" />;
}

export default function Home() {
  return (
    <Suspense fallback={<BootShell />}>
      <InlineApp />
    </Suspense>
  );
}
