export function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 rounded-xl px-1 py-2.5 text-left"
    >
      <span>
        <span className="block text-[13px] text-text">{label}</span>
        {description && <span className="mt-0.5 block text-[12px] text-muted">{description}</span>}
      </span>
      <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-accent" : "bg-surface-high border border-border"}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${checked ? "left-[18px] bg-on-accent" : "left-0.5 bg-muted"}`} />
      </span>
    </button>
  );
}
