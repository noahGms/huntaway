import { describe, expect, it } from "vitest";
import { compareVersions, daemonOutdated } from "./updates";

describe("versions", () => {
  it("compares release versions", () => {
    expect(compareVersions("0.1.0", "0.1.1")).toBe(-1);
    expect(compareVersions("v0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.1-dev", "0.1.1")).toBe(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });
  it("flags outdated daemons only when both versions are known", () => {
    expect(daemonOutdated("0.1.0", "0.1.1")).toBe(true);
    expect(daemonOutdated("0.1.1", "0.1.1")).toBe(false);
    expect(daemonOutdated(null, "0.1.1")).toBe(false);
    expect(daemonOutdated("0.1.0", null)).toBe(false);
  });
});
