export function InlineLogo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="logo">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="var(--accent)" />
      <path d="M8 7.5h8M8 12h8M8 16.5h5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
