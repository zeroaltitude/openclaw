import { describe, expect, it } from "vitest";
import type { ResolvedCliBackend } from "../cli-backends.js";
import { resolveCliRunOfferedToolNames, resolveCliRuntimeToolsAllow } from "./tool-policy.js";

const claudeBackend = {
  id: "claude-cli",
  toolAvailabilityEnforcement: "execution-args",
} satisfies Pick<ResolvedCliBackend, "id" | "toolAvailabilityEnforcement">;

describe("resolveCliRuntimeToolsAllow", () => {
  it("keeps every concrete restriction, including server-managed defaults", () => {
    expect(resolveCliRuntimeToolsAllow(undefined)).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["*"])).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["memory_search"])).toEqual(["memory_search"]);
  });
});

describe("resolveCliRunOfferedToolNames", () => {
  it("reports the capped run's native and discovery selection", () => {
    const offered = resolveCliRunOfferedToolNames(
      {
        cliToolAvailability: {
          native: ["WebSearch"],
          openClaw: ["exec", "read"],
          discovery: ["ToolSearch"],
        },
      },
      claudeBackend,
    );

    expect(offered && [...offered].toSorted()).toEqual(["ToolSearch", "WebSearch"]);
    expect(offered?.has("mcp__invoke")).toBe(false);
  });

  it("omits discovery the run never selected", () => {
    const offered = resolveCliRunOfferedToolNames(
      { cliToolAvailability: { native: [], openClaw: ["read"] } },
      claudeBackend,
    );

    expect(offered && [...offered]).toEqual([]);
  });

  // An uncapped run also hands its configured MCP servers to the CLI, and those
  // tool names live nowhere in cliToolAvailability. Claiming an offered set here
  // would mark a real external MCP call unoffered.
  it("makes no claim for an uncapped run", () => {
    expect(resolveCliRunOfferedToolNames({}, claudeBackend)).toBeUndefined();
    expect(
      resolveCliRunOfferedToolNames({ cliToolAvailability: undefined }, claudeBackend),
    ).toBeUndefined();
  });

  it("makes no claim for a backend that does not enforce the cap in execution args", () => {
    const availability = {
      cliToolAvailability: { native: ["WebSearch"], openClaw: ["read"] },
    };

    expect(
      resolveCliRunOfferedToolNames(availability, {
        id: "gemini-cli",
        toolAvailabilityEnforcement: "prepare-execution",
      }),
    ).toBeUndefined();
    expect(
      resolveCliRunOfferedToolNames(availability, {
        id: "claude-cli",
        toolAvailabilityEnforcement: undefined,
      }),
    ).toBeUndefined();
  });
});
