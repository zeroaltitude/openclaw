import { afterEach, describe, expect, it } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { TaskFlowListAllEntry } from "../../lib/task-flows/data.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./task-flows-page.ts";

type TaskFlowsPageTestElement = HTMLElement & {
  context: ApplicationContext;
  flows: TaskFlowListAllEntry[];
  error: string | null;
  refreshFlows: () => Promise<void>;
};

function flow(overrides: Partial<TaskFlowListAllEntry> = {}): TaskFlowListAllEntry {
  return {
    flowId: "flow-1",
    ownerKey: "agent:ops:main",
    agentId: "ops",
    syncMode: "managed",
    status: "running",
    goal: "Ship the thing",
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function createGateway(client: GatewayBrowserClient) {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  let snapshotListener: ((snapshot: ApplicationGatewaySnapshot) => void) | undefined;
  const gateway = {
    snapshot,
    subscribe(listener: (snapshot: ApplicationGatewaySnapshot) => void) {
      snapshotListener = listener;
      return () => {
        if (snapshotListener === listener) {
          snapshotListener = undefined;
        }
      };
    },
    subscribeEvents() {
      return () => undefined;
    },
  } as unknown as ApplicationContext["gateway"];
  return { gateway };
}

function createContext(gateway: ApplicationContext["gateway"]): ApplicationContext {
  const subscribe = () => () => undefined;
  return {
    basePath: "",
    gateway,
    agents: {
      state: { agentsList: null },
      ensureList: async () => undefined,
      subscribe,
    },
    agentSelection: {
      state: { selectedId: null, scopeId: null },
      set: () => undefined,
      setScope: () => undefined,
      subscribe,
    },
    navigate: () => undefined,
    preload: async () => undefined,
  } as unknown as ApplicationContext;
}

describe("openclaw-task-flows-page", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("loads TaskFlow records across every owner returned by taskFlows.listAll", async () => {
    const flows = [
      flow({ flowId: "flow-ops", ownerKey: "agent:ops:main", agentId: "ops" }),
      flow({
        flowId: "flow-main",
        ownerKey: "agent:main:night-watch",
        agentId: "main",
        status: "waiting",
        waitingForMs: 5_000,
        wait: { kind: "approval" },
      }),
    ];
    const client = createTestGatewayClient(async (method) => {
      expect(method).toBe("taskFlows.listAll");
      return { flows };
    });
    const source = createGateway(client);
    const page = document.createElement("openclaw-task-flows-page") as TaskFlowsPageTestElement;
    page.context = createContext(source.gateway);
    document.body.append(page);
    await waitForFast(() => expect(page.flows).toHaveLength(2));
    expect(page.flows.map((f) => f.flowId).toSorted()).toEqual(["flow-main", "flow-ops"]);
    expect(page.error).toBeNull();
  });

  it("surfaces a FORBIDDEN cross-agent visibility refusal as the page error", async () => {
    const client = createTestGatewayClient(async () => {
      throw new GatewayRequestError({
        code: "FORBIDDEN",
        message: "Cross-agent TaskFlow visibility includes flows hidden by your operator role.",
      });
    });
    const source = createGateway(client);
    const page = document.createElement("openclaw-task-flows-page") as TaskFlowsPageTestElement;
    page.context = createContext(source.gateway);
    document.body.append(page);
    await waitForFast(() => expect(page.error).not.toBeNull());
    expect(page.error).toContain("Cross-agent TaskFlow visibility");
    expect(page.flows).toHaveLength(0);
  });
});
