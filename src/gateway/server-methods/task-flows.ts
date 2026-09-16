// Gateway method exposing cross-agent, cross-session TaskFlow visibility.
//
// Every other TaskFlow access path (the `taskflow` plugin runtime tool used by
// list/show/resume actions, see ../../tasks/task-flow-owner-access.ts) is
// strictly scoped to the calling session's own ownerKey. `taskFlows.listAll`
// is deliberately NOT owner-scoped: it is the one place an operator can see
// managed-flow state across every agent and session at once. Because it
// bypasses the normal per-owner boundary, it is gated the same way other
// Gateway-wide read surfaces are (usage.cost, transcripts.*): callers whose
// operator role caps `sessions.others` at "none" are refused, and the
// Gateway owner/admin scope always passes.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import type { JsonValue, TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import { listTaskFlowRecords } from "../../tasks/task-flow-runtime-internal.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { isGatewayAdmin } from "../session-sharing.js";
import type { GatewayRequestHandlers } from "./types.js";

export type TaskFlowListAllEntry = {
  flowId: string;
  ownerKey: string;
  /** Parsed from `ownerKey` (`agent:<agentId>:<rest>`); absent for non-agent-shaped owners. */
  agentId?: string;
  syncMode: TaskFlowRecord["syncMode"];
  status: TaskFlowRecord["status"];
  goal: string;
  currentStep?: string;
  controllerId?: string;
  revision: number;
  blockedTaskId?: string;
  blockedSummary?: string;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  wait?: JsonValue;
  /** Milliseconds since `updatedAt` while `status === "waiting"`; the approval-gate pause duration. */
  waitingForMs?: number;
};

function mapTaskFlowListAllEntry(flow: TaskFlowRecord, now: number): TaskFlowListAllEntry {
  const parsedOwner = parseAgentSessionKey(flow.ownerKey);
  return {
    flowId: flow.flowId,
    ownerKey: flow.ownerKey,
    ...(parsedOwner ? { agentId: parsedOwner.agentId } : {}),
    syncMode: flow.syncMode,
    status: flow.status,
    goal: flow.goal,
    ...(flow.currentStep ? { currentStep: flow.currentStep } : {}),
    ...(flow.controllerId ? { controllerId: flow.controllerId } : {}),
    revision: flow.revision,
    ...(flow.blockedTaskId ? { blockedTaskId: flow.blockedTaskId } : {}),
    ...(flow.blockedSummary ? { blockedSummary: flow.blockedSummary } : {}),
    ...(flow.cancelRequestedAt !== undefined ? { cancelRequestedAt: flow.cancelRequestedAt } : {}),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    ...(flow.endedAt !== undefined ? { endedAt: flow.endedAt } : {}),
    ...(flow.waitJson !== undefined ? { wait: flow.waitJson } : {}),
    ...(flow.status === "waiting" ? { waitingForMs: Math.max(0, now - flow.updatedAt) } : {}),
  };
}

export const taskFlowsHandlers: GatewayRequestHandlers = {
  "taskFlows.listAll": ({ respond, context, client }) => {
    const cfg = context.getRuntimeConfig();
    // Mirrors usage.cost / transcripts.* : the owner/admin scope always sees
    // everything, and a role explicitly capped to "none" is refused outright.
    // There is no partial "view only your agents" mode here, same as those
    // Gateway-wide aggregate reads — TaskFlow ownership does not carry a
    // per-agent allowlist to filter against.
    if (!isGatewayAdmin(client) && operatorSessionCap(client, cfg) === "none") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "Cross-agent TaskFlow visibility includes flows owned by sessions hidden by your operator role; ask a Gateway administrator for cross-agent access.",
        ),
      );
      return;
    }
    const now = Date.now();
    const flows = listTaskFlowRecords().map((flow) => mapTaskFlowListAllEntry(flow, now));
    respond(true, { flows }, undefined);
  },
};
