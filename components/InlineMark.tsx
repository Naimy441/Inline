export function InlineMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="7.5 3.5 23 33" width="28" height="40" aria-hidden="true">
      <rect x="8" y="4" width="22" height="32" rx="2.5" fill="#1e293b" />
      <circle cx="25.5" cy="8.5" r="2.15" fill="var(--doc-mark)" />
      <rect x="13" y="18" width="12" height="2" rx="1" fill="#e5e7eb" />
      <rect x="13" y="23" width="12" height="2" rx="1" fill="#e5e7eb" />
      <rect x="13" y="28" width="8" height="2" rx="1" fill="#e5e7eb" />
    </svg>
  );
}
