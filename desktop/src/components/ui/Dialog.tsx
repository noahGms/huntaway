import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = 520,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  width?: number;
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/55 animate-fade-in" />
        <RD.Content
          className="fixed left-1/2 top-[12vh] z-50 max-h-[76vh] -translate-x-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-[0_24px_60px_rgba(0,0,0,0.5)] animate-fade-in focus:outline-none"
          style={{ width }}
          aria-describedby={description ? undefined : undefined}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <RD.Title className="text-[16px] font-semibold">{title}</RD.Title>
              {description && <RD.Description className="mt-1 text-[12.5px] text-muted">{description}</RD.Description>}
            </div>
            <RD.Close className="rounded-lg p-1 text-muted hover:bg-surface-high hover:text-text" aria-label="Close">
              <X size={16} />
            </RD.Close>
          </div>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-faint">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-[10px] border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-faint focus:border-[#3a414c] focus:outline-none";
