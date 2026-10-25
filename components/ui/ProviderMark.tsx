import type { AgentProvider } from "@/lib/agent/providers";

/**
 * The mark of the assistant that a chat uses. Claude's keeps its brand colour;
 * Codex's takes the current text colour, like the other toolbar icons.
 */
export function ProviderMark({ provider, size = 16 }: { provider: AgentProvider; size?: number }) {
  if (provider === "codex") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="provider-mark">
        <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M7 9.5 10.5 12 7 14.5M12.5 15h4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="provider-mark">
      <g stroke="#D97757" strokeWidth="2.6" strokeLinecap="round">
        {Array.from({ length: 8 }, (_, index) => (
          <line key={index} x1="12" y1="3.5" x2="12" y2="10" transform={`rotate(${index * 45} 12 12)`} />
        ))}
      </g>
    </svg>
  );
}
