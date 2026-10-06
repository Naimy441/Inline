"use client";

import MarkdownIt from "markdown-it";
import { memo, useMemo } from "react";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: true });

const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  const href = String(token.attrGet("href") ?? "");
  if (/^https?:/i.test(href)) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  }
  return defaultLink(tokens, idx, options, env, self);
};

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]!;
  const lang = md.utils.escapeHtml(token.info.trim().split(/\s+/)[0] ?? "");
  return `<div class="md-code"><div class="md-code-head"><span>${lang || "text"}</span><button type="button" class="md-copy" data-copy>Copy</button></div><pre><code>${md.utils.escapeHtml(token.content)}</code></pre></div>`;
};

/** Close an unterminated code fence while a reply is still streaming, so it renders as code. */
function balance(text: string) {
  const fences = text.match(/^```/gm)?.length ?? 0;
  return fences % 2 ? `${text}\n\`\`\`` : text;
}

export const Markdown = memo(function Markdown({ text, streaming, caret }: { text: string; streaming?: boolean; caret?: boolean }) {
  const html = useMemo(() => md.render(streaming ? balance(text) : text), [text, streaming]);
  return (
    <div
      className={caret ? "md is-writing" : "md"}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest("[data-copy]");
        if (!button) return;
        const code = button.closest(".md-code")?.querySelector("code")?.textContent ?? "";
        void navigator.clipboard.writeText(code).then(() => {
          button.textContent = "Copied";
          setTimeout(() => (button.textContent = "Copy"), 1200);
        });
      }}
    />
  );
});
