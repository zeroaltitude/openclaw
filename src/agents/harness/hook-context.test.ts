import { describe, expect, it } from "vitest";

import { buildAgentHookContext } from "./hook-context.js";

describe("buildAgentHookContext", () => {
  it("forwards runId and basic fields", () => {
    const ctx = buildAgentHookContext({
      runId: "r1",
      agentId: "main",
      sessionKey: "agent:main:discord:dm:owner",
      sessionId: "s1",
      workspaceDir: "/ws",
      messageProvider: "discord",
      trigger: "command",
      channelId: "discord",
    });
    expect(ctx).toEqual({
      runId: "r1",
      agentId: "main",
      sessionKey: "agent:main:discord:dm:owner",
      sessionId: "s1",
      workspaceDir: "/ws",
      messageProvider: "discord",
      trigger: "command",
      channelId: "discord",
    });
  });

  it("forwards extended identity fields when set", () => {
    const ctx = buildAgentHookContext({
      runId: "r2",
      sourceProvider: "slack",
      senderId: "U010622FNQP",
      senderName: "Eddie Abrams",
      senderIsOwner: true,
      groupId: "C0AG7JAG35G",
      spawnedBy: "agent:main:slack:tabitha:dm:owner",
    });
    expect(ctx.sourceProvider).toBe("slack");
    expect(ctx.senderId).toBe("U010622FNQP");
    expect(ctx.senderName).toBe("Eddie Abrams");
    expect(ctx.senderIsOwner).toBe(true);
    expect(ctx.groupId).toBe("C0AG7JAG35G");
    expect(ctx.spawnedBy).toBe("agent:main:slack:tabitha:dm:owner");
  });

  it("preserves explicit null for nullable identity fields", () => {
    // Plugins may need to distinguish "explicitly no sender / not a sub-agent"
    // (null) from "field unset" (undefined). Forward null verbatim.
    const ctx = buildAgentHookContext({
      runId: "r3",
      senderId: null,
      senderName: null,
      groupId: null,
      spawnedBy: null,
    });
    expect(ctx.senderId).toBeNull();
    expect(ctx.senderName).toBeNull();
    expect(ctx.groupId).toBeNull();
    expect(ctx.spawnedBy).toBeNull();
  });

  it("forwards senderIsOwner=false (boolean false is meaningful, must not be dropped)", () => {
    const ctx = buildAgentHookContext({
      runId: "r4",
      senderIsOwner: false,
    });
    expect(ctx.senderIsOwner).toBe(false);
  });

  it("omits identity fields when undefined", () => {
    const ctx = buildAgentHookContext({ runId: "r5" });
    expect(ctx).toEqual({ runId: "r5" });
    expect("sourceProvider" in ctx).toBe(false);
    expect("senderId" in ctx).toBe(false);
    expect("senderName" in ctx).toBe(false);
    expect("senderIsOwner" in ctx).toBe(false);
    expect("groupId" in ctx).toBe(false);
    expect("spawnedBy" in ctx).toBe(false);
  });

  it("omits empty-string sourceProvider (truthy-spread semantics, matches messageProvider behaviour)", () => {
    // sourceProvider is a non-nullable optional string like messageProvider —
    // empty strings are not meaningful sources, so the truthy spread is correct.
    const ctx = buildAgentHookContext({ runId: "r6", sourceProvider: "" });
    expect("sourceProvider" in ctx).toBe(false);
  });
});
