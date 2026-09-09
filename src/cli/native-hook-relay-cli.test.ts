// Native hook relay CLI tests cover relay command registration and runtime delegation.
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { renderNativeHookRelayUnavailableResponse } from "../agents/harness/native-hook-relay-client.js";
import { codexNativeHookRelayResponseCodec } from "../agents/harness/native-hook-relay-response-codec.js";
import {
  NATIVE_HOOK_RELAY_DISPOSITION_MARKER,
  NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR,
} from "../agents/harness/native-hook-relay-transport-error.js";
import { runNativeHookRelayCli, runNativeHookRelayCliFromArgv } from "./native-hook-relay-cli.js";

function createReadableTextStream(text: string): NodeJS.ReadableStream {
  return Readable.from([text]);
}

function createWritableTextBuffer(): NodeJS.WritableStream & { text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  });
  return Object.assign(stream, {
    text: () => Buffer.concat(chunks).toString("utf8"),
  });
}

describe("native hook relay CLI", () => {
  it("parses the internal cold-path argument vector", async () => {
    const invokeBridge = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    await expect(
      runNativeHookRelayCliFromArgv(
        [
          "node",
          "openclaw.mjs",
          "hooks",
          "relay",
          "--provider=codex",
          "--relay-id",
          "relay-1",
          "--state-db",
          "/tmp/profile/state/openclaw.sqlite",
          "--generation",
          "generation-1",
          "--event",
          "pre_tool_use",
          "--pre-tool-use-unavailable",
          "noop",
          "--timeout",
          "1234",
        ],
        {
          stdin: createReadableTextStream("{}"),
          invokeBridge: invokeBridge as never,
        },
      ),
    ).resolves.toBe(0);

    expect(invokeBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        relayId: "relay-1",
        stateDbPath: "/tmp/profile/state/openclaw.sqlite",
        generation: "generation-1",
        event: "pre_tool_use",
        timeoutMs: expect.any(Number),
      }),
    );
  });

  it("passes the explicit state database path to direct bridge lookup", async () => {
    const invokeBridge = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    await expect(
      runNativeHookRelayCli(
        {
          provider: "codex",
          relayId: "relay-1",
          stateDb: "/tmp/profile/state/openclaw.sqlite",
          generation: "generation-1",
          event: "post_tool_use",
        },
        {
          stdin: createReadableTextStream("{}"),
          invokeBridge: invokeBridge as never,
        },
      ),
    ).resolves.toBe(0);

    expect(invokeBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        relayId: "relay-1",
        stateDbPath: "/tmp/profile/state/openclaw.sqlite",
      }),
    );
  });

  it("reads Codex hook JSON from stdin and forwards it to the gateway relay", async () => {
    const callGateway = vi.fn(async (_opts: unknown) => ({ stdout: "", stderr: "", exitCode: 0 }));
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        timeout: "1234",
      },
      {
        stdin: createReadableTextStream(
          JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "pnpm test" },
          }),
        ),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("");
    expect(callGateway).toHaveBeenCalledWith({
      method: "nativeHook.invoke",
      params: {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        rawPayload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
        },
      },
      timeoutMs: expect.any(Number),
      signal: expect.any(AbortSignal),
      scopes: ["operator.admin"],
    });
    const call = callGateway.mock.calls[0]?.[0] as { timeoutMs?: number } | undefined;
    expect(call).toBeDefined();
    expect(call?.timeoutMs).toBeGreaterThan(0);
    expect(call?.timeoutMs).toBeLessThanOrEqual(1234);
  });

  it("renders provider-compatible stdout, stderr, and exit code from the gateway response", async () => {
    const callGateway = vi.fn(async () => ({ stdout: "out", stderr: "err", exitCode: 2 }));
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "permission_request",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(2);
    expect(stdout.text()).toBe("out");
    expect(stderr.text()).toBe("err");
  });

  it("rejects malformed timeouts before reading relay input", async () => {
    const invokeBridge = vi.fn();
    const callGateway = vi.fn();
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        timeout: "5000ms",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        invokeBridge: invokeBridge as never,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("invalid native hook timeout");
    expect(stderr.text()).toContain('Received: "5000ms"');
    expect(invokeBridge).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("rejects fractional timeouts before gateway fallback", async () => {
    const invokeBridge = vi.fn();
    const callGateway = vi.fn();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        timeout: "1.5",
      },
      {
        stdin: createReadableTextStream("{}"),
        stderr,
        invokeBridge: invokeBridge as never,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain('Received: "1.5"');
    expect(invokeBridge).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("renders unavailable output for legacy relay commands without a generation", async () => {
    const invokeBridge = vi.fn(async () => {
      throw new Error("generation must be non-empty string");
    });
    const callGateway = vi.fn(async () => {
      throw new Error("generation must be non-empty string");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", event: "pre_tool_use" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        invokeBridge: invokeBridge as never,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Native hook relay unavailable",
      },
    });
    expect(stderr.text()).toContain("native hook relay unavailable");
    expect(stderr.text()).toContain("generation must be non-empty string");
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "nativeHook.invoke",
        params: expect.objectContaining({ generation: undefined }),
      }),
    );
  });

  it.each([
    {
      event: "pre_tool_use",
      stdout: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Native hook relay unavailable",
        },
      },
    },
    {
      event: "permission_request",
      stdout: {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: "Native hook relay unavailable",
          },
        },
      },
    },
    {
      event: "post_tool_use",
      stdout: null,
    },
  ])(
    "does not fall back to the gateway after a stale direct bridge error for $event",
    async (testCase) => {
      const invokeBridge = vi.fn(async () => {
        throw new Error("native hook relay bridge stale registration");
      });
      const callGateway = vi.fn(async () => ({ stdout: "unexpected", stderr: "", exitCode: 0 }));
      const stdout = createWritableTextBuffer();
      const stderr = createWritableTextBuffer();

      const exitCode = await runNativeHookRelayCli(
        {
          provider: "codex",
          relayId: "relay-1",
          generation: "generation-1",
          event: testCase.event,
        },
        {
          stdin: createReadableTextStream("{}"),
          stdout,
          stderr,
          invokeBridge: invokeBridge as never,
          callGateway: callGateway as never,
        },
      );

      expect(exitCode).toBe(0);
      if (testCase.stdout) {
        expect(JSON.parse(stdout.text())).toEqual(testCase.stdout);
      } else {
        expect(stdout.text()).toBe("");
      }
      expect(stderr.text()).toContain("native hook relay unavailable");
      expect(stderr.text()).toContain("native hook relay bridge stale registration");
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("returns a nonzero code for malformed hook input without touching the gateway", async () => {
    const callGateway = vi.fn();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", generation: "generation-1", event: "pre_tool_use" },
      {
        stdin: createReadableTextStream("{nope"),
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("failed to read native hook input");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      event: "pre_tool_use",
      preToolUseUnavailable: "noop",
      stdout: null,
    },
    {
      event: "pre_tool_use",
      stdout: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Native hook relay timed out",
        },
      },
    },
    {
      event: "permission_request",
      stdout: {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: "Native hook relay timed out",
          },
        },
      },
    },
    {
      event: "post_tool_use",
      stdout: null,
    },
  ])(
    "bounds valid $event hook input that never reaches EOF",
    async (testCase) => {
      const invokeBridge = vi.fn();
      const callGateway = vi.fn();
      const stdin = createHeldOpenTextStream("{}");
      const stdout = createWritableTextBuffer();
      const stderr = createWritableTextBuffer();

      const exitCode = await runNativeHookRelayCli(
        {
          provider: "codex",
          relayId: "relay-1",
          generation: "generation-1",
          event: testCase.event,
          preToolUseUnavailable: testCase.preToolUseUnavailable,
          timeout: "25",
        },
        {
          stdin,
          stdout,
          stderr,
          invokeBridge: invokeBridge as never,
          callGateway: callGateway as never,
        },
      );

      expect(exitCode).toBe(0);
      if (testCase.stdout) {
        expect(JSON.parse(stdout.text())).toEqual(testCase.stdout);
      } else {
        expect(stdout.text()).toBe("");
      }
      expect(stderr.text()).toContain("native hook relay timed out");
      expect(stdin.destroyed).toBe(true);
      expect(invokeBridge).not.toHaveBeenCalled();
      expect(callGateway).not.toHaveBeenCalled();
    },
    1_000,
  );

  it("applies the relay deadline to gateway fallback", async () => {
    const invokeBridge = vi.fn(async () => {
      throw new Error("bridge unavailable");
    });
    const callGateway = vi.fn(async () => await new Promise<never>(() => {}));
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "post_tool_use",
        timeout: "25",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        invokeBridge: invokeBridge as never,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay timed out");
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "nativeHook.invoke",
        signal: expect.any(AbortSignal),
      }),
    );
  }, 1_000);

  it("handles bridge rejection when the deadline expires during bridge startup", async () => {
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const invokeBridge = vi.fn(() => {
      now = 26;
      return Promise.reject(new Error("native hook relay bridge not found"));
    });
    const callGateway = vi.fn();
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    try {
      const exitCode = await runNativeHookRelayCli(
        {
          provider: "codex",
          relayId: "relay-1",
          generation: "generation-1",
          event: "pre_tool_use",
          timeout: "25",
        },
        {
          stdin: createReadableTextStream("{}"),
          stdout,
          stderr,
          invokeBridge: invokeBridge as never,
          callGateway: callGateway as never,
        },
      );

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.text())).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Native hook relay timed out",
        },
      });
      expect(stderr.text()).toContain("native hook relay timed out");
      expect(invokeBridge).toHaveBeenCalledOnce();
      expect(callGateway).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rejects oversized hook input without touching the gateway", async () => {
    const callGateway = vi.fn();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", generation: "generation-1", event: "post_tool_use" },
      {
        stdin: createReadableTextStream("x".repeat(1024 * 1024 + 1)),
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("native hook input exceeds");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("fails closed for PreToolUse when the gateway relay is unavailable", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", generation: "generation-1", event: "pre_tool_use" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Native hook relay unavailable",
      },
    });
    expect(stderr.text()).toContain("native hook relay unavailable");
    // Attribution the parent can act on: this deny came from an unreachable
    // relay, not from an OpenClaw policy decision.
    expect(stderr.text()).toContain(`${NATIVE_HOOK_RELAY_DISPOSITION_MARKER} failed`);
  });

  it("attributes the fail-closed PreToolUse deny as an unreachable relay", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });

    const response = renderNativeHookRelayUnavailableResponse({
      provider: "codex",
      event: "pre_tool_use",
      message: "Native hook relay unavailable",
      failureDisposition: "failed",
    });

    // A policy deny renders through the same codec with no disposition at all,
    // which is the only thing that tells the two cases apart downstream.
    expect(response.failureDisposition).toBe("failed");
    expect(
      codexNativeHookRelayResponseCodec.renderPreToolUseBlockResponse("repo policy blocks this"),
    ).not.toHaveProperty("failureDisposition");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("marks a relay deadline deny as timed out rather than merely failed", async () => {
    const invokeBridge = vi.fn(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          setTimeout(reject, 5_000);
        }),
    );
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        timeout: "1",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        invokeBridge: invokeBridge as never,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      hookSpecificOutput: { permissionDecisionReason: "Native hook relay timed out" },
    });
    expect(stderr.text()).toContain("native hook relay timed out");
    expect(stderr.text()).toContain(`${NATIVE_HOOK_RELAY_DISPOSITION_MARKER} timed_out`);
  });

  it("exits nonzero instead of fail-closed denying once the relay transport is dead", async () => {
    const invokeBridge = vi.fn(async () => {
      throw new Error(NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR);
    });
    const callGateway = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", generation: "generation-1", event: "pre_tool_use" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        invokeBridge: invokeBridge as never,
        callGateway: callGateway as never,
      },
    );

    // Exit 0 plus a deny reads as a hook that ran fine and made a policy call.
    // A dead transport must read as a hook error so the run cannot finish clean.
    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay transport failed");
    // No gateway retry: the relay itself declared the transport dead.
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("exits nonzero when the gateway fallback reports a dead relay transport", async () => {
    const invokeBridge = vi.fn(async () => {
      throw new Error("native hook relay bridge not found");
    });
    const callGateway = vi.fn(async () => {
      throw new Error(NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR);
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", generation: "generation-1", event: "pre_tool_use" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        invokeBridge: invokeBridge as never,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay transport failed");
  });

  it("keeps PreToolUse unavailable handling observational only with an explicit no-policy marker", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        preToolUseUnavailable: "noop",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay unavailable");
    // Nothing was denied, so there is nothing to attribute.
    expect(stderr.text()).not.toContain(NATIVE_HOOK_RELAY_DISPOSITION_MARKER);
  });

  it("fails closed for PermissionRequest when the gateway relay is unavailable", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "permission_request",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: "Native hook relay unavailable",
        },
      },
    });
  });

  it("keeps PostToolUse unavailable handling observational", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      { provider: "codex", relayId: "relay-1", generation: "generation-1", event: "post_tool_use" },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay unavailable");
  });

  it("keeps before_agent_finalize unavailable handling observational", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("gateway closed");
    });
    const stdout = createWritableTextBuffer();
    const stderr = createWritableTextBuffer();

    const exitCode = await runNativeHookRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "before_agent_finalize",
      },
      {
        stdin: createReadableTextStream("{}"),
        stdout,
        stderr,
        callGateway: callGateway as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("native hook relay unavailable");
  });
});

function createHeldOpenTextStream(text: string): PassThrough {
  const stream = new PassThrough();
  stream.write(text);
  return stream;
}
