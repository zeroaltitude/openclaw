/**
 * Real-behavior proof for the `taskFlows.listAll` gateway method.
 *
 * Why this exists: every other TaskFlow read path is owner-scoped. `taskFlows.listAll`
 * deliberately is not, so the thing worth proving is not "the list works" but that the
 * bypass is *bounded* — it returns foreign owners' flows only through the new
 * operator-gated method, while the pre-existing owner-scoped accessor still refuses the
 * exact same foreign flow id.
 *
 * Real vs stubbed:
 *   - REAL: the TaskFlow registry (`createManagedTaskFlow`, `listTaskFlowRecords`,
 *     `getTaskFlowById`) backed by a real on-disk SQLite store in a temp state dir.
 *   - REAL: `handleGatewayRequest` — the production gateway dispatcher, including its
 *     scope enforcement and the `taskFlows.listAll` handler's operator-role gate.
 *   - REAL: `getTaskFlowByIdForOwner` (src/tasks/task-flow-owner-access.ts), the
 *     owner-scoped path whose boundary must survive this change.
 *   - REAL: `resolveOperatorRolePolicyForProfile` via `operatorSessionCap`, driven by a
 *     genuine `gateway.roles` config and a genuine user profile.
 *   - STUBBED (edge only): the `respond` callback and `getRuntimeConfig`, which are the
 *     dispatcher's caller contract, not the seam under test. Nothing between the
 *     dispatcher entrypoint and the registry is faked.
 *
 * Scenarios:
 *   1. Cross-agent listing: two flows created under two DIFFERENT owner keys
 *      (`agent:ops:main`, `agent:main:night-watch`) both come back from one call.
 *   2. Owner boundary intact: `getTaskFlowByIdForOwner` refuses the foreign flow id for
 *      each owner, and still returns each owner its own flow.
 *   3. Permission gate denies: an operator role with `sessions.others: "none"` is
 *      refused with FORBIDDEN, and the payload carries no flow data.
 *   4. Permission gate admits admin: `operator.admin` passes even under that same
 *      `"none"` role cap.
 *   5. Scope enforcement: a caller without `operator.read` is rejected by the dispatcher
 *      before the handler runs.
 *
 * Run: pnpm tsx scripts/proof-bi92-taskflow-cross-agent-list.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ErrorShape } from "../packages/gateway-protocol/src/schema/frames.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  RespondFn,
} from "../src/gateway/server-methods/types.js";

const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-proof-bi92-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
// Keep the proof off any real gateway/agent state and out of the user's config.
process.env.OPENCLAW_CONFIG_DIR = stateDir;

const failures: string[] = [];
let checks = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  const rendered = detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`;
  console.log(`  FAIL ${label}${rendered}`);
  failures.push(`${label}${rendered}`);
}

async function main(): Promise<void> {
  const { createManagedTaskFlow, getTaskFlowById, listTaskFlowRecords } =
    await import("../src/tasks/task-flow-registry.js");
  const { getTaskFlowByIdForOwner } = await import("../src/tasks/task-flow-owner-access.js");
  const { handleGatewayRequest } = await import("../src/gateway/server-methods.js");
  const { ensureProfileForEmail } = await import("../src/state/user-profiles.js");

  type Responded = { ok: boolean; payload?: unknown; error?: ErrorShape };

  function callerClient(profileId: string | undefined, scopes: string[]): GatewayClient {
    return {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "openclaw-control-ui", version: "proof", platform: "proof", mode: "webchat" },
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

  function rolesConfig(others: "none" | "view"): OpenClawConfig {
    return {
      gateway: {
        roles: {
          default: "limited",
          definitions: {
            // `agents: ["main"]` is deliberate: it proves the agent allowlist is a
            // session-creation ceiling, not a read filter, so a "main"-only role still
            // sees the "ops" agent's flow through this method.
            limited: { sessions: { others }, agents: ["main"], scopes: ["operator.read"] },
          },
        },
      },
    } as OpenClawConfig;
  }

  async function listAll(cfg: OpenClawConfig, client: GatewayClient): Promise<Responded> {
    let captured: Responded | undefined;
    const respond: RespondFn = (ok, payload, error) => {
      captured = { ok, payload, error };
    };
    await handleGatewayRequest({
      req: { type: "req", id: "proof-bi92", method: "taskFlows.listAll", params: {} },
      respond,
      client,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => cfg,
        logGateway: { warn: () => {} },
      } as unknown as GatewayRequestContext,
    });
    if (!captured) {
      throw new Error("taskFlows.listAll never responded");
    }
    return captured;
  }

  // --- Seed two flows under two genuinely different owner keys, real registry. ---
  const opsFlow = createManagedTaskFlow({
    ownerKey: "agent:ops:main",
    goal: "ops owner flow",
    controllerId: "scripts/proof-bi92",
  });
  const mainFlow = createManagedTaskFlow({
    ownerKey: "agent:main:night-watch",
    goal: "main owner flow",
    controllerId: "scripts/proof-bi92",
    status: "waiting",
    waitJson: { kind: "approval", approvalId: "appr-proof-bi92" },
    updatedAt: Date.now() - 5_000,
  });

  console.log("scenario 1: cross-agent listing through the new gateway method");
  check("ops flow created in the real registry", Boolean(opsFlow));
  check("main flow created in the real registry", Boolean(mainFlow));
  if (!opsFlow || !mainFlow) {
    throw new Error("registry did not create the seed flows; cannot prove anything");
  }
  check(
    "registry itself holds both owner keys",
    new Set(listTaskFlowRecords().map((flow) => flow.ownerKey)).size === 2,
    listTaskFlowRecords().map((flow) => flow.ownerKey),
  );

  const viewerProfile = ensureProfileForEmail("proof-bi92-viewer@example.test");
  const allowed = await listAll(
    rolesConfig("view"),
    callerClient(viewerProfile.id, ["operator.read"]),
  );
  check("authorized caller is allowed", allowed.ok, allowed.error);
  const listedFlows = (allowed.payload as { flows?: Array<Record<string, unknown>> } | undefined)
    ?.flows;
  check("payload carries a flows array", Array.isArray(listedFlows));
  const listedIds = (listedFlows ?? []).map((flow) => String(flow.flowId)).toSorted();
  check(
    "both owners' flows are returned to one caller",
    listedIds.join(",") === [opsFlow.flowId, mainFlow.flowId].toSorted().join(","),
    listedIds,
  );
  const opsEntry = (listedFlows ?? []).find((flow) => flow.flowId === opsFlow.flowId);
  check("foreign owner's flow carries its parsed agentId", opsEntry?.agentId === "ops", opsEntry);
  check(
    "foreign owner's ownerKey is reported verbatim",
    opsEntry?.ownerKey === "agent:ops:main",
    opsEntry,
  );
  const waitingEntry = (listedFlows ?? []).find((flow) => flow.flowId === mainFlow.flowId);
  check("waiting flow keeps its status", waitingEntry?.status === "waiting", waitingEntry);
  check(
    "waiting flow exposes the approval wait payload",
    JSON.stringify(waitingEntry?.wait) ===
      JSON.stringify({ kind: "approval", approvalId: "appr-proof-bi92" }),
    waitingEntry?.wait,
  );
  check(
    "waitingForMs measures the approval-gate pause",
    typeof waitingEntry?.waitingForMs === "number" && waitingEntry.waitingForMs >= 5_000,
    waitingEntry?.waitingForMs,
  );

  console.log("scenario 2: the owner-scoped path still refuses the foreign owner");
  check(
    "getTaskFlowByIdForOwner refuses ops' flow to the main owner",
    getTaskFlowByIdForOwner({
      flowId: opsFlow.flowId,
      callerOwnerKey: "agent:main:night-watch",
    }) === undefined,
  );
  check(
    "getTaskFlowByIdForOwner refuses main's flow to the ops owner",
    getTaskFlowByIdForOwner({
      flowId: mainFlow.flowId,
      callerOwnerKey: "agent:ops:main",
    }) === undefined,
  );
  check(
    "getTaskFlowByIdForOwner still returns ops' own flow",
    getTaskFlowByIdForOwner({ flowId: opsFlow.flowId, callerOwnerKey: "agent:ops:main" })
      ?.flowId === opsFlow.flowId,
  );
  check(
    "getTaskFlowByIdForOwner still returns main's own flow",
    getTaskFlowByIdForOwner({ flowId: mainFlow.flowId, callerOwnerKey: "agent:main:night-watch" })
      ?.flowId === mainFlow.flowId,
  );
  // The unscoped registry read is what the new method uses; prove the flows really are
  // reachable there, so the refusals above come from the owner check and not an empty store.
  check(
    "the same foreign flow IS reachable through the unscoped registry read",
    getTaskFlowById(opsFlow.flowId)?.flowId === opsFlow.flowId,
  );

  console.log("scenario 3: operator role capped to 'none' is refused");
  const deniedProfile = ensureProfileForEmail("proof-bi92-guest@example.test");
  const denied = await listAll(
    rolesConfig("none"),
    callerClient(deniedProfile.id, ["operator.read"]),
  );
  check("capped caller is refused", !denied.ok);
  check("refusal uses FORBIDDEN", denied.error?.code === "FORBIDDEN", denied.error);
  check("refusal leaks no flow payload", denied.payload === undefined, denied.payload);

  console.log("scenario 4: Gateway admin passes the same 'none' cap");
  const adminProfile = ensureProfileForEmail("proof-bi92-admin@example.test");
  const admin = await listAll(
    rolesConfig("none"),
    callerClient(adminProfile.id, ["operator.admin"]),
  );
  check("admin caller is allowed", admin.ok, admin.error);
  const adminIds = (
    (admin.payload as { flows?: Array<Record<string, unknown>> } | undefined)?.flows ?? []
  ).map((flow) => String(flow.flowId));
  check("admin sees the foreign owner's flow", adminIds.includes(opsFlow.flowId), adminIds);

  console.log("scenario 5: dispatcher rejects a caller lacking operator.read");
  const unscoped = await listAll({}, callerClient(undefined, ["operator.questions"]));
  check("unscoped caller is rejected", !unscoped.ok);
  check("rejection leaks no flow payload", unscoped.payload === undefined, unscoped.payload);
}

main()
  .then(() => {
    rmSync(stateDir, { recursive: true, force: true });
    if (failures.length > 0) {
      console.log(`\n${failures.length} of ${checks} assertions FAILED:`);
      for (const failure of failures) {
        console.log(`  - ${failure}`);
      }
      process.exit(1);
    }
    console.log(`\nAll runtime assertions passed. (${checks} checks)`);
    process.exit(0);
  })
  .catch((error: unknown) => {
    rmSync(stateDir, { recursive: true, force: true });
    console.error("proof failed:", error);
    process.exit(1);
  });
