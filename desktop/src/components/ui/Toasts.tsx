import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { useUi } from "../../store/ui";

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto flex max-w-[520px] items-center gap-2.5 rounded-xl border border-border bg-surface-high px-3.5 py-2.5 text-[12.5px] shadow-[0_12px_30px_rgba(0,0,0,0.45)] animate-fade-in"
        >
          {t.kind === "error" ? <AlertCircle size={15} className="text-error" /> : t.kind === "success" ? <CheckCircle2 size={15} className="text-done" /> : <Info size={15} className="text-muted" />}
          <span className="selectable">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="ml-1 text-faint hover:text-text" aria-label="Close">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
