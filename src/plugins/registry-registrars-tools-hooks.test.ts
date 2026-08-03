import { describe, expect, it } from "vitest";
import { createToolHookRegistrars } from "./registry-registrars-tools-hooks.js";
import { createPluginRegistryState, type PluginTypedHookPolicy } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";

function createHookRegistrarHarness() {
  const state = createPluginRegistryState({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    // The tool/hook registrars never touch the plugin runtime; only the registry
    // binding does, and it just stashes the value on a non-enumerable slot.
    runtime: {} as PluginRuntime,
  });
  return { registry: state.registry, ...createToolHookRegistrars(state) };
}

function registerConversationHook(params: {
  origin: PluginRecord["origin"];
  policy?: PluginTypedHookPolicy;
}) {
  const harness = createHookRegistrarHarness();
  const record = createPluginRecord({ id: "beads", origin: params.origin });
  harness.registerTypedHook(
    record,
    "before_prompt_build",
    () => undefined,
    undefined,
    params.policy,
  );
  return { ...harness, record };
}

describe("registerTypedHook policy blocks", () => {
  // Each of these paths drops the handler for the life of the process while the
  // plugin still reports as loaded. They must be errors carrying the shared code so
  // status surfaces can list them after the startup scroll is gone.
  it.each([
    {
      name: "prompt-injection hook with allowPromptInjection=false",
      origin: "bundled" as const,
      policy: { allowPromptInjection: false, allowConversationAccess: true },
      expected: "blocked by plugins.entries.beads.hooks.allowPromptInjection=false",
    },
    {
      name: "non-bundled conversation hook without allowConversationAccess",
      origin: "config" as const,
      policy: undefined,
      expected:
        "blocked because non-bundled plugins must set plugins.entries.beads.hooks.allowConversationAccess=true",
    },
    {
      name: "bundled conversation hook with allowConversationAccess=false",
      origin: "bundled" as const,
      policy: { allowConversationAccess: false },
      expected: "blocked by plugins.entries.beads.hooks.allowConversationAccess=false",
    },
  ])("reports $name as a coded error and registers nothing", ({ origin, policy, expected }) => {
    const { registry, record } = registerConversationHook({ origin, policy });

    expect(registry.typedHooks).toStrictEqual([]);
    expect(record.hookCount).toBe(0);
    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.diagnostics[0]).toMatchObject({
      level: "error",
      code: "hook-registration-blocked",
      pluginId: "beads",
    });
    expect(registry.diagnostics[0]?.message).toContain(expected);
    // The consequence, not just the policy, must be stated: an operator reading one
    // line has to learn the handler is dead and where to look for it later.
    expect(registry.diagnostics[0]?.message).toContain("the handler is not registered");
  });

  it("registers the hook and emits no diagnostic when the policy allows it", () => {
    const { registry } = registerConversationHook({
      origin: "config",
      policy: { allowConversationAccess: true },
    });

    expect(registry.typedHooks.map((entry) => entry.hookName)).toStrictEqual([
      "before_prompt_build",
    ]);
    expect(registry.diagnostics).toStrictEqual([]);
  });
});
