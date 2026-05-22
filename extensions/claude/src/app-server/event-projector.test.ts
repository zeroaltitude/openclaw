import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  ClaudeAppServerEventProjector,
  extractItemName,
  isToolItem,
  type ProjectorAccumulator,
} from "./event-projector.js";
import type { RpcNotification } from "./types.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const TURN_ID = "turn_test_001";

function emptyAcc(): ProjectorAccumulator {
  return {
    assistantTexts: [],
    toolMetas: [],
    reasoning: "",
    itemCount: 0,
    toolCalls: new Map(),
  };
}

function makeParams(): EmbeddedRunAttemptParams {
  return {
    runId: "run_test",
  } as unknown as EmbeddedRunAttemptParams;
}

function makeProjector(acc: ProjectorAccumulator): ClaudeAppServerEventProjector {
  return new ClaudeAppServerEventProjector(TURN_ID, acc, makeParams(), {
    runId: "run_test",
    agentId: "tank",
    sessionId: "s_1",
    sessionKey: "agent:tank:test",
    channelId: "discord",
  });
}

function notif(method: string, params: Record<string, unknown>): RpcNotification {
  return { jsonrpc: "2.0", method, params } as RpcNotification;
}

// ── pure helpers ────────────────────────────────────────────────────────────

describe("isToolItem", () => {
  it.each(["dynamicToolCall", "toolCall", "mcpToolCall"])("recognizes %s", (type) => {
    expect(isToolItem({ type })).toBe(true);
  });

  it.each(["agentMessage", "plan", "file", "shell", "reasoning", ""])("rejects %s", (type) => {
    expect(isToolItem({ type })).toBe(false);
  });

  it("rejects items without a type field", () => {
    expect(isToolItem({})).toBe(false);
  });
});

describe("extractItemName", () => {
  it("prefers name over tool", () => {
    expect(extractItemName({ name: "primary", tool: "secondary" })).toBe("primary");
  });
  it("falls back to tool when name missing", () => {
    expect(extractItemName({ tool: "secondary" })).toBe("secondary");
  });
  it("returns undefined when both missing", () => {
    expect(extractItemName({ type: "agentMessage" })).toBeUndefined();
  });
});

// ── matchesTurn ─────────────────────────────────────────────────────────────

describe("matchesTurn", () => {
  it("matches by params.turnId", () => {
    const projector = makeProjector(emptyAcc());
    expect(projector.matchesTurn(notif("turn/completed", { turnId: TURN_ID }))).toBe(true);
  });

  it("matches by params.turn.id (nested)", () => {
    const projector = makeProjector(emptyAcc());
    expect(projector.matchesTurn(notif("turn/completed", { turn: { id: TURN_ID } }))).toBe(true);
  });

  it("rejects notifications for a different turn", () => {
    const projector = makeProjector(emptyAcc());
    expect(projector.matchesTurn(notif("turn/completed", { turnId: "other" }))).toBe(false);
  });

  it("rejects notifications without any turn identity", () => {
    const projector = makeProjector(emptyAcc());
    expect(projector.matchesTurn(notif("item/started", { item: {} }))).toBe(false);
  });
});

// ── processNotification: terminal outcomes ──────────────────────────────────

describe("processNotification (terminal)", () => {
  it("emits a completed outcome on turn/completed for the current turn", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    const outcome = projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: { id: TURN_ID, status: "completed", items: [] },
      }),
    );
    expect(outcome).not.toBeNull();
    expect(outcome?.kind).toBe("completed");
  });

  it("emits a failed outcome on turn/completed with status=failed", () => {
    const projector = makeProjector(emptyAcc());
    const outcome = projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: { id: TURN_ID, status: "failed", error: { message: "boom" } },
      }),
    );
    expect(outcome?.kind).toBe("failed");
    if (outcome?.kind === "failed") {
      expect(outcome.error.message).toContain("boom");
    }
  });

  it("emits a failed outcome on turn/error", () => {
    const projector = makeProjector(emptyAcc());
    const outcome = projector.processNotification(
      notif("turn/error", { turnId: TURN_ID, error: { message: "timeout" } }),
    );
    expect(outcome?.kind).toBe("failed");
    if (outcome?.kind === "failed") {
      expect(outcome.error.message).toContain("timeout");
    }
  });

  it("returns null for notifications belonging to another turn", () => {
    const projector = makeProjector(emptyAcc());
    expect(
      projector.processNotification(notif("turn/completed", { turnId: "other-turn" })),
    ).toBeNull();
  });

  it("does not double-settle after a terminal notification", () => {
    const projector = makeProjector(emptyAcc());
    const first = projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: { id: TURN_ID, status: "completed" },
      }),
    );
    expect(first?.kind).toBe("completed");
    const second = projector.processNotification(
      notif("turn/error", { turnId: TURN_ID, error: { message: "after-settle" } }),
    );
    expect(second).toBeNull();
  });

  it("respects external markSettled (e.g. idle-timeout path)", () => {
    const projector = makeProjector(emptyAcc());
    projector.markSettled();
    const outcome = projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: { id: TURN_ID, status: "completed" },
      }),
    );
    expect(outcome).toBeNull();
  });
});

// ── processNotification: accumulator mutation ───────────────────────────────

describe("processNotification (accumulator)", () => {
  it("records tool start events into toolMetas + toolCalls", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: {
          type: "dynamicToolCall",
          id: "call_1",
          name: "image",
          arguments: { url: "https://example.com" },
        },
      }),
    );
    expect(acc.toolMetas).toEqual([{ toolName: "image" }]);
    expect(acc.toolCalls.get("call_1")?.name).toBe("image");
    expect(acc.toolCalls.get("call_1")?.isDynamic).toBe(true);
  });

  it("pairs tool completion onto the prior start record", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: { type: "toolCall", id: "call_a", name: "Read", arguments: { path: "x" } },
      }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: {
          type: "toolCall",
          id: "call_a",
          name: "Read",
          result: "file contents",
          status: "completed",
        },
      }),
    );
    const call = acc.toolCalls.get("call_a");
    expect(call?.result).toBe("file contents");
    expect(call?.isError).toBe(false);
    expect(acc.itemCount).toBe(1);
  });

  it("preserves contentItems payload on dynamic-tool completion", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: { type: "dynamicToolCall", id: "dyn_1", name: "vestige_search" },
      }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: {
          type: "dynamicToolCall",
          id: "dyn_1",
          name: "vestige_search",
          contentItems: [{ type: "inputText", text: "hits..." }],
          status: "completed",
        },
      }),
    );
    expect(acc.toolCalls.get("dyn_1")?.result).toEqual([{ type: "inputText", text: "hits..." }]);
  });

  it("flags errored tool completions via isError", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/started", {
        turnId: TURN_ID,
        item: { type: "toolCall", id: "fail_1", name: "Bash" },
      }),
    );
    projector.processNotification(
      notif("item/completed", {
        turnId: TURN_ID,
        item: { type: "toolCall", id: "fail_1", name: "Bash", status: "failed" },
      }),
    );
    expect(acc.toolCalls.get("fail_1")?.isError).toBe(true);
  });

  it("ignores items missing the item field entirely", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(notif("item/started", { turnId: TURN_ID }));
    expect(acc.toolMetas).toEqual([]);
    expect(acc.itemCount).toBe(0);
  });
});

// ── finalize: deltas folded into accumulator ────────────────────────────────

describe("finalize", () => {
  it("folds streamed text deltas into acc.assistantTexts", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/agentMessage/delta", { turnId: TURN_ID, delta: "hello " }),
    );
    projector.processNotification(
      notif("item/agentMessage/delta", { turnId: TURN_ID, delta: "world" }),
    );
    projector.finalize();
    expect(acc.assistantTexts).toEqual(["hello world"]);
  });

  it("folds streamed reasoning deltas into acc.reasoning", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("item/reasoning/delta", { turnId: TURN_ID, delta: "thinking " }),
    );
    projector.processNotification(
      notif("item/reasoning/delta", { turnId: TURN_ID, delta: "step 2" }),
    );
    projector.finalize();
    expect(acc.reasoning).toBe("thinking step 2");
  });

  it("picks up agentMessage text from turn/completed when no deltas streamed", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.processNotification(
      notif("turn/completed", {
        turnId: TURN_ID,
        turn: {
          id: TURN_ID,
          status: "completed",
          items: [{ type: "agentMessage", text: "non-streaming reply" }],
        },
      }),
    );
    projector.finalize();
    expect(acc.assistantTexts).toEqual(["non-streaming reply"]);
  });

  it("is a no-op when no deltas streamed and no terminal text appeared", () => {
    const acc = emptyAcc();
    const projector = makeProjector(acc);
    projector.finalize();
    expect(acc.assistantTexts).toEqual([]);
    expect(acc.reasoning).toBe("");
  });
});
