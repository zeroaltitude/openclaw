// Covers the relay-side bound on native child hook admission. An unadmitted
// child used to block the parent's invocation indefinitely, leaving the child's
// own CLI deadline as the only clock.
import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeAdmittedRunDelegatedAuthority } from "../admitted-run-context.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";
import {
  invokeNativeHookRelay,
  registerOwnedNativeHookRelay,
  testing,
} from "./native-hook-relay.js";

// The production bound is 60% of the relay command budget. The tests pin that
// relationship by behavior rather than by importing the ratio.
const COMMAND_TIMEOUT_MS = 1_000;
const EXPECTED_ADMISSION_BOUND_MS = 600;

function readTestNativeAgentId(rawPayload: unknown): string | undefined {
  if (!isRecord(rawPayload) || typeof rawPayload.agent_id !== "string") {
    return undefined;
  }
  return rawPayload.agent_id.trim() || undefined;
}

function childPreToolUsePayload(childThreadId: string) {
  return {
    hook_event_name: "PreToolUse",
    agent_id: childThreadId,
    tool_name: "Bash",
    tool_use_id: `${childThreadId}-call-1`,
    tool_input: { command: "true" },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  await testing.clearNativeHookRelaysForTests();
});

describe("native hook relay child admission bound", () => {
  it("fails an unadmitted child with a distinguishable timeout instead of hanging", async () => {
    const runId = `run-admission-${randomUUID()}`;
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId,
    });
    const beforeToolCall = vi.fn(async () => undefined);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    // The claim never arrives: this is the lost admission race verbatim.
    const neverAdmitted = new Promise<(() => boolean) | undefined>(() => {});
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId: `codex-admission-timeout-${randomUUID()}`,
      sessionId: "session-admission-timeout",
      runId,
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
      command: { timeoutMs: COMMAND_TIMEOUT_MS },
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => true,
        allowPreToolUse: () => false,
        awaitForegroundAdmission: () => neverAdmitted,
        onDispose: () => {},
      },
    });

    const startedAtMs = Date.now();
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: childPreToolUsePayload("child-never-admitted"),
      }),
    ).rejects.toThrow("native hook relay child admission timed out");
    const elapsedMs = Date.now() - startedAtMs;

    // Strictly inside the child's own budget, so the relay — not the expiring
    // client deadline — is what attributed the failure.
    expect(elapsedMs).toBeLessThan(COMMAND_TIMEOUT_MS);
    expect(elapsedMs).toBeGreaterThanOrEqual(EXPECTED_ADMISSION_BOUND_MS - 100);
    // The hook never ran: the invocation died in admission, not in policy.
    expect(beforeToolCall).not.toHaveBeenCalled();

    closeAdmittedRunDelegatedAuthority(admittedRunContext);
    relay.unregister();
  });

  it("admits a child whose claim lands inside the bound", async () => {
    const runId = `run-admission-ok-${randomUUID()}`;
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId,
    });
    const beforeToolCall = vi.fn(async () => undefined);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    let admitChild: ((assertAdmission: () => boolean) => void) | undefined;
    const admission = new Promise<(() => boolean) | undefined>((resolve) => {
      admitChild = resolve;
    });
    let claimed = false;
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId: `codex-admission-late-${randomUUID()}`,
      sessionId: "session-admission-late",
      runId,
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
      command: { timeoutMs: COMMAND_TIMEOUT_MS },
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => true,
        allowPreToolUse: () => claimed,
        awaitForegroundAdmission: () => admission,
        onDispose: () => {},
      },
    });

    const invocation = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: childPreToolUsePayload("child-admitted-late"),
    });
    // Well inside the bound, but after the invocation has already begun waiting.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    claimed = true;
    admitChild?.(() => true);

    await expect(invocation).resolves.toMatchObject({ exitCode: 0 });
    expect(beforeToolCall).toHaveBeenCalledOnce();

    closeAdmittedRunDelegatedAuthority(admittedRunContext);
    relay.unregister();
  });

  it("scales the bound with the configured relay command budget", async () => {
    const runId = `run-admission-scaled-${randomUUID()}`;
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId,
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => undefined }]),
    );
    const shortBudgetMs = 200;
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId: `codex-admission-scaled-${randomUUID()}`,
      sessionId: "session-admission-scaled",
      runId,
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
      command: { timeoutMs: shortBudgetMs },
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => true,
        allowPreToolUse: () => false,
        awaitForegroundAdmission: () => new Promise<(() => boolean) | undefined>(() => {}),
        onDispose: () => {},
      },
    });

    const startedAtMs = Date.now();
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: childPreToolUsePayload("child-short-budget"),
      }),
    ).rejects.toThrow("native hook relay child admission timed out");
    // A smaller budget must produce a proportionally smaller bound, otherwise
    // the timeout is a fixed constant that can outlive a short client deadline.
    expect(Date.now() - startedAtMs).toBeLessThan(EXPECTED_ADMISSION_BOUND_MS);

    closeAdmittedRunDelegatedAuthority(admittedRunContext);
    relay.unregister();
  });

  it("leaves a rejected admission's own error intact", async () => {
    const runId = `run-admission-rejected-${randomUUID()}`;
    const { admittedRunContext, hostCapabilities } = await createAdmittedHostCapabilityTestFixture({
      runId,
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => undefined }]),
    );
    const relay = registerOwnedNativeHookRelay({
      provider: "codex",
      relayId: `codex-admission-rejected-${randomUUID()}`,
      sessionId: "session-admission-rejected",
      runId,
      allowedEvents: ["pre_tool_use"],
      runBeforeToolCall: hostCapabilities.runBeforeToolCall,
      assertActive: hostCapabilities.assertActive,
      command: { timeoutMs: COMMAND_TIMEOUT_MS },
      retention: {
        readClaim: readTestNativeAgentId,
        shouldRetainAfterForegroundClose: () => true,
        allowPreToolUse: () => false,
        awaitForegroundAdmission: () =>
          Promise.reject(new Error("native hook relay foreground admission unavailable")),
        onDispose: () => {},
      },
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: childPreToolUsePayload("child-rejected"),
      }),
    ).rejects.toThrow("native hook relay foreground admission unavailable");

    closeAdmittedRunDelegatedAuthority(admittedRunContext);
    relay.unregister();
  });
});
