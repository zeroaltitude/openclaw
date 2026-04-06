import type { AgentMessage } from "@mariozechner/pi-agent-core";
/**
 * Unit tests for before_llm_call, after_llm_call, and before_response_emit hook merge semantics.
 *
 * See hooks.context-loop.test.ts for context_assembled and loop_iteration tests.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import type { PluginRegistry } from "./registry.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeLlmCallEvent,
  PluginHookAfterLlmCallEvent,
  PluginHookBeforeResponseEmitEvent,
  PluginHookRegistration,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(hooks: PluginHookRegistration[]): PluginRegistry {
  return {
    typedHooks: hooks,
    plugins: [],
    tools: [],
    commands: [],
    configOverrides: [],
    sessionFinalizers: [],
    registeredProviders: [],
  } as unknown as PluginRegistry;
}

const agentCtx: PluginHookAgentContext = {
  agentId: "test-agent",
  sessionKey: "test-session",
};

function fakeMsg(role: string, content: string): AgentMessage {
  return { role, content } as AgentMessage;
}

// ---------------------------------------------------------------------------
// before_llm_call (modifying, sequential)
// ---------------------------------------------------------------------------

describe("before_llm_call hook", () => {
  const baseEvent: PluginHookBeforeLlmCallEvent = {
    runId: "test-run-id",
    messages: [fakeMsg("user", "hello")],
    systemPrompt: "You are helpful.",
    model: "gpt-4",
    iteration: 0,
    tools: [{ name: "read", description: "Read files" }, { name: "exec" }],
    tokenEstimate: 100,
  };

  it("fires handler with correct event shape", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([{ pluginId: "p1", hookName: "before_llm_call", handler, source: "test" }]),
    );

    await runner.runBeforeLlmCall(baseEvent, agentCtx);

    expect(handler).toHaveBeenCalledOnce();
    const [event, ctx] = handler.mock.calls[0];
    expect(event).toMatchObject({
      messages: baseEvent.messages,
      systemPrompt: "You are helpful.",
      model: "gpt-4",
      iteration: 0,
      tools: baseEvent.tools,
      tokenEstimate: 100,
    });
    expect(ctx).toBe(agentCtx);
  });

  it("returns modified messages when handler provides them", async () => {
    const newMsgs = [fakeMsg("user", "modified")];
    const handler = vi.fn().mockResolvedValue({ messages: newMsgs });
    const runner = createHookRunner(
      makeRegistry([{ pluginId: "p1", hookName: "before_llm_call", handler, source: "test" }]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result?.messages).toBe(newMsgs);
  });

  it("returns modified systemPrompt when handler provides it", async () => {
    const handler = vi.fn().mockResolvedValue({ systemPrompt: "new prompt" });
    const runner = createHookRunner(
      makeRegistry([{ pluginId: "p1", hookName: "before_llm_call", handler, source: "test" }]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result?.systemPrompt).toBe("new prompt");
  });

  it("returns filtered tools when handler provides them", async () => {
    const handler = vi.fn().mockResolvedValue({ tools: [{ name: "read" }] });
    const runner = createHookRunner(
      makeRegistry([{ pluginId: "p1", hookName: "before_llm_call", handler, source: "test" }]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result?.tools).toEqual([{ name: "read" }]);
  });

  it("returns block=true and blockReason when handler blocks", async () => {
    const handler = vi.fn().mockResolvedValue({ block: true, blockReason: "too many tokens" });
    const runner = createHookRunner(
      makeRegistry([{ pluginId: "p1", hookName: "before_llm_call", handler, source: "test" }]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("too many tokens");
  });

  it("merges results from multiple handlers in registration order (FIFO)", async () => {
    const first = vi
      .fn()
      .mockResolvedValue({ systemPrompt: "first prompt", tools: [{ name: "exec" }] });
    const second = vi.fn().mockResolvedValue({ systemPrompt: "second prompt" });
    const runner = createHookRunner(
      makeRegistry([
        {
          pluginId: "first",
          hookName: "before_llm_call",
          handler: first,
          source: "test",
        },
        {
          pluginId: "second",
          hookName: "before_llm_call",
          handler: second,
          source: "test",
        },
      ]),
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    // First-writer-wins for messages/systemPrompt: first plugin to set wins
    expect(result?.tools).toEqual([{ name: "exec" }]);
    // first runs first and provides systemPrompt → its value wins (security-first)
    expect(result?.systemPrompt).toBe("first prompt");
    // first ran before second (registration order)
    expect(first).toHaveBeenCalledBefore(second);
  });

  it("continues on handler error when catchErrors=true", async () => {
    const badHandler = vi.fn().mockRejectedValue(new Error("boom"));
    const goodHandler = vi.fn().mockResolvedValue({ systemPrompt: "survived" });
    const runner = createHookRunner(
      makeRegistry([
        {
          pluginId: "bad",
          hookName: "before_llm_call",
          handler: badHandler,

          source: "test",
        },
        {
          pluginId: "good",
          hookName: "before_llm_call",
          handler: goodHandler,

          source: "test",
        },
      ]),
      { catchErrors: true },
    );

    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result?.systemPrompt).toBe("survived");
  });

  it("skips when no handlers registered (returns undefined)", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runBeforeLlmCall(baseEvent, agentCtx);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// after_llm_call (modifying, sequential)
// ---------------------------------------------------------------------------

describe("after_llm_call hook", () => {
  const baseEvent: PluginHookAfterLlmCallEvent = {
    runId: "test-run-id",
    response: {
      role: "assistant",
      content: [] as Array<{ type: string; text: string }>,
      timestamp: Date.now(),
      api: "openai-chat",
      provider: "test",
      model: "test-model",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end_turn",
    } as unknown as AgentMessage,
    toolCalls: [
      { id: "tc1", name: "read", arguments: { path: "/a" } },
      { id: "tc2", name: "write", arguments: { path: "/b" } },
    ],
    iteration: 1,
    model: "test-model",
  };

  it("merges block from multiple handlers (one-way latch)", async () => {
    const hooks: PluginHookRegistration[] = [
      {
        pluginId: "a",
        hookName: "after_llm_call",
        handler: async () => ({ block: false }),
        priority: 10,
        source: "test",
      },
      {
        pluginId: "b",
        hookName: "after_llm_call",
        handler: async () => ({ block: true, blockReason: "policy" }),
        priority: 5,
        source: "test",
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runAfterLlmCall(baseEvent, agentCtx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("policy");
  });

  it("uses first blockReason (first-writer-wins)", async () => {
    const hooks: PluginHookRegistration[] = [
      {
        pluginId: "a",
        hookName: "after_llm_call",
        handler: async () => ({ block: true, blockReason: "reason A" }),
        priority: 10,
        source: "test",
      },
      {
        pluginId: "b",
        hookName: "after_llm_call",
        handler: async () => ({ block: true, blockReason: "reason B" }),
        priority: 5,
        source: "test",
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runAfterLlmCall(baseEvent, agentCtx);
    expect(result?.blockReason).toBe("reason A");
  });

  it("intersects toolCalls from multiple handlers", async () => {
    const hooks: PluginHookRegistration[] = [
      {
        pluginId: "a",
        hookName: "after_llm_call",
        handler: async () => ({
          toolCalls: [
            { id: "tc1", name: "read", arguments: {} },
            { id: "tc2", name: "write", arguments: {} },
          ],
        }),
        priority: 10,
        source: "test",
      },
      {
        pluginId: "b",
        hookName: "after_llm_call",
        handler: async () => ({
          toolCalls: [{ id: "tc1", name: "read", arguments: {} }],
        }),
        priority: 5,
        source: "test",
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runAfterLlmCall(baseEvent, agentCtx);
    expect(result?.toolCalls?.map((t) => t.id)).toEqual(["tc1"]);
  });

  it("returns undefined when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runAfterLlmCall(baseEvent, agentCtx);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// before_response_emit (modifying, sequential)
// ---------------------------------------------------------------------------

describe("before_response_emit hook", () => {
  const baseEvent: PluginHookBeforeResponseEmitEvent = {
    runId: "test-run-id",
    content: "Hello world",
    allContent: ["Step 1", "Step 2", "Hello world"],
    channel: "test",
    messageCount: 3,
  };

  it("uses first-writer-wins for content", async () => {
    const hooks: PluginHookRegistration[] = [
      {
        hookName: "before_response_emit",
        pluginId: "a",
        source: "test",
        priority: 100,
        handler: vi.fn().mockReturnValue({ content: "Modified A" }),
      },
      {
        hookName: "before_response_emit",
        pluginId: "b",
        source: "test",
        priority: 50,
        handler: vi.fn().mockReturnValue({ content: "Modified B" }),
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    expect(result?.content).toBe("Modified A");
  });

  it("allContent takes precedence over content when first", async () => {
    const hooks: PluginHookRegistration[] = [
      {
        hookName: "before_response_emit",
        pluginId: "a",
        source: "test",
        priority: 100,
        handler: vi.fn().mockReturnValue({ allContent: ["X", "Y", "Z"] }),
      },
      {
        hookName: "before_response_emit",
        pluginId: "b",
        source: "test",
        priority: 50,
        handler: vi.fn().mockReturnValue({ content: "Modified B" }),
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    expect(result?.allContent).toEqual(["X", "Y", "Z"]);
    expect(result?.content).toBeUndefined();
  });

  it("merges block from multiple handlers (one-way latch)", async () => {
    const hooks: PluginHookRegistration[] = [
      {
        hookName: "before_response_emit",
        pluginId: "a",
        source: "test",
        priority: 100,
        handler: vi.fn().mockReturnValue({ block: false }),
      },
      {
        hookName: "before_response_emit",
        pluginId: "b",
        source: "test",
        priority: 50,
        handler: vi.fn().mockReturnValue({ block: true, blockReason: "policy" }),
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("policy");
  });

  it("returns undefined when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    expect(result).toBeUndefined();
  });

  it("first-writer-wins: higher-priority content blocks lower-priority allContent", async () => {
    // Handler A (priority 50, runs first) sets content. Handler B (priority 10, runs second)
    // sets allContent. The merge treats content and allContent as mutually exclusive:
    // whichever field is set first blocks the other from being set by later handlers.
    const hooks = [
      {
        hookName: "before_response_emit" as const,
        pluginId: "a",
        source: "test" as const,
        priority: 50,
        handler: vi.fn().mockReturnValue({ content: "redacted by A" }),
      },
      {
        hookName: "before_response_emit" as const,
        pluginId: "b",
        source: "test" as const,
        priority: 10,
        handler: vi.fn().mockReturnValue({ allContent: ["replaced by B"] }),
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    // A ran first and set content — B's allContent is blocked (mutual exclusion).
    expect(result?.content).toBe("redacted by A");
    expect(result?.allContent).toBeUndefined();
  });

  it("first-writer-wins: higher-priority allContent is not overridden by lower-priority allContent", async () => {
    // Higher priority number = runs first = wins first-writer-wins
    const hooks = [
      {
        hookName: "before_response_emit" as const,
        pluginId: "a",
        source: "test" as const,
        priority: 50,
        handler: vi.fn().mockReturnValue({ allContent: ["first"] }),
      },
      {
        hookName: "before_response_emit" as const,
        pluginId: "b",
        source: "test" as const,
        priority: 10,
        handler: vi.fn().mockReturnValue({ allContent: ["second"] }),
      },
    ];
    const runner = createHookRunner(makeRegistry(hooks));
    const result = await runner.runBeforeResponseEmit(baseEvent, agentCtx);
    expect(result?.allContent).toEqual(["first"]);
  });
});
