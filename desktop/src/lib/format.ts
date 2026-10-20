// Display helpers: dates, durations, token counts. English labels, with the
// system's English locale for numbers and dates (en-US otherwise).

/** `en-GB`, `en-US`…: the first English locale of the system. */
export const LOCALE =
  (typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]).find((l) => /^en\b/i.test(l)) : undefined) ?? "en-US";

export function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** `14:28`, `Yesterday`, `Tue`, `Oct 12` depending on the age. */
export function shortTime(iso: string | null | undefined, now = Date.now()): string {
  const t = parseTime(iso);
  if (t === null) return "";
  const d = new Date(t);
  const today = startOfDay(now);
  if (t >= today) return d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
  if (t >= today - 86_400_000) return "Yesterday";
  if (t >= today - 6 * 86_400_000) return d.toLocaleDateString(LOCALE, { weekday: "short" });
  return d.toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
}

export function clockTime(iso: string | null | undefined): string {
  const t = parseTime(iso);
  if (t === null) return "";
  return new Date(t).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
}

export function fullDate(iso: string | null | undefined): string {
  const t = parseTime(iso);
  if (t === null) return "—";
  return new Date(t).toLocaleString(LOCALE, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `16 min`, `1 h 05 min`, `42 s`. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, "0")} min`;
}

/** `42,680`, `1.2M`. */
export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString(LOCALE, { maximumFractionDigits: 1 })}M`;
  if (n >= 100_000) return `${Math.round(n / 1000).toLocaleString(LOCALE)}k`;
  return n.toLocaleString(LOCALE);
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `$${n.toLocaleString(LOCALE, { minimumFractionDigits: n < 1 ? 3 : 2, maximumFractionDigits: n < 1 ? 3 : 2 })}`;
}

/** `expense-receipt-preview-layout` → `Expense receipt preview layout`. */
export function humanizeSlug(slug: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(slug)) return slug;
  const text = slug.replace(/-/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function firstLine(text: string, max = 120): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The path without its last component (`""` for a bare name). */
export function dirname(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "";
}

/** Keeps the last `keep` components of a path. */
export function shortPath(path: string, keep = 3): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= keep) return path;
  return `…/${parts.slice(-keep).join("/")}`;
}
