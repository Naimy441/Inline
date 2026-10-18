import { Suspense } from "react";
import { HeadlessPages } from "@/components/render/HeadlessPages";
import { THEME_KEY } from "@/lib/client/bootScripts";
import { pageAppearance } from "@/lib/pdf/screenAppearance";
import { savedAppearance } from "@/lib/server/appearance";

/** The document's pages, with no editor chrome, for a headless screenshot. */
export default async function RenderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ theme?: string | string[]; preview?: string | string[] }> }) {
  const { id } = await params;
  const { theme, preview } = await searchParams;
  const asked = pageAppearance(Array.isArray(theme) ? theme[0] : theme);
  const previewToken = Array.isArray(preview) ? preview[0] : preview;
  const appearance = asked ?? (await savedAppearance());
  // Set the appearance before paint. The root boot script only knows this browser, which has no saved appearance of its own.
  const boot = `try{document.documentElement.dataset.theme=${JSON.stringify(appearance)};localStorage.setItem(${JSON.stringify(THEME_KEY)},${JSON.stringify(appearance)})}catch(e){}`;
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: boot }} />
      <Suspense fallback={<div data-render-status="loading" />}>
        <HeadlessPages documentId={id} appearance={appearance} preview={previewToken} />
      </Suspense>
    </>
  );
}
