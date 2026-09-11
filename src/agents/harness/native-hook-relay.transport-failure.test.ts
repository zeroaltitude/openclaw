// Covers relay-transport failure surfacing: bridge client disconnect, failure
// disposition attribution, and the consecutive-failure escalation to an error.
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";

const { subsystemLogger } = vi.hoisted(() => {
  const logger = {
    subsystem: "test",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => logger,
  };
  return { subsystemLogger: logger };
});

vi.mock("../../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
  createSubsystemLogger: () => subsystemLogger,
}));

const { readNativeHookRelayBridgeRecord } = await import("./native-hook-relay-store.js");
const { NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR, isNativeHookRelayTransportFailedError } =
  await import("./native-hook-relay-transport-error.js");
const { recordNativeHookRelayTransportFailure } =
  await import("./native-hook-relay-transport-failure.js");
const { invokeNativeHookRelay, registerNativeHookRelay, testing } =
  await import("./native-hook-relay.js");

/**
 * The escalation threshold, pinned here by behavior rather than imported.
 *
 * One transport failure is expected and recoverable inside the 250ms stable-id
 * replacement grace, and two can straddle one rotation window. Three
 * consecutive failures with no intervening success cannot be a rotation race.
 */
const TRANSPORT_FAILURE_THRESHOLD = 3;

type RelayHandle = ReturnType<typeof registerNativeHookRelay>;

afterEach(() => {
  vi.useRealTimers();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  testing.clearNativeHookRelaysForTests();
  for (const mock of [
    subsystemLogger.trace,
    subsystemLogger.debug,
    subsystemLogger.info,
    subsystemLogger.warn,
    subsystemLogger.error,
    subsystemLogger.fatal,
    subsystemLogger.raw,
  ]) {
    mock.mockClear();
  }
});

function loggedMessages(mock: { mock: { calls: readonly (readonly unknown[])[] } }): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

function loggedMeta(
  mock: { mock: { calls: readonly (readonly unknown[])[] } },
  message: string,
): Record<string, unknown> | undefined {
  const call = mock.mock.calls.find((entry) => entry[0] === message);
  return call?.[1] as Record<string, unknown> | undefined;
}

function readTransportFailureCount(relayId: string): number {
  const registration = testing.getNativeHookRelayRegistrationForTests(relayId);
  // SAFETY: the internal registration carries transport-failure accounting that
  // the public registration type intentionally does not advertise.
  return (
    (registration as { relayTransportFailures?: { consecutive: number } } | undefined)
      ?.relayTransportFailures?.consecutive ?? 0
  );
}

function preToolUsePayload(toolCallId: string) {
  return {
    hook_event_name: "PreToolUse",
    cwd: "/repo",
    tool_name: "exec_command",
    tool_use_id: toolCallId,
    tool_input: { cmd: "pnpm test" },
  };
}

/** Post to the relay's real bridge and hand back the live socket. */
function openNativeHookRelayBridgeRequest(
  record: { hostname: string; port: number; token: string },
  payload: Record<string, unknown>,
): { destroy: () => void; failed: Promise<void> } {
  const body = JSON.stringify(payload);
  const req = httpRequest({
    hostname: record.hostname,
    method: "POST",
    path: "/invoke",
    port: record.port,
    headers: {
      authorization: `Bearer ${record.token}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  });
  const failed = new Promise<void>((resolve) => {
    req.on("error", () => resolve());
    req.on("close", () => resolve());
  });
  req.end(body);
  return { destroy: () => req.destroy(), failed };
}

async function registerRelayWithHangingBeforeToolCall(params: {
  relayId: string;
  onPreToolUseFailure: (failure: unknown) => void;
}): Promise<{ relay: RelayHandle; hookEntered: Promise<void> }> {
  let resolveEntered!: () => void;
  const hookEntered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_tool_call",
        handler: async () => {
          resolveEntered();
          // Never settles: this is the observed failure shape, where the parent
          // is still inside the invocation when the child gives up on it.
          await new Promise(() => {});
          return {};
        },
      },
    ]),
  );
  const relay = registerNativeHookRelay({
    provider: "codex",
    relayId: params.relayId,
    agentId: "agent-1",
    sessionId: "session-1",
    runId: "run-1",
    onPreToolUseFailure: params.onPreToolUseFailure,
  });
  return { relay, hookEntered };
}

describe("native hook relay bridge client disconnect", () => {
  it("does not charge a retired request's disconnect to the replacement relay", async () => {
    const oldFailure = vi.fn();
    const newFailure = vi.fn();
    const relayId = `codex-replaced-${randomUUID()}`;
    const { relay, hookEntered } = await registerRelayWithHangingBeforeToolCall({
      relayId,
      onPreToolUseFailure: oldFailure,
    });
    let record: ReturnType<typeof readNativeHookRelayBridgeRecord>;
    await vi.waitFor(() => {
      record = readNativeHookRelayBridgeRecord({ relayId });
      expect(record?.relayId).toBe(relayId);
    });
    if (!record) {
      throw new Error("Expected the original relay bridge");
    }
    const request = openNativeHookRelayBridgeRequest(record, {
      provider: "codex",
      relayId,
      generation: relay.generation,
      event: "pre_tool_use",
      rawPayload: preToolUsePayload("retired-request"),
    });
    await hookEntered;
    const replacement = registerNativeHookRelay({
      provider: "codex",
      relayId,
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-2",
      onPreToolUseFailure: newFailure,
    });
    expect(replacement.generation).not.toBe(relay.generation);
    request.destroy();
    await request.failed;
    // Wait for the server-side abort to settle, not only the client's socket.
    await vi.waitFor(() => expect(oldFailure).toHaveBeenCalledOnce());
    expect(readTransportFailureCount(relayId)).toBe(0);
    expect(newFailure).not.toHaveBeenCalled();
  });

  it("warns, counts, and projects a failure when the client socket dies mid-invocation", async () => {
    const onPreToolUseFailure = vi.fn();
    const relayId = `codex-disconnect-${randomUUID()}`;
    const { relay, hookEntered } = await registerRelayWithHangingBeforeToolCall({
      relayId,
      onPreToolUseFailure,
    });
    let record: ReturnType<typeof readNativeHookRelayBridgeRecord>;
    await vi.waitFor(() => {
      record = readNativeHookRelayBridgeRecord({ relayId });
      expect(record?.relayId).toBe(relayId);
    });
    if (!record) {
      throw new Error(`Expected a bridge record for ${relayId}`);
    }

    const request = openNativeHookRelayBridgeRequest(record, {
      provider: "codex",
      relayId,
      generation: relay.generation,
      event: "pre_tool_use",
      rawPayload: preToolUsePayload("native-disconnect-1"),
    });
    // Only destroy once the parent is genuinely inside the invocation; a socket
    // killed before that would prove nothing about an in-flight abort.
    await hookEntered;
    request.destroy();
    await request.failed;

    await vi.waitFor(() => {
      expect(loggedMessages(subsystemLogger.warn)).toContain(
        "native hook relay bridge client disconnected",
      );
    });
    expect(
      loggedMeta(subsystemLogger.warn, "native hook relay bridge client disconnected"),
    ).toMatchObject({
      relayId,
      event: "pre_tool_use",
      elapsedMs: expect.any(Number),
    });
    expect(readTransportFailureCount(relayId)).toBe(1);
    await vi.waitFor(() => {
      expect(onPreToolUseFailure).toHaveBeenCalledWith({
        toolName: "exec",
        toolCallId: "native-disconnect-1",
        disposition: "timed_out",
        durationMs: expect.any(Number),
      });
    });
  });
});

describe("native hook relay failure disposition attribution", () => {
  it("projects a transport disposition when the caller abandons the invocation", async () => {
    const onPreToolUseFailure = vi.fn();
    const relayId = `codex-abandoned-${randomUUID()}`;
    const { relay, hookEntered } = await registerRelayWithHangingBeforeToolCall({
      relayId,
      onPreToolUseFailure,
    });
    const controller = new AbortController();
    const invocation = invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: preToolUsePayload("native-abandoned-1"),
      signal: controller.signal,
    });
    await hookEntered;
    controller.abort();

    await expect(invocation).rejects.toThrow(NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR);
    expect(onPreToolUseFailure).toHaveBeenCalledWith({
      toolName: "exec",
      toolCallId: "native-abandoned-1",
      disposition: "timed_out",
      durationMs: expect.any(Number),
    });
  });

  it("leaves a policy denial without a failure disposition", async () => {
    const onPreToolUseFailure = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => ({ block: true, blockReason: "repo policy blocks this command" }),
        },
      ]),
    );
    const relay = registerNativeHookRelay({
      provider: "codex",
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
      onPreToolUseFailure,
    });

    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: preToolUsePayload("native-policy-deny-1"),
    });

    expect(JSON.parse(response.stdout)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "repo policy blocks this command",
      },
    });
    // The whole point of the disposition: an OpenClaw policy deny is a hook that
    // ran fine, so it carries none and never reaches the failure projector.
    expect(response.failureDisposition).toBeUndefined();
    expect(onPreToolUseFailure).not.toHaveBeenCalled();
  });
});

describe("native hook relay transport failure escalation", () => {
  function registerEscalationRelay(relayId: string): RelayHandle {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => ({}) }]),
    );
    return registerNativeHookRelay({
      provider: "codex",
      relayId,
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
    });
  }

  function failTransport(relayId: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
      recordNativeHookRelayTransportFailure({
        relayId,
        cause: "client-disconnected",
        event: "pre_tool_use",
        elapsedMs: 10,
      });
    }
  }

  it("keeps serving invocations below the consecutive failure threshold", async () => {
    const relayId = `codex-below-threshold-${randomUUID()}`;
    const relay = registerEscalationRelay(relayId);
    failTransport(relayId, TRANSPORT_FAILURE_THRESHOLD - 1);

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: preToolUsePayload("native-below-threshold-1"),
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(loggedMessages(subsystemLogger.error)).not.toContain(
      "native hook relay transport failed",
    );
  });

  it("refuses every later invocation with an explicit error once the threshold trips", async () => {
    const relayId = `codex-at-threshold-${randomUUID()}`;
    const relay = registerEscalationRelay(relayId);
    failTransport(relayId, TRANSPORT_FAILURE_THRESHOLD);

    expect(loggedMeta(subsystemLogger.error, "native hook relay transport failed")).toMatchObject({
      relayId,
      cause: "client-disconnected",
      consecutiveFailures: TRANSPORT_FAILURE_THRESHOLD,
      threshold: TRANSPORT_FAILURE_THRESHOLD,
    });
    for (const attempt of ["native-at-threshold-1", "native-at-threshold-2"]) {
      const failure = await invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: preToolUsePayload(attempt),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(isNativeHookRelayTransportFailedError(failure)).toBe(true);
    }
  });

  it("resets the consecutive counter after an invocation completes end to end", async () => {
    const relayId = `codex-reset-${randomUUID()}`;
    const relay = registerEscalationRelay(relayId);
    failTransport(relayId, TRANSPORT_FAILURE_THRESHOLD - 1);
    expect(readTransportFailureCount(relayId)).toBe(TRANSPORT_FAILURE_THRESHOLD - 1);

    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: preToolUsePayload("native-reset-1"),
    });
    expect(readTransportFailureCount(relayId)).toBe(0);

    failTransport(relayId, TRANSPORT_FAILURE_THRESHOLD - 1);
    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "pre_tool_use",
        rawPayload: preToolUsePayload("native-reset-2"),
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("ignores transport failures reported for a relay that is already gone", () => {
    expect(
      recordNativeHookRelayTransportFailure({
        relayId: `codex-missing-${randomUUID()}`,
        cause: "relay-unavailable",
      }),
    ).toBeUndefined();
  });
});
