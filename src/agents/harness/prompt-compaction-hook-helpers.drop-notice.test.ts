/**
 * Covers the harness helper's defensive catch: when the whole
 * `before_prompt_build` dispatch rejects, the turn must say the prompt is
 * missing plugin context instead of silently continuing without it.
 */
import { describe, expect, it, vi } from "vitest";

const hookRunnerGlobalMocks = vi.hoisted(() => ({
  runBeforePromptBuild: vi.fn(async () => {
    throw new Error("hook dispatch exploded");
  }),
  runHeartbeatPromptContribution: vi.fn(async () => undefined),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) => hookName === "before_prompt_build",
    runBeforePromptBuild: hookRunnerGlobalMocks.runBeforePromptBuild,
    runHeartbeatPromptContribution: hookRunnerGlobalMocks.runHeartbeatPromptContribution,
  }),
}));

import { resolveAgentHarnessBeforePromptBuildResult } from "./prompt-compaction-hook-helpers.js";

describe("resolveAgentHarnessBeforePromptBuildResult dispatch failure", () => {
  it("marks the prompt when the before_prompt_build dispatch rejects", async () => {
    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "what is ready?",
      developerInstructions: "base instructions",
      messages: [],
      ctx: { trigger: "heartbeat", agentId: "agent-1", sessionKey: "session-1" },
    });

    expect(hookRunnerGlobalMocks.runBeforePromptBuild).toHaveBeenCalledTimes(1);
    expect(result.prompt).toContain("<dropped_plugin_context>");
    expect(result.prompt).toContain("before_prompt_build dispatch: failed");
    expect(result.prompt).toContain("what is ready?");
    expect(result.developerInstructions).toBe("base instructions");
  });
});
