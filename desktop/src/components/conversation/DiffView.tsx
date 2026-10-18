import { useState } from "react";
import type { Diff } from "../../lib/diff";

/** Lines rendered before a "show more" button (huge diffs are slow to draw). */
const CHUNK = 400;

/** Unified diff with line numbers (new side) and +/- colors. */
export function DiffView({ diff, maxHeight = 360 }: { diff: Diff; maxHeight?: number }) {
  const [shown, setShown] = useState(CHUNK);
  const hidden = diff.lines.length - shown;
  let line = 0;
  return (
    <div className="selectable overflow-auto bg-[#121418] font-mono text-[12px] leading-[1.6]" style={{ maxHeight }}>
      <table className="w-full border-collapse">
        <tbody>
          {diff.lines.slice(0, shown).map((l, i) => {
            if (l.type === "hunk") {
              return (
                <tr key={i} className="bg-surface-high/50 text-faint">
                  <td className="w-10 select-none px-2 text-right" />
                  <td className="px-2 py-0.5" colSpan={2}>
                    {l.text}
                  </td>
                </tr>
              );
            }
            if (l.type !== "del") line++;
            const bg = l.type === "add" ? "bg-done/[0.09]" : l.type === "del" ? "bg-error/[0.09]" : "";
            const sign = l.type === "add" ? "+" : l.type === "del" ? "−" : " ";
            const color = l.type === "add" ? "text-done" : l.type === "del" ? "text-error" : "text-faint";
            return (
              <tr key={i} className={bg}>
                <td className="w-10 select-none px-2 text-right align-top text-faint/70">{l.type === "del" ? "" : line}</td>
                <td className={`w-4 select-none align-top ${color}`}>{sign}</td>
                <td className={`whitespace-pre pr-3 ${l.type === "del" ? "text-[#d9a6a4]" : "text-[#d4cfc6]"}`}>{l.text || " "}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {hidden > 0 && (
        <button onClick={() => setShown((n) => n + CHUNK * 5)} className="w-full border-t border-border py-1.5 font-sans text-[11.5px] text-muted hover:text-text">
          Show {Math.min(hidden, CHUNK * 5)} more lines ({hidden} hidden)
        </button>
      )}
    </div>
  );
}
