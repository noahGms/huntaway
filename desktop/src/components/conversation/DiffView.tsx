import type { Diff } from "../../lib/diff";

/** Unified diff with line numbers (new side) and +/- colors. */
export function DiffView({ diff, maxHeight = 360 }: { diff: Diff; maxHeight?: number }) {
  let line = 0;
  return (
    <div className="selectable overflow-auto bg-[#121418] font-mono text-[12px] leading-[1.6]" style={{ maxHeight }}>
      <table className="w-full border-collapse">
        <tbody>
          {diff.lines.map((l, i) => {
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
    </div>
  );
}
