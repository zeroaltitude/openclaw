import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
import {
  activateMcpLoopbackClientGrantCapture,
  bindMcpLoopbackClientGrantAdmission,
  deactivateMcpLoopbackClientGrantCapture,
  mintAttachGrant,
  mintMcpLoopbackClientGrant,
  peekMcpLoopbackClientGrantNativeToolAllowlist,
  registerMcpLoopbackClientGrantRevocationListener,
  resolveAttachGrant,
  resolveMcpLoopbackClientGrant,
  revokeAttachGrant,
  revokeAttachGrantsForSession,
  revokeMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrantsForRuntime,
  transferMcpLoopbackClientGrant,
  waitForMcpLoopbackClientGrantNativeToolAllowlist,
} from "./mcp-grant-store.js";

const T0 = 1_000_000_000_000;
const admissions: PreparedAgentRunAdmission[] = [];

async function admitted(runId: string): Promise<AdmittedRunContext> {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "mcp-grant-store-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.push(admission);
  return await admission.admit("gateway", `gateway-${runId}`);
}

describe("mcp-grant-store", () => {
  beforeEach(() => {
    revokeMcpLoopbackClientGrantsForRuntime("runtime-one");
    revokeMcpLoopbackClientGrantsForRuntime("runtime-two");
  });

  afterEach(() => {
    for (const admission of admissions.splice(0)) {
      admission.close();
    }
  });

  it("mints a grant bound to the sessionKey with a token and a TTL window", () => {
    const g = mintAttachGrant({ sessionKey: "agent:main:main", ttlMs: 60_000, nowMs: T0 });
    expect(g.sessionKey).toBe("agent:main:main");
    expect(g.token).toMatch(/^[0-9a-f]{64}$/);
    expect(g.issuedAtMs).toBe(T0);
    expect(g.expiresAtMs).toBe(T0 + 60_000);
  });

  it("requires a non-empty sessionKey", () => {
    expect(() => mintAttachGrant({ sessionKey: "  ", nowMs: T0 })).toThrow();
  });

  it("resolves a live grant and drops it once expired (TTL)", () => {
    const g = mintAttachGrant({ sessionKey: "agent:main:x", ttlMs: 1_000, nowMs: T0 });
    expect(resolveAttachGrant(g.token, T0)?.sessionKey).toBe("agent:main:x");
    expect(resolveAttachGrant(g.token, T0 + 999)?.sessionKey).toBe("agent:main:x");
    expect(resolveAttachGrant(g.token, T0 + 1_000)).toBeUndefined();
    expect(resolveAttachGrant(g.token, T0 + 1_001)).toBeUndefined();
  });

  it("returns undefined for an unknown token (no scope without a grant)", () => {
    expect(resolveAttachGrant("deadbeef", T0)).toBeUndefined();
  });

  it("binds the sessionKey to the grant (token carries scope identity, not the caller)", () => {
    const a = mintAttachGrant({ sessionKey: "agent:main:telegram:1", nowMs: T0 });
    const b = mintAttachGrant({ sessionKey: "agent:main:telegram:2", nowMs: T0 });
    expect(resolveAttachGrant(a.token, T0)?.sessionKey).toBe("agent:main:telegram:1");
    expect(resolveAttachGrant(b.token, T0)?.sessionKey).toBe("agent:main:telegram:2");
    expect(a.token).not.toBe(b.token);
  });

  it("binds a separate agent owner only to the canonical global session", () => {
    const global = mintAttachGrant({ sessionKey: "global", agentId: " ops ", nowMs: T0 });
    const scoped = mintAttachGrant({
      sessionKey: "agent:main:telegram:1",
      agentId: "ops",
      nowMs: T0,
    });

    expect(global.agentId).toBe("ops");
    expect(scoped.agentId).toBeUndefined();
  });

  it("revokes by token", () => {
    const g = mintAttachGrant({ sessionKey: "agent:main:x", nowMs: T0 });
    expect(revokeAttachGrant(g.token)).toBe(true);
    expect(resolveAttachGrant(g.token, T0)).toBeUndefined();
    expect(revokeAttachGrant(g.token)).toBe(false);
  });

  it("revokes every attach grant for one session", () => {
    const first = mintAttachGrant({ sessionKey: "agent:main:first", nowMs: T0 });
    const second = mintAttachGrant({ sessionKey: "agent:main:first", nowMs: T0 });
    const other = mintAttachGrant({ sessionKey: "agent:main:other", nowMs: T0 });

    expect(revokeAttachGrantsForSession(" agent:main:first ")).toBe(2);
    expect(resolveAttachGrant(first.token, T0)).toBeUndefined();
    expect(resolveAttachGrant(second.token, T0)).toBeUndefined();
    expect(resolveAttachGrant(other.token, T0)?.sessionKey).toBe("agent:main:other");
  });

  it("clamps TTL: default for non-positive, ceiling at 12h", () => {
    const def = mintAttachGrant({ sessionKey: "s", nowMs: T0 });
    expect(def.expiresAtMs).toBe(T0 + 60 * 60 * 1000);
    const zero = mintAttachGrant({ sessionKey: "s", ttlMs: 0, nowMs: T0 });
    expect(zero.expiresAtMs).toBe(T0 + 60 * 60 * 1000);
    const huge = mintAttachGrant({ sessionKey: "s", ttlMs: 999 * 60 * 60 * 1000, nowMs: T0 });
    expect(huge.expiresAtMs).toBe(T0 + 12 * 60 * 60 * 1000);
  });

  it("binds an immutable Gateway-selected context to a loopback client grant", async () => {
    const context = {
      sessionKey: " agent:main:telegram:group:1 ",
      sessionId: "session-1",
      messageProvider: "telegram",
      clientCaps: ["tool-events"],
      pinnedWidgetAuthoring: true,
      currentChannelId: "telegram:-1001",
      currentThreadTs: "42",
      currentMessageId: "message-1",
      currentInboundAudio: true,
      accountId: "account-1",
      inboundEventKind: "room_event" as const,
      sourceReplyDeliveryMode: "message_tool_only" as const,
      sourceReplyOnly: true,
      toolsAllow: ["message"],
      taskSuggestionDeliveryMode: "gateway" as const,
      requireExplicitMessageTarget: true,
      senderIsOwner: false,
    };
    const grant = mintMcpLoopbackClientGrant({
      context,
      runtimeOwnerToken: "runtime-one",
      admittedRunContext: await admitted("run-immutable-context"),
    });
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-one",
      }),
    ).toBeTruthy();

    context.clientCaps.push("caller-mutation");
    context.pinnedWidgetAuthoring = false;
    context.sourceReplyOnly = false;
    context.toolsAllow.push("exec");
    grant.context.clientCaps?.push("return-value-mutation");
    grant.context.pinnedWidgetAuthoring = false;
    grant.context.sourceReplyOnly = false;
    grant.context.toolsAllow?.push("write");

    expect(
      resolveMcpLoopbackClientGrant({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-one",
      })?.context,
    ).toEqual({
      ...context,
      sessionKey: "agent:main:telegram:group:1",
      clientCaps: ["tool-events"],
      pinnedWidgetAuthoring: true,
      sourceReplyOnly: true,
      toolsAllow: ["message"],
    });
  });

  it("admits only the active capture on the grant's Gateway runtime", async () => {
    const grant = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:first", senderIsOwner: false },
      runtimeOwnerToken: "runtime-one",
      admittedRunContext: await admitted("run-active-capture"),
    });
    const resolve = (runtimeOwnerToken: string, captureKey: string) =>
      resolveMcpLoopbackClientGrant({
        token: grant.token,
        runtimeOwnerToken,
        captureKey,
      });

    expect(resolve("runtime-one", "capture-a")).toBeUndefined();
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: "runtime-other",
        captureKey: "capture-a",
      }),
    ).toBe(false);
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-a",
      }),
    ).toBeTruthy();
    expect(resolve("runtime-other", "capture-a")).toBeUndefined();
    expect(resolve("runtime-one", "capture-forged")).toBeUndefined();
    const first = resolve("runtime-one", "capture-a");
    expect(first?.captureKey).toBe("capture-a");
    expect(first?.isCurrent()).toBe(true);

    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-b",
      }),
    ).toBeTruthy();
    expect(resolve("runtime-one", "capture-a")).toBeUndefined();
    expect(first?.isCurrent()).toBe(false);
    expect(
      deactivateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-a",
      }),
    ).toBe(false);
    const second = resolve("runtime-one", "capture-b");
    expect(second?.captureKey).toBe("capture-b");
    expect(second?.isCurrent()).toBe(true);
    expect(
      deactivateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-b",
      }),
    ).toBe(true);
    expect(resolve("runtime-one", "capture-b")).toBeUndefined();
    expect(second?.isCurrent()).toBe(false);
  });

  it("retains the exact admitted host context outside child-visible grant data", async () => {
    const admittedRunContext = await admitted("run-retained-context");
    const rootedExecution = {
      root: "/tmp/workshop",
      workspaceDir: "/tmp/workshop",
      cwd: "/tmp/workshop",
      requireWorkspaceOnly: true as const,
      sandbox: null,
    };
    const grant = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:first", senderIsOwner: false },
      runtimeOwnerToken: "runtime-one",
      admittedRunContext,
      rootedExecution,
    });
    activateMcpLoopbackClientGrantCapture({
      token: grant.token,
      runtimeOwnerToken: "runtime-one",
      captureKey: "capture-a",
    });

    const resolved = resolveMcpLoopbackClientGrant({
      token: grant.token,
      runtimeOwnerToken: "runtime-one",
      captureKey: "capture-a",
    });
    expect(resolved?.admittedRunContext).toBe(admittedRunContext);
    expect(resolved?.rootedExecution).toBe(rootedExecution);
    expect(grant.context).not.toHaveProperty("admittedRunContext");
    expect(grant.context).not.toHaveProperty("rootedExecution");
    expect(grant).not.toHaveProperty("rootedExecution");
    revokeMcpLoopbackClientGrant(grant.token);
    expect(resolved?.isCurrent()).toBe(false);
  });

  it("replaces native authority only from the current observed capture", async () => {
    const admittedRunContext = await admitted("run-native-authority");
    const grant = mintMcpLoopbackClientGrant({
      context: {
        sessionKey: "agent:main:first",
        senderIsOwner: false,
        nativeCronCreatorToolAllowlist: ["read", "exec"],
      },
      runtimeOwnerToken: "runtime-one",
      admittedRunContext,
    });
    const params = {
      token: grant.token,
      runtimeOwnerToken: "runtime-one",
      captureKey: "capture-native",
    };
    const capture = activateMcpLoopbackClientGrantCapture(params);
    if (!capture) {
      throw new Error("expected an active native capture");
    }
    const pending = resolveMcpLoopbackClientGrant(params);
    expect(pending?.context.nativeCronCreatorToolAllowlist).toBeNull();
    const observed = ["read"];
    expect(capture.captureNativeToolAuthority(observed)).toBe(true);
    observed.push("exec");
    expect(pending?.isCurrent()).toBe(false);
    expect(resolveMcpLoopbackClientGrant(params)?.context.nativeCronCreatorToolAllowlist).toEqual([
      "read",
    ]);

    expect(capture.captureNativeToolAuthority([])).toBe(true);
    expect(resolveMcpLoopbackClientGrant(params)?.context.nativeCronCreatorToolAllowlist).toEqual(
      [],
    );
    const replacement = activateMcpLoopbackClientGrantCapture(params);
    expect(replacement).toBeTruthy();
    expect(
      resolveMcpLoopbackClientGrant(params)?.context.nativeCronCreatorToolAllowlist,
    ).toBeNull();
    expect(capture.captureNativeToolAuthority(["exec"])).toBe(false);
  });

  it.each([
    "deactivate",
    "rebind",
    "transfer",
    "close",
    "revoke",
    "source-abort",
    "caller-revocation",
    "capture-abort",
    "revoke-during-assertion",
  ] as const)("rejects a retained native capture after %s", async (invalidation) => {
    const admittedRunContext = await admitted("run-stale-native");
    const sourceController = new AbortController();
    const captureController = new AbortController();
    let callerCurrent = true;
    let revokeDuringAssertion = false;
    const grant = mintMcpLoopbackClientGrant({
      context: {
        sessionKey: "agent:main:first",
        senderIsOwner: false,
        nativeCronCreatorToolAllowlist: [],
      },
      runtimeOwnerToken: "runtime-one",
      admittedRunContext,
      abortSignal: sourceController.signal,
      assertCurrent: () => {
        if (!callerCurrent) {
          throw new Error("caller revoked");
        }
        if (revokeDuringAssertion) {
          revokeMcpLoopbackClientGrant(grant.token);
        }
      },
    });
    const params = {
      token: grant.token,
      runtimeOwnerToken: "runtime-one",
      captureKey: "capture-stale-native",
    };
    const capture = activateMcpLoopbackClientGrantCapture({
      ...params,
      assertCurrent: () => captureController.signal.throwIfAborted(),
    });
    if (!capture) {
      throw new Error("expected an active native capture");
    }
    expect(capture.captureNativeToolAuthority(["read"])).toBe(true);
    const retained = resolveMcpLoopbackClientGrant(params);
    expect(retained?.isCurrent()).toBe(true);
    if (invalidation === "deactivate") {
      deactivateMcpLoopbackClientGrantCapture(params);
    } else if (invalidation === "rebind") {
      bindMcpLoopbackClientGrantAdmission({ ...params, admittedRunContext });
    } else if (invalidation === "transfer") {
      const next = mintMcpLoopbackClientGrant({
        context: grant.context,
        runtimeOwnerToken: params.runtimeOwnerToken,
        admittedRunContext: await admitted("run-next-native"),
      });
      transferMcpLoopbackClientGrant({
        sourceToken: next.token,
        targetToken: grant.token,
        runtimeOwnerToken: params.runtimeOwnerToken,
      });
      activateMcpLoopbackClientGrantCapture(params);
    } else if (invalidation === "close") {
      admissions.at(-1)?.close();
    } else if (invalidation === "source-abort") {
      sourceController.abort();
    } else if (invalidation === "caller-revocation") {
      callerCurrent = false;
    } else if (invalidation === "capture-abort") {
      captureController.abort();
    } else if (invalidation === "revoke-during-assertion") {
      revokeDuringAssertion = true;
    } else {
      revokeMcpLoopbackClientGrant(grant.token);
    }
    expect(retained?.isCurrent()).toBe(false);
    expect(capture.captureNativeToolAuthority(["exec"])).toBe(false);
    expect(capture.captureNativeToolAuthority(null)).toBe(false);
    expect(resolveMcpLoopbackClientGrant(params)?.context.nativeCronCreatorToolAllowlist).toEqual(
      invalidation === "rebind" ? ["read"] : invalidation === "transfer" ? null : undefined,
    );
  });

  it("rejects an active bearer and capture after its admitted authority closes", async () => {
    const admittedRunContext = await admitted("run-closed-grant");
    const grant = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:first", senderIsOwner: false },
      runtimeOwnerToken: "runtime-one",
      admittedRunContext,
    });
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-a",
      }),
    ).toBeTruthy();
    const resolved = resolveMcpLoopbackClientGrant({
      token: grant.token,
      runtimeOwnerToken: "runtime-one",
      captureKey: "capture-a",
    });
    expect(resolved?.isCurrent()).toBe(true);
    admissions.at(-1)?.close();
    expect(resolved?.isCurrent()).toBe(false);

    expect(
      resolveMcpLoopbackClientGrant({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-a",
      }),
    ).toBeUndefined();
  });

  it("binds one exact late admission and rejects replacement authority", async () => {
    const first = await admitted("run-late-binding");
    const grant = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:first", senderIsOwner: false },
      runtimeOwnerToken: "runtime-one",
    });

    expect(
      bindMcpLoopbackClientGrantAdmission({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        admittedRunContext: first,
      }),
    ).toBe(true);
    const replacement = await admitted("run-late-binding");
    expect(
      bindMcpLoopbackClientGrantAdmission({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        admittedRunContext: replacement,
      }),
    ).toBe(false);
  });

  it("transfers fresh turn authority onto a process-stable bearer", async () => {
    const firstAdmission = await admitted("run-first-turn");
    const nextAdmission = await admitted("run-next-turn");
    const firstController = new AbortController();
    const nextController = new AbortController();
    const skillLibraryAuthoring: SkillLibraryAuthoringCapability = {
      target: "personal",
      defaultTarget: "personal",
      multipleProfiles: true,
      bind: () => {},
      invoke: async () => {
        throw new Error("unused");
      },
    };
    const stable = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:first", runId: "run-first-turn", senderIsOwner: false },
      runtimeOwnerToken: "runtime-one",
      admittedRunContext: firstAdmission,
      abortSignal: firstController.signal,
    });
    const next = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:next", runId: "run-next-turn", senderIsOwner: true },
      runtimeOwnerToken: "runtime-one",
      admittedRunContext: nextAdmission,
      abortSignal: nextController.signal,
      skillLibraryAuthoring,
      toolAuth: {
        agentDir: "/tmp/next-agent",
        store: { version: 1, profiles: {} },
      },
    });
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: stable.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "stale-capture",
      }),
    ).toBeTruthy();
    const first = resolveMcpLoopbackClientGrant({
      token: stable.token,
      runtimeOwnerToken: "runtime-one",
      captureKey: "stale-capture",
    });
    expect(first?.isCurrent()).toBe(true);
    // Turn cleanup revokes the process bearer while the warm child still holds its token.
    // The next admitted turn must be able to restore that exact inactive bearer.
    firstController.abort();
    expect(revokeMcpLoopbackClientGrant(stable.token)).toBe(true);
    expect(first?.isCurrent()).toBe(false);
    const revocations: Array<{ token: string; runtimeOwnerToken: string }> = [];
    const unregister = registerMcpLoopbackClientGrantRevocationListener((event) => {
      revocations.push(event);
    });

    try {
      expect(
        transferMcpLoopbackClientGrant({
          sourceToken: next.token,
          targetToken: stable.token,
          runtimeOwnerToken: "runtime-two",
        }),
      ).toBe(false);
      expect(
        transferMcpLoopbackClientGrant({
          sourceToken: next.token,
          targetToken: stable.token,
          runtimeOwnerToken: "runtime-one",
        }),
      ).toBe(true);
    } finally {
      unregister();
    }

    expect(
      resolveMcpLoopbackClientGrant({
        token: stable.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "stale-capture",
      }),
    ).toBeUndefined();
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: stable.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "next-capture",
      }),
    ).toBeTruthy();
    expect(
      resolveMcpLoopbackClientGrant({
        token: stable.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "next-capture",
      }),
    ).toMatchObject({
      context: {
        sessionKey: "agent:main:next",
        runId: "run-next-turn",
        senderIsOwner: true,
      },
      admittedRunContext: nextAdmission,
      skillLibraryAuthoring,
      toolAuth: {
        agentDir: "/tmp/next-agent",
        store: { version: 1, profiles: {} },
      },
    });
    const transferred = resolveMcpLoopbackClientGrant({
      token: stable.token,
      runtimeOwnerToken: "runtime-one",
      captureKey: "next-capture",
    });
    expect(transferred?.skillLibraryAuthoring).toBe(skillLibraryAuthoring);
    expect(transferred?.isCurrent()).toBe(true);
    expect(first?.isCurrent()).toBe(false);
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: next.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "forged-source-capture",
      }),
    ).toBe(false);
    expect(revocations).toEqual([
      { token: stable.token, runtimeOwnerToken: "runtime-one" },
      { token: next.token, runtimeOwnerToken: "runtime-one" },
    ]);
    nextController.abort();
    expect(transferred?.isCurrent()).toBe(false);
    expect(
      resolveMcpLoopbackClientGrant({
        token: stable.token,
        runtimeOwnerToken: "runtime-one",
        captureKey: "next-capture",
      }),
    ).toBeUndefined();
  });

  it("revokes client grants by token or exact Gateway runtime", () => {
    const mintForRuntime = (runtimeOwnerToken: string, sessionKey: string) =>
      mintMcpLoopbackClientGrant({
        context: { sessionKey, senderIsOwner: false },
        runtimeOwnerToken,
      });
    const first = mintForRuntime("runtime-one", "agent:main:first");
    mintForRuntime("runtime-one", "agent:main:second");
    const successor = mintForRuntime("runtime-two", "agent:main:successor");

    expect(revokeMcpLoopbackClientGrantsForRuntime("runtime-one")).toBe(2);
    expect(revokeMcpLoopbackClientGrant(first.token)).toBe(false);
    expect(revokeMcpLoopbackClientGrant(successor.token)).toBe(true);
    expect(revokeMcpLoopbackClientGrant(successor.token)).toBe(false);
  });

  it("notifies revocation listeners for single and runtime-wide cleanup", () => {
    const events: Array<{ token: string; runtimeOwnerToken: string }> = [];
    const unregister = registerMcpLoopbackClientGrantRevocationListener((event) => {
      events.push(event);
    });
    try {
      const first = mintMcpLoopbackClientGrant({
        context: { sessionKey: "agent:main:first", senderIsOwner: false },
        runtimeOwnerToken: "runtime-one",
      });
      const second = mintMcpLoopbackClientGrant({
        context: { sessionKey: "agent:main:second", senderIsOwner: false },
        runtimeOwnerToken: "runtime-one",
      });

      expect(revokeMcpLoopbackClientGrant(first.token)).toBe(true);
      expect(revokeMcpLoopbackClientGrant(first.token)).toBe(false);
      expect(revokeMcpLoopbackClientGrantsForRuntime("runtime-one")).toBe(1);
      expect(events).toEqual([
        { token: first.token, runtimeOwnerToken: "runtime-one" },
        { token: second.token, runtimeOwnerToken: "runtime-one" },
      ]);
    } finally {
      unregister();
    }

    const afterUnregister = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:later", senderIsOwner: false },
      runtimeOwnerToken: "runtime-one",
    });
    expect(revokeMcpLoopbackClientGrant(afterUnregister.token)).toBe(true);
    expect(events).toHaveLength(2);
  });

  it("requires a session key for loopback client grants", () => {
    expect(() =>
      mintMcpLoopbackClientGrant({
        context: { sessionKey: "  ", senderIsOwner: false },
        runtimeOwnerToken: "runtime-one",
      }),
    ).toThrow(/sessionKey is required/);
    expect(() =>
      mintMcpLoopbackClientGrant({
        context: { sessionKey: "agent:main:main", senderIsOwner: false },
        runtimeOwnerToken: "  ",
      }),
    ).toThrow(/runtimeOwnerToken is required/);
  });

  describe("waitForMcpLoopbackClientGrantNativeToolAllowlist", () => {
    const LONG_TIMEOUT_MS = 60_000;
    // Generous enough that CI scheduling jitter cannot flip it, but far below
    // LONG_TIMEOUT_MS: proves a resolve-triggered return, not a timeout one.
    const FAST_PATH_BUDGET_MS = 2_000;

    async function mintNativeCaptureGrant(params: { runId: string; runtimeOwnerToken: string }) {
      const admittedRunContext = await admitted(params.runId);
      const grant = mintMcpLoopbackClientGrant({
        context: {
          sessionKey: `agent:main:${params.runId}`,
          senderIsOwner: false,
          nativeCronCreatorToolAllowlist: null,
        },
        runtimeOwnerToken: params.runtimeOwnerToken,
        admittedRunContext,
      });
      const capture = activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: params.runtimeOwnerToken,
        captureKey: `capture-${params.runId}`,
      });
      if (!capture) {
        throw new Error("expected an active native capture");
      }
      return { grant, capture };
    }

    it("returns immediately when the grant never gates on a native allowlist", async () => {
      const grant = mintMcpLoopbackClientGrant({
        context: { sessionKey: "agent:main:no-native-gate", senderIsOwner: false },
        runtimeOwnerToken: "runtime-one",
      });
      const startedAt = performance.now();
      await waitForMcpLoopbackClientGrantNativeToolAllowlist({
        token: grant.token,
        timeoutMs: LONG_TIMEOUT_MS,
      });
      expect(performance.now() - startedAt).toBeLessThan(FAST_PATH_BUDGET_MS);
    });

    it("returns immediately when the allowlist already resolved before the wait began", async () => {
      const { grant, capture } = await mintNativeCaptureGrant({
        runId: "already-resolved",
        runtimeOwnerToken: "runtime-one",
      });
      expect(capture.captureNativeToolAuthority(["read"])).toBe(true);
      const startedAt = performance.now();
      await waitForMcpLoopbackClientGrantNativeToolAllowlist({
        token: grant.token,
        timeoutMs: LONG_TIMEOUT_MS,
      });
      expect(performance.now() - startedAt).toBeLessThan(FAST_PATH_BUDGET_MS);
    });

    it("wakes as soon as a real allowlist lands, not at the timeout, and the live value is fresh afterward", async () => {
      const { grant, capture } = await mintNativeCaptureGrant({
        runId: "wakes-on-capture",
        runtimeOwnerToken: "runtime-one",
      });
      const startedAt = performance.now();
      const waitPromise = waitForMcpLoopbackClientGrantNativeToolAllowlist({
        token: grant.token,
        timeoutMs: LONG_TIMEOUT_MS,
      });
      // Give the wait a tick to actually start observing the token before the
      // capture lands, so this exercises the real subscribe-then-wake path
      // rather than a synchronous race.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      expect(peekMcpLoopbackClientGrantNativeToolAllowlist(grant.token)).toBeNull();
      expect(capture.captureNativeToolAuthority(["read", "exec"])).toBe(true);
      await waitPromise;
      expect(performance.now() - startedAt).toBeLessThan(FAST_PATH_BUDGET_MS);
      // The wait function itself returns nothing; correctness depends on the
      // caller re-reading live state afterward rather than any pre-wait
      // snapshot — assert that live read directly.
      expect(peekMcpLoopbackClientGrantNativeToolAllowlist(grant.token)).toEqual(["read", "exec"]);
    });

    it("a captureNativeToolAuthority(null) liveness probe does not wake waiters", async () => {
      const { grant, capture } = await mintNativeCaptureGrant({
        runId: "null-probe-no-wake",
        runtimeOwnerToken: "runtime-one",
      });
      let waitSettled = false;
      const waitPromise = waitForMcpLoopbackClientGrantNativeToolAllowlist({
        token: grant.token,
        timeoutMs: 60,
      }).then(() => {
        waitSettled = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      // Re-arming the null placeholder (as prepare.ts does to probe liveness
      // before reporting a real list) must not be mistaken for a resolution.
      expect(capture.captureNativeToolAuthority(null)).toBe(true);
      expect(waitSettled).toBe(false);
      await waitPromise;
      expect(waitSettled).toBe(true);
      expect(peekMcpLoopbackClientGrantNativeToolAllowlist(grant.token)).toBeNull();
    });

    it("wakes every concurrent waiter on the same grant together", async () => {
      const { grant, capture } = await mintNativeCaptureGrant({
        runId: "concurrent-waiters",
        runtimeOwnerToken: "runtime-one",
      });
      let firstSettled = false;
      let secondSettled = false;
      const first = waitForMcpLoopbackClientGrantNativeToolAllowlist({
        token: grant.token,
        timeoutMs: LONG_TIMEOUT_MS,
      }).then(() => {
        firstSettled = true;
      });
      const second = waitForMcpLoopbackClientGrantNativeToolAllowlist({
        token: grant.token,
        timeoutMs: LONG_TIMEOUT_MS,
      }).then(() => {
        secondSettled = true;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      expect(capture.captureNativeToolAuthority(["read"])).toBe(true);
      await Promise.all([first, second]);
      expect(firstSettled).toBe(true);
      expect(secondSettled).toBe(true);
    });

    it("falls back once timeoutMs elapses with nothing resolved, leaving the allowlist null", async () => {
      const { grant } = await mintNativeCaptureGrant({
        runId: "timeout-fallback",
        runtimeOwnerToken: "runtime-one",
      });
      const startedAt = performance.now();
      await waitForMcpLoopbackClientGrantNativeToolAllowlist({ token: grant.token, timeoutMs: 30 });
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(25);
      expect(peekMcpLoopbackClientGrantNativeToolAllowlist(grant.token)).toBeNull();
    });

    it("does not leak a pending waiter when the grant is revoked before it ever captures", async () => {
      const { grant } = await mintNativeCaptureGrant({
        runId: "revoked-mid-wait",
        runtimeOwnerToken: "runtime-one",
      });
      const startedAt = performance.now();
      const waitPromise = waitForMcpLoopbackClientGrantNativeToolAllowlist({
        token: grant.token,
        timeoutMs: LONG_TIMEOUT_MS,
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      revokeMcpLoopbackClientGrant(grant.token);
      await waitPromise;
      expect(performance.now() - startedAt).toBeLessThan(FAST_PATH_BUDGET_MS);
    });

    it("does not leak a pending waiter when its capture is deactivated before it ever captures", async () => {
      const { grant } = await mintNativeCaptureGrant({
        runId: "deactivated-mid-wait",
        runtimeOwnerToken: "runtime-one",
      });
      const startedAt = performance.now();
      const waitPromise = waitForMcpLoopbackClientGrantNativeToolAllowlist({
        token: grant.token,
        timeoutMs: LONG_TIMEOUT_MS,
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      expect(
        deactivateMcpLoopbackClientGrantCapture({
          token: grant.token,
          runtimeOwnerToken: "runtime-one",
          captureKey: "capture-deactivated-mid-wait",
        }),
      ).toBe(true);
      await waitPromise;
      expect(performance.now() - startedAt).toBeLessThan(FAST_PATH_BUDGET_MS);
    });

    it("migrates a pending waiter across a warm-token transfer so it still wakes", async () => {
      const { grant } = await mintNativeCaptureGrant({
        runId: "transfer-mid-wait",
        runtimeOwnerToken: "runtime-one",
      });
      const startedAt = performance.now();
      const waitPromise = waitForMcpLoopbackClientGrantNativeToolAllowlist({
        token: grant.token,
        timeoutMs: LONG_TIMEOUT_MS,
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      const targetToken = "warm-target-token-transfer-mid-wait";
      expect(
        transferMcpLoopbackClientGrant({
          sourceToken: grant.token,
          targetToken,
          runtimeOwnerToken: "runtime-one",
        }),
      ).toBe(true);
      const capture = activateMcpLoopbackClientGrantCapture({
        token: targetToken,
        runtimeOwnerToken: "runtime-one",
        captureKey: "capture-transfer-mid-wait",
      });
      if (!capture) {
        throw new Error("expected an active native capture on the target token");
      }
      expect(capture.captureNativeToolAuthority(["exec"])).toBe(true);
      await waitPromise;
      expect(performance.now() - startedAt).toBeLessThan(FAST_PATH_BUDGET_MS);
      expect(peekMcpLoopbackClientGrantNativeToolAllowlist(targetToken)).toEqual(["exec"]);
    });
  });
});
