// Defines managed task-flow registry records and parser helpers.
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { JsonValue, TaskNotifyPolicy } from "./task-registry.types.js";

export type { JsonValue } from "./task-registry.types.js";

export type TaskFlowSyncMode = "task_mirrored" | "managed";

/** Lifecycle statuses for multi-step task flows. */
export const TASK_FLOW_STATUSES = [
  "queued",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
] as const;
export type TaskFlowStatus = (typeof TASK_FLOW_STATUSES)[number];

const TASK_FLOW_SYNC_MODES = new Set<TaskFlowSyncMode>(["task_mirrored", "managed"]);
const TASK_FLOW_STATUS_SET = new Set<TaskFlowStatus>(TASK_FLOW_STATUSES);

function parsePersistedFlowValue<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  label: string,
): T {
  if (typeof value === "string" && values.has(value as T)) {
    return value as T;
  }
  throw new Error(`Invalid persisted task flow ${label}: ${JSON.stringify(value)}`);
}

export function parseOptionalTaskFlowSyncMode(value: unknown): TaskFlowSyncMode | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return parsePersistedFlowValue(value, TASK_FLOW_SYNC_MODES, "sync mode");
}

export function parseTaskFlowStatus(value: unknown): TaskFlowStatus {
  return parsePersistedFlowValue(value, TASK_FLOW_STATUS_SET, "status");
}

export type TaskFlowRecord = {
  flowId: string;
  syncMode: TaskFlowSyncMode;
  ownerKey: string;
  requesterOrigin?: DeliveryContext;
  controllerId?: string;
  revision: number;
  status: TaskFlowStatus;
  notifyPolicy: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  blockedTaskId?: string;
  blockedSummary?: string;
  stateJson?: JsonValue;
  waitJson?: JsonValue;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};

// `blocked` is never terminal on its own: in either sync mode a blocked flow
// stays resumable until `endedAt` is set. Managed flows set it when the
// controller finishes. Mirrored flows set it only once the projected
// completion delivery is genuinely done (operator-dismissed) — until then the
// delivery can still be redriven, which clears the blocked outcome, so the
// flow must be able to leave `blocked` again. See
// `isTerminalTaskMirroredFlowStatus` in ./task-flow-registry.records.ts.
export function isTerminalTaskFlow(flow: Pick<TaskFlowRecord, "status" | "endedAt">): boolean {
  return (
    flow.status === "succeeded" ||
    (flow.status === "blocked" && flow.endedAt != null) ||
    flow.status === "failed" ||
    flow.status === "cancelled" ||
    flow.status === "lost"
  );
}

export type TaskFlowUpdateResult =
  | {
      applied: true;
      flow: TaskFlowRecord;
    }
  | {
      applied: false;
      reason: "not_found" | "revision_conflict" | "persist_failed";
      current?: TaskFlowRecord;
    };

export type TaskFlowSyncResult =
  | {
      ok: true;
      flow: TaskFlowRecord | null;
    }
  | {
      ok: false;
      reason: "persist_failed";
      current: TaskFlowRecord;
    };
