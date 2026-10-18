import { Fingerprint, Link2, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { app, errorMessage } from "../api/client";
import type { PairPreview } from "../api/types";
import { Button } from "../components/ui/Button";
import { Dialog, Field, inputClass } from "../components/ui/Dialog";
import { useUi } from "../store/ui";

export function PairDialog() {
  const { pair, closePair, toast, setView } = useUi();
  const [link, setLink] = useState("");
  const [preview, setPreview] = useState<PairPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (pair.open) {
      setLink(pair.link ?? "");
      setError(null);
    }
  }, [pair.open, pair.link]);

  // Debounced, and only the latest inspection counts (results can arrive out of order).
  const inspectSeq = useRef(0);
  useEffect(() => {
    const seq = ++inspectSeq.current;
    setPreview(null);
    setError(null);
    if (!link.trim()) return;
    const t = setTimeout(() => {
      app
        .inspectPairing(link.trim())
        .then((p) => seq === inspectSeq.current && setPreview(p))
        .catch((e) => seq === inspectSeq.current && setError(errorMessage(e)));
    }, 300);
    return () => clearTimeout(t);
  }, [link]);

  const submit = async () => {
    setBusy(true);
    try {
      const record = await app.pairMachine(link.trim());
      toast(`${record.name} added`, "success");
      closePair();
      setView("servers");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={pair.open} onOpenChange={(o) => !o && closePair()} title="Add machine" description="Pair a server running huntawayd (reachable over Tailscale or the local network).">
      <ol className="mb-4 space-y-1.5 text-[12.5px] text-muted">
        <li>
          1. On the machine, run <code className="selectable rounded bg-bg px-1.5 py-0.5 font-mono text-[11.5px] text-text">huntawayd pair --full --link</code>
        </li>
        <li>2. Paste the link it prints (valid for 5 minutes).</li>
      </ol>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (preview) void submit();
        }}
      >
        <Field label="Pairing link">
          <div className="relative">
            <Link2 size={14} className="absolute left-3 top-3 text-faint" />
            <textarea
              autoFocus
              value={link}
              onChange={(e) => setLink(e.target.value)}
              rows={3}
              placeholder="huntaway://pair/…"
              className={`${inputClass} resize-none pl-8 font-mono text-[11.5px] leading-relaxed`}
            />
          </div>
        </Field>
        {preview && (
          <div className="space-y-1.5 rounded-xl border border-border bg-bg px-3.5 py-3 text-[12.5px]">
            <div className="flex items-center gap-2 font-medium">
              <ShieldCheck size={14} className="text-done" /> {preview.machine_name}
            </div>
            <div className="text-muted">Addresses: {preview.addresses.join(", ")}</div>
            <div className="flex items-center gap-1.5 text-faint">
              <Fingerprint size={12} />
              <span className="selectable truncate font-mono text-[11px]">{preview.fingerprint}</span>
            </div>
            <div className="text-[11.5px] text-faint">The machine identity (fingerprint and signature) is verified before the token is saved.</div>
          </div>
        )}
        {error && <p className="text-[12.5px] text-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={closePair}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!preview}>
            Pair
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
