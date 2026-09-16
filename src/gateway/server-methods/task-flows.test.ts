// Covers taskFlows.listAll's cross-agent, cross-session visibility and its
// operator-role permission gate (the whole point of the method is to bypass
// the per-owner boundary every other TaskFlow access path enforces, so the
// gate itself is the thing most worth pinning here).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createFlowRecord,
  resetTaskFlowRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

function client(profileId?: string, scopes = ["operator.read"]): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
    },
    ...(profileId
      ? {
          authenticatedUserProfile: {
            profileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  } as GatewayClient;
}

function roles(others: "none" | "view"): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "limited",
        definitions: {
          limited: { sessions: { others }, agents: ["main"], scopes: ["operator.read"] },
        },
      },
    },
  } as OpenClawConfig;
}

async function request(
  cfg: OpenClawConfig = {},
  caller: GatewayClient = client(),
  params: Record<string, unknown> = {},
) {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: { type: "req", id: "task-flows-list-all", method: "taskFlows.listAll", params },
    respond,
    client: caller,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => cfg,
      logGateway: { warn: () => {} },
    } as unknown as GatewayRequestContext,
  });
  expect(respond).toHaveBeenCalledTimes(1);
  return respond.mock.calls[0]!;
}

describe("taskFlows.listAll cross-agent visibility", () => {
  afterEach(() => resetTaskFlowRegistryForTests({ persist: false }));

  it("denies every caller whose operator role hides other sessions, even though listing across owners is the method's job", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      resetTaskFlowRegistryForTests({ persist: false });
      createFlowRecord({
        ownerKey: "agent:ops:main",
        goal: "ops flow",
        controllerId: "tests/task-flows-list-all",
      });
      const profile = ensureProfileForEmail("taskflow-guest@example.test");
      const cfg = roles("none");
      const [ok, payload, error] = await request(cfg, client(profile.id));
      expect(ok).toBe(false);
      expect(payload).toBeUndefined();
      expect(error).toMatchObject({ code: "FORBIDDEN" });
    });
  });

  it("lists TaskFlow records across every agent/session for an authorized caller, not just the caller's own owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      resetTaskFlowRegistryForTests({ persist: false });
      const opsFlow = createFlowRecord({
        ownerKey: "agent:ops:main",
        goal: "ops flow",
        controllerId: "tests/task-flows-list-all",
      });
      const mainFlow = createFlowRecord({
        ownerKey: "agent:main:night-watch",
        goal: "main flow",
        controllerId: "tests/task-flows-list-all",
        status: "waiting",
        waitJson: { kind: "approval", approvalId: "appr-1" },
        updatedAt: Date.now() - 5_000,
      });
      expect(opsFlow).toBeTruthy();
      expect(mainFlow).toBeTruthy();
      const profile = ensureProfileForEmail("taskflow-viewer@example.test");
      const caller = client(profile.id);
      const cfg = roles("view");
      // The caller's own operator role only allowlists agent "main" for session
      // *creation*, yet the response still includes the "ops" owner's flow —
      // this is the assertion that actually distinguishes listAll from every
      // owner-scoped TaskFlow path.
      const [ok, payload] = await request(cfg, caller);
      expect(ok).toBe(true);
      const flows = (payload as { flows: Array<Record<string, unknown>> }).flows;
      expect(flows.map((flow) => flow.flowId).toSorted()).toEqual(
        [opsFlow!.flowId, mainFlow!.flowId].toSorted(),
      );
      const ops = flows.find((flow) => flow.flowId === opsFlow!.flowId)!;
      expect(ops.agentId).toBe("ops");
      expect(ops.ownerKey).toBe("agent:ops:main");
      const waiting = flows.find((flow) => flow.flowId === mainFlow!.flowId)!;
      expect(waiting.agentId).toBe("main");
      expect(waiting.status).toBe("waiting");
      expect(waiting.wait).toEqual({ kind: "approval", approvalId: "appr-1" });
      expect(waiting.waitingForMs).toBeGreaterThanOrEqual(5_000);
    });
  });

  it("lets the Gateway admin scope through even when the operator role caps others to none", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      resetTaskFlowRegistryForTests({ persist: false });
      const flow = createFlowRecord({
        ownerKey: "agent:ops:main",
        goal: "ops flow",
        controllerId: "tests/task-flows-list-all",
      });
      const profile = ensureProfileForEmail("taskflow-admin@example.test");
      const [ok, payload] = await request(roles("none"), client(profile.id, ["operator.admin"]));
      expect(ok).toBe(true);
      const flows = (payload as { flows: Array<Record<string, unknown>> }).flows;
      expect(flows.map((f) => f.flowId)).toContain(flow!.flowId);
    });
  });

  it("rejects a caller missing the operator.read scope before the handler ever runs", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      resetTaskFlowRegistryForTests({ persist: false });
      const [ok, , error] = await request({}, client(undefined, ["operator.questions"]));
      expect(ok).toBe(false);
      expect(error?.details).toMatchObject({ missingScope: "operator.read" });
    });
  });
});
