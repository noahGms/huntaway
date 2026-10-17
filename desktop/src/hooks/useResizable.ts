// Width of a side column, dragged by a handle and remembered.

import { useCallback, useState } from "react";

export function useResizable(key: string, initial: number, min: number, max: number, side: "left" | "right") {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(key));
    return saved >= min && saved <= max ? saved : initial;
  });
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const start = width;
      const move = (ev: MouseEvent) => {
        const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
        const next = Math.min(max, Math.max(min, start + delta));
        setWidth(next);
        localStorage.setItem(key, String(next));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.style.cursor = "";
      };
      document.body.style.cursor = "col-resize";
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [width, key, min, max, side],
  );
  return { width, onMouseDown };
}
