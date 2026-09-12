// Codex retention regression: an alive-but-unclaimed direct child must not lose
// its relay when the parent's foreground turn closes. Losing it converted one
// missed admission into a permanent session-wide deny for that child — reads,
// exec, and messaging the parent all refused with "Native hook relay unavailable".
import { randomUUID } from "node:crypto";
import {
  invokeNativeHookRelay,
  nativeHookRelayTesting,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import {
  createAdmittedHostCapabilityTestFixture,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexNativeHookRelay } from "./native-hook-relay.js";

// Small on purpose: the relay bounds child admission at a fraction of this, and
// each pending-admission test waits out that bound on real timers.
const GATEWAY_TIMEOUT_MS = 300;

const cleanups: (() => void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
  resetGlobalHookRunner();
  await nativeHookRelayTesting.clearNativeHookRelaysForTests();
});

async function createRelayFixture(label: string, ttlMs?: number) {
  const runId = `run-${label}-${randomUUID()}`;
  const sessionId = `session-${label}-${randomUUID()}`;
  const fixture = await createAdmittedHostCapabilityTestFixture({ runId, sessionId });
  cleanups.push(fixture.closeAdmission, fixture.closeHost);
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => undefined }]),
  );
  const controller = new AbortController();
  const relay = createCodexNativeHookRelay({
    options: { enabled: true, gatewayTimeoutMs: GATEWAY_TIMEOUT_MS, ttlMs },
    events: ["pre_tool_use"],
    agentId: undefined,
    sessionId,
    sessionKey: undefined,
    config: undefined,
    runId,
    attemptTimeoutMs: 60_000,
    startupTimeoutMs: 10_000,
    turnStartTimeoutMs: 10_000,
    loopDetectionPreToolUseRelay: false,
    signal: controller.signal,
    hostCapabilities: fixture.hostCapabilities,
    onPreToolUseFailure: () => {},
  });
  if (!relay) {
    throw new Error("Expected a Codex native hook relay");
  }
  return { relay };
}

/**
 * Drives the real pre_tool_use path for an unclaimed child. It rejects on the
 * relay's admission bound and deliberately leaves the admission pending, which
 * is the state the retention predicate must now honor.
 */
async function startUnclaimedChildAdmission(relayId: string, childThreadId: string) {
  await expect(
    invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        agent_id: childThreadId,
        tool_name: "Bash",
        tool_use_id: `${childThreadId}-call-1`,
        tool_input: { command: "true" },
      },
    }),
  ).rejects.toThrow("native hook relay child admission timed out");
}

describe("Codex native hook relay direct-child retention", () => {
  it("keeps the relay registered for a child whose admission is still pending", async () => {
    const { relay } = await createRelayFixture("pending-admission");
    await startUnclaimedChildAdmission(relay.relayId, "child-pending");
    relay.authorizeRetentionAfterSuccessfulYield();

    relay.unregister();

    expect(relay.hasClaimedDirectChild()).toBe(false);
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId),
    ).toBeDefined();
  });

  it("expires a retained pending admission at the existing relay lifetime bound", async () => {
    const { relay } = await createRelayFixture("pending-expiry", 500);
    await startUnclaimedChildAdmission(relay.relayId, "child-never-claimed");
    relay.authorizeRetentionAfterSuccessfulYield();
    relay.unregister();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId),
    ).toBeDefined();
    await expect
      .poll(() => nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId))
      .toBeUndefined();
  });

  it("unregisters when no child is claimed and none is awaiting admission", async () => {
    const { relay } = await createRelayFixture("no-child");
    relay.authorizeRetentionAfterSuccessfulYield();

    relay.unregister();

    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId),
    ).toBeUndefined();
  });

  it("still refuses retention for a pending admission without an authorized yield", async () => {
    const { relay } = await createRelayFixture("pending-unauthorized");
    await startUnclaimedChildAdmission(relay.relayId, "child-unauthorized");

    relay.unregister();

    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId),
    ).toBeUndefined();
  });

  it("keeps the relay for a sibling pending admission after the last claim releases", async () => {
    const { relay } = await createRelayFixture("sibling-pending");
    const release = relay.claimDirectChild("child-claimed");
    await startUnclaimedChildAdmission(relay.relayId, "child-sibling");
    relay.authorizeRetentionAfterSuccessfulYield();
    relay.unregister();
    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId),
    ).toBeDefined();

    // The claimed child finishes; the sibling is still blocked on admission and
    // must not have the relay pulled out from under it.
    release();

    expect(
      nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relay.relayId),
    ).toBeDefined();
  });

  it("admits a later tool call once the provisional claim lands", async () => {
    const { relay } = await createRelayFixture("late-claim");
    await startUnclaimedChildAdmission(relay.relayId, "child-late");
    relay.authorizeRetentionAfterSuccessfulYield();
    relay.unregister();

    // The claim the child lost the race to finally arrives.
    relay.claimDirectChild("child-late");

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          agent_id: "child-late",
          tool_name: "Bash",
          tool_use_id: "child-late-call-2",
          tool_input: { command: "true" },
        },
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });
});
