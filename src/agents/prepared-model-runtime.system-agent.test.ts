// Install the shared discovery fixtures before the real prepared-runtime owner.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSystemAgentGatewayTask } from "../gateway/server-methods/system-agent-execution.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../plugins/runtime/generation-scope.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "./prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("system-agent Gateway runtime admission", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "system-agent-generation" });
    await resetPreparedModelRuntimeHarness(state);
    mocks.configuredAgentIds = ["tank", "main"];
  });

  afterEach(async (context) => {
    resetCommandQueueStateForTest();
    await cleanupPreparedModelRuntimeHarness(state, context.task.result?.state === "fail");
  });

  it("re-admits independent system work without inheriting the requesting turn's generation", async () => {
    const previousConfig = { messages: { responsePrefix: "previous" } };
    const config = { messages: { responsePrefix: "current" } };
    const publication = { gatewayLifecycle: true, catalogMode: "static" as const };
    await refreshPreparedModelRuntimeSnapshots(previousConfig, publication);
    const caller = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "tank" });
    if (!caller?.pluginGeneration) {
      throw new Error("Missing caller generation");
    }
    await refreshPreparedModelRuntimeSnapshots(config, publication);
    const current = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
    if (!current?.pluginGeneration) {
      throw new Error("Missing current generation");
    }
    expect(current.pluginGeneration).not.toBe(caller.pluginGeneration);
    const signal = new AbortController();
    await withGatewayToolCallerIdentity(
      { agentId: "tank", sessionKey: "agent:tank:main", approvalSignals: [signal.signal] },
      () =>
        withPreparedModelRuntimePluginGenerationScope(caller.pluginGeneration, () =>
          withPluginRuntimeGenerationScope(
            {
              metadataSnapshot: caller.pluginGeneration.pluginMetadataSnapshot,
              pluginRegistry: caller.pluginGeneration.pluginRegistry,
            },
            async () => {
              const identity = getGatewayToolCallerIdentity();
              await runSystemAgentGatewayTask(async () => {
                // Match the embedded runner's ambient generation selection and use
                // the real lease guard, not a simulated superseded error.
                await using lease = await acquireAgentRunPreparedModelRuntime(
                  { config, agentId: "main", agentDir: state.agentDir("main") },
                  { pluginGeneration: getPreparedModelRuntimePluginGeneration() },
                );
                expect(lease.pluginGeneration).toBe(current.pluginGeneration);
                expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
                expect(getGatewayToolCallerIdentity()).toBe(identity);
                signal.abort();
                expect(getGatewayToolCallerIdentity()?.approvalSignals?.[0]?.aborted).toBe(true);
              });
              expect(getPreparedModelRuntimePluginGeneration()).toBe(caller.pluginGeneration);
              expect(getPluginRuntimeGenerationRegistry()).toBe(
                caller.pluginGeneration.pluginRegistry,
              );
            },
          ),
        ),
    );
  });
});
