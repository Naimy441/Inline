import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { desktopBootScript, themeBootScript } from "@/lib/client/bootScripts";
import { TooltipLayer } from "@/components/ui/Tooltip";
import "katex/dist/katex.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Inline",
  description: "A document editor with Claude built in.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Draw under the notch and home indicator; the layout pads with safe-area insets.
  viewportFit: "cover",
  // Android: the keyboard shrinks the layout instead of covering it.
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f2" },
    { media: "(prefers-color-scheme: dark)", color: "#1b1b1a" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript + desktopBootScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=EB+Garamond:ital,wght@0,400;0,600;1,400&family=Merriweather:ital,wght@0,400;0,700;1,400&family=Roboto+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        {children}
        <TooltipLayer />
      </body>
    </html>
  );
}
