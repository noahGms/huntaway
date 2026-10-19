import * as Tabs from "@radix-ui/react-tabs";
import { Activity as ActivityIcon, FileText, SquareTerminal, X } from "lucide-react";
import type { Conversation } from "../../lib/conversations";
import { useUi, type PanelTab } from "../../store/ui";
import { IconButton } from "../ui/Button";
import { ActivityTab } from "./ActivityTab";
import { FilesTab } from "./FilesTab";
import { TerminalTab } from "./TerminalTab";

export function RightPanel({ conv }: { conv: Conversation }) {
  const { panelTab, setPanelTab, togglePanel } = useUi();
  const tabs: { id: PanelTab; label: string; icon: React.ReactNode; disabled?: boolean }[] = [
    { id: "activity", label: "Details", icon: <ActivityIcon size={14} /> },
    { id: "files", label: "Files", icon: <FileText size={14} /> },
    { id: "terminal", label: "Terminal", icon: <SquareTerminal size={14} />, disabled: !conv.live && !conv.cwd },
  ];
  const current = !conv.live && !conv.cwd && panelTab === "terminal" ? "activity" : panelTab;
  return (
    <Tabs.Root value={current} onValueChange={(v) => setPanelTab(v as PanelTab)} className="flex h-full flex-col border-l border-border bg-surface">
      <div className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-border pl-3 pr-3">
        <Tabs.List className="no-drag flex h-full min-w-0 flex-1 items-stretch gap-1">
          {tabs.map((t) => (
            <Tabs.Trigger
              key={t.id}
              value={t.id}
              disabled={t.disabled}
              className="flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-2 text-[12.5px] text-muted transition-colors hover:text-text disabled:opacity-35 data-[state=active]:border-blocked data-[state=active]:text-text"
            >
              {t.icon}
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <IconButton label="Close panel" onClick={togglePanel} className="no-drag">
          <X size={15} />
        </IconButton>
      </div>
      <Tabs.Content value="activity" className="min-h-0 flex-1 overflow-y-auto">
        <ActivityTab conv={conv} />
      </Tabs.Content>
      <Tabs.Content value="files" className="min-h-0 flex-1 overflow-y-auto">
        <FilesTab conv={conv} />
      </Tabs.Content>
      <Tabs.Content value="terminal" className="min-h-0 flex-1" forceMount hidden={current !== "terminal"}>
        {current === "terminal" && <TerminalTab key={conv.key} conv={conv} />}
      </Tabs.Content>
    </Tabs.Root>
  );
}
