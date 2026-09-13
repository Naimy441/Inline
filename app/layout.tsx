import type { Metadata } from "next";
import type { ReactNode } from "react";
import { docMarkBootScript } from "@/lib/docMark";
import "./globals.css";

export const metadata: Metadata = {
  title: "Untitled document - Inline",
  description: "A Google Docs-style paginated document editor.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              `try{var t=localStorage.getItem('inline-theme');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.dataset.theme='dark'}catch(e){}` +
              docMarkBootScript,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
