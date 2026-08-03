/**
 * Tests that a dropped `before_prompt_build` contribution becomes visible to the
 * agent instead of vanishing from the prompt.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-fixtures.js";
import type { PluginHookBeforePromptBuildResult } from "./types.js";

const PROMPT_EVENT = { prompt: "hello", messages: [] };

function createLogger() {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("before_prompt_build dropped-contribution notice", () => {
  it("leaves a fully successful dispatch untouched", async () => {
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "before_prompt_build",
        pluginId: "good-plugin",
        handler: () => ({ prependContext: "<plans_and_tasks>work</plans_and_tasks>" }),
      },
    ]);

    const result = await runner.runBeforePromptBuild(PROMPT_EVENT, TEST_PLUGIN_AGENT_CTX);

    expect(result?.prependContext).toBe("<plans_and_tasks>work</plans_and_tasks>");
    expect(result?.prependContext).not.toContain("dropped_plugin_context");
  });

  it("returns undefined when no plugin registered the hook", async () => {
    const { runner } = createHookRunnerWithRegistry([]);

    await expect(
      runner.runBeforePromptBuild(PROMPT_EVENT, TEST_PLUGIN_AGENT_CTX),
    ).resolves.toBeUndefined();
  });

  it("names a handler that threw and keeps the surviving contribution", async () => {
    const logger = createLogger();
    const { runner } = createHookRunnerWithRegistry(
      [
        {
          hookName: "before_prompt_build",
          pluginId: "boom-plugin",
          priority: 10,
          handler: () => {
            throw new Error("handler exploded");
          },
        },
        {
          hookName: "before_prompt_build",
          pluginId: "good-plugin",
          priority: 1,
          handler: () => ({ prependContext: "surviving context" }),
        },
      ],
      { logger },
    );

    const result = await runner.runBeforePromptBuild(PROMPT_EVENT, TEST_PLUGIN_AGENT_CTX);

    expect(result?.prependContext).toContain("<dropped_plugin_context>");
    expect(result?.prependContext).toContain('plugin "boom-plugin" (before_prompt_build): failed');
    expect(result?.prependContext).toContain("surviving context");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("before_prompt_build handler from boom-plugin failed"),
    );
  });

  it("distinguishes a timed-out handler from a failed one", async () => {
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "before_prompt_build",
        pluginId: "slow-plugin",
        timeoutMs: 5,
        handler: async () =>
          await new Promise((resolve) => {
            setTimeout(() => resolve({ prependContext: "too late" }), 200);
          }),
      },
    ]);

    const result = await runner.runBeforePromptBuild(PROMPT_EVENT, TEST_PLUGIN_AGENT_CTX);

    expect(result?.prependContext).toContain(
      'plugin "slow-plugin" (before_prompt_build): timed out',
    );
    expect(result?.prependContext).not.toContain("too late");
  });

  it("marks a re-entrant prompt build instead of skipping silently", async () => {
    const logger = createLogger();
    let nested: PluginHookBeforePromptBuildResult | undefined;
    const { runner } = createHookRunnerWithRegistry(
      [
        {
          hookName: "before_prompt_build",
          pluginId: "reentrant-plugin",
          handler: async () => {
            // A prompt-build hook that starts a nested agent run re-enters the
            // dispatch; the inner build skips every handler.
            nested = await runner.runBeforePromptBuild(PROMPT_EVENT, TEST_PLUGIN_AGENT_CTX);
            return { prependContext: "outer context" };
          },
        },
      ],
      { logger },
    );

    const outer = await runner.runBeforePromptBuild(PROMPT_EVENT, TEST_PLUGIN_AGENT_CTX);

    expect(outer?.prependContext).toBe("outer context");
    expect(nested?.prependContext).toContain(
      'plugin "reentrant-plugin" (before_prompt_build): skipped (re-entrant prompt build)',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("before_prompt_build skipped for 1 plugin(s) (re-entrant"),
    );
  });

  it("bounds the notice when many plugins drop at once", async () => {
    const pluginIds = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
    const { runner } = createHookRunnerWithRegistry(
      pluginIds.map((pluginId) => ({
        hookName: "before_prompt_build",
        pluginId,
        handler: () => {
          throw new Error(`${pluginId} exploded`);
        },
      })),
      { logger: createLogger() },
    );

    const result = await runner.runBeforePromptBuild(PROMPT_EVENT, TEST_PLUGIN_AGENT_CTX);
    const notice = result?.prependContext ?? "";

    expect(notice.split("\n").filter((line) => line.startsWith('- plugin "'))).toHaveLength(5);
    expect(notice).toContain("- ...and 2 more");
  });
});
