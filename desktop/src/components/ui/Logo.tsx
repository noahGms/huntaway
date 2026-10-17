/** The Huntaway mark: tan chevron, cream dots (docs/logo/huntaway.svg). */
export function Logo({ size = 26, tile = true }: { size?: number; tile?: boolean }) {
  const mark = (
    <svg viewBox="200 300 640 424" width={tile ? size * 0.62 : size} height={tile ? size * 0.62 : size} aria-hidden>
      <path d="M250 360 L402 512 L250 664" fill="none" stroke="#E39B4B" strokeWidth="80" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="540" cy="512" r="40" fill="#F3E6D3" opacity=".3" />
      <circle cx="660" cy="512" r="40" fill="#F3E6D3" opacity=".6" />
      <circle cx="780" cy="512" r="40" fill="#F3E6D3" />
    </svg>
  );
  if (!tile) return mark;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center border border-border bg-ink"
      style={{ width: size, height: size, borderRadius: size * 0.26 }}
    >
      {mark}
    </span>
  );
}
