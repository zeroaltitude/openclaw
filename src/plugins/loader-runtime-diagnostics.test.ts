import { describe, expect, it } from "vitest";
import {
  formatSlowPluginDiscoveryWarning,
  formatSlowPluginRegistryWarning,
} from "./loader-runtime-diagnostics.js";

describe("plugin loader runtime diagnostics", () => {
  it("stays silent at or below the slow-load threshold", () => {
    expect(
      formatSlowPluginDiscoveryWarning({ elapsedMs: 1_000, candidateCount: 4 }),
    ).toBeUndefined();
    expect(
      formatSlowPluginRegistryWarning({
        elapsedMs: 999.9,
        pluginCount: 2,
        attemptedCount: 2,
        runtimeSubagentMode: "none",
        timings: [["slow", 900]],
      }),
    ).toBeUndefined();
  });

  it("attributes a slow registry to a bounded descending plugin sample", () => {
    const timings = Array.from(
      { length: 14 },
      (_, index) => [`plugin-${index}`, 100 + index] as const,
    );

    const warning = formatSlowPluginRegistryWarning({
      elapsedMs: 1_501.4,
      pluginCount: 14,
      attemptedCount: 14,
      runtimeSubagentMode: "child",
      timings,
    });

    expect(warning).toContain("total=1501ms plugins=14 attempted=14 subagentMode=child");
    expect(warning).toContain("plugin-13=113ms");
    expect(warning).toContain("plugin-4=104ms");
    expect(warning).not.toContain("plugin-3=");
  });

  it("reports aggregate overhead when no individual plugin crosses the sample threshold", () => {
    expect(
      formatSlowPluginRegistryWarning({
        elapsedMs: 1_200,
        pluginCount: 2,
        attemptedCount: 2,
        runtimeSubagentMode: "none",
        timings: [
          ["one", 49],
          ["two", 10],
        ],
      }),
    ).toContain("slowest=none-above-50ms");
  });
});
