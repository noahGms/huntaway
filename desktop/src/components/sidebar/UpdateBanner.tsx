import { ArrowDownCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "../../api/client";
import { startUpdateChecks, useUpdates } from "../../lib/updates";
import { useUi } from "../../store/ui";
import { Button } from "../ui/Button";

/** "Update x.y.z ready": the download already happened in the background. */
export function UpdateBanner() {
  const { ready, dismissed, restart, dismiss } = useUpdates();
  const [busy, setBusy] = useState(false);
  useEffect(() => startUpdateChecks(), []);
  if (!ready || dismissed) return null;
  return (
    <div className="mx-2 mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[12px] animate-fade-in">
      <ArrowDownCircle size={14} className="shrink-0 text-done" />
      <span className="min-w-0 flex-1 truncate text-muted">
        Update <span className="text-text">{ready.version}</span> ready
      </span>
      <Button
        size="sm"
        variant="primary"
        className="!h-6 !px-2"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await restart();
          } catch (e) {
            useUi.getState().toast(`Update failed: ${errorMessage(e)}`, "error");
            setBusy(false);
          }
        }}
      >
        Restart
      </Button>
      <button onClick={dismiss} className="shrink-0 text-faint hover:text-text" aria-label="Later" title="Later">
        <X size={13} />
      </button>
    </div>
  );
}
