import * as CM from "@radix-ui/react-context-menu";
import * as DM from "@radix-ui/react-dropdown-menu";
import { createContext, useContext, type ReactNode } from "react";

const CONTENT = "z-50 min-w-[200px] rounded-xl border border-border bg-surface p-1 shadow-[0_16px_40px_rgba(0,0,0,0.45)] animate-fade-in";

/** Items render as context menu items inside a `ContextMenu`. */
const InContext = createContext(false);

export function Menu({ trigger, children, align = "end" }: { trigger: ReactNode; children: ReactNode; align?: "start" | "end" }) {
  return (
    <DM.Root>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content align={align} sideOffset={6} className={CONTENT}>
          {children}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

/** Opens on right click on `children`. */
export function ContextMenu({ children, content }: { children: ReactNode; content: ReactNode }) {
  return (
    <CM.Root>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content className={CONTENT}>
          <InContext.Provider value={true}>{content}</InContext.Provider>
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}

export function MenuItem({ icon, children, onSelect, danger, disabled }: { icon?: ReactNode; children: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean }) {
  const Item = useContext(InContext) ? CM.Item : DM.Item;
  return (
    <Item
      disabled={disabled}
      onSelect={onSelect}
      className={`flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-high ${danger ? "text-error" : "text-text"}`}
    >
      <span className="text-muted">{icon}</span>
      {children}
    </Item>
  );
}

export function MenuSeparator() {
  const Separator = useContext(InContext) ? CM.Separator : DM.Separator;
  return <Separator className="my-1 h-px bg-border" />;
}
