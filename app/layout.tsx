import type { Metadata } from "next";
import type { ReactNode } from "react";
import { docMarkBootScript } from "@/lib/docMark";
import { documentTitleBootScript } from "@/lib/documentStore";
import "./globals.css";

export const metadata: Metadata = {
  title: "Inline",
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
              `try{var w=Number(localStorage.getItem('inline-chat-width'));if(isFinite(w)&&w>=320)document.documentElement.style.setProperty('--chat-width',Math.round(w)+'px')}catch(e){}` +
              docMarkBootScript +
              documentTitleBootScript,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
