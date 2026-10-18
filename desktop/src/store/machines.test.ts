import { describe, expect, it } from "vitest";
import type { StoredItem } from "../api/types";
import { mergeItems, streamedAgents } from "./machines";

const item = (n: number): StoredItem => ({ n, type: "notice", timestamp: "2026-10-17T10:00:00Z", text: String(n) });
const ns = (items: StoredItem[]) => items.map((i) => i.n);

describe("mergeItems", () => {
  it("appends and prepends without sorting", () => {
    const base = [item(3), item(4)];
    expect(ns(mergeItems(base, [item(5)]))).toEqual([3, 4, 5]);
    expect(ns(mergeItems(base, [item(1), item(2)]))).toEqual([1, 2, 3, 4]);
  });
  it("skips duplicates and keeps the array when nothing is new", () => {
    const base = [item(1), item(2)];
    expect(mergeItems(base, [item(2)])).toBe(base);
    expect(ns(mergeItems(base, [item(2), item(0), item(5)]))).toEqual([0, 1, 2, 5]);
  });
});

describe("streamedAgents", () => {
  it("lists the live timelines of each machine, history excluded", () => {
    const keys = ["live|m1|default:w1:p2", "hist|m1|claude:abc", "live|m2|default:w3:p1", "live|m1|default:w1:p1", "live|gone|x"];
    expect(streamedAgents(["m1", "m2", "m3"], keys)).toEqual({ m1: ["default:w1:p1", "default:w1:p2"], m2: ["default:w3:p1"], m3: [] });
  });
});
