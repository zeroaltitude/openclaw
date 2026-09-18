import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  JsonValue,
  TaskFlowRecord,
  TaskFlowStatus,
  TaskFlowSyncMode,
} from "./task-flow-registry.types.js";
import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";

export type TaskFlowSyncInput = Pick<
  TaskRecord,
  | "parentFlowId"
  | "status"
  | "terminalOutcome"
  | "notifyPolicy"
  | "label"
  | "task"
  | "lastEventAt"
  | "endedAt"
  | "taskId"
  | "terminalSummary"
  | "progressSummary"
  // A mirrored `blocked` flow's terminality depends on whether the projected
  // completion delivery can still be redriven, so the sync needs the task's
  // delivery status, not just its run status.
  | "deliveryStatus"
>;

export type FlowRecordPatch = Omit<
  Partial<
    Pick<
      TaskFlowRecord,
      | "status"
      | "notifyPolicy"
      | "goal"
      | "currentStep"
      | "blockedTaskId"
      | "blockedSummary"
      | "controllerId"
      | "stateJson"
      | "waitJson"
      | "cancelRequestedAt"
      | "updatedAt"
      | "endedAt"
    >
  >,
  | "currentStep"
  | "blockedTaskId"
  | "blockedSummary"
  | "controllerId"
  | "stateJson"
  | "waitJson"
  | "cancelRequestedAt"
  | "endedAt"
> & {
  currentStep?: string | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  controllerId?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  cancelRequestedAt?: number | null;
  endedAt?: number | null;
};

export type FlowRecordCreateFields = {
  ownerKey: string;
  requesterOrigin?: TaskFlowRecord["requesterOrigin"];
  status?: TaskFlowStatus;
  notifyPolicy?: TaskNotifyPolicy;
  goal: string;
  currentStep?: string | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  cancelRequestedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  endedAt?: number | null;
};

export type ManagedTaskFlowMutation = "setWaiting" | "resume" | "finish" | "fail" | "requestCancel";

/** Both transports translate managed actions through the same field and timestamp rules. */
export function buildManagedTaskFlowPatch(
  mutation: ManagedTaskFlowMutation,
  input: FlowRecordPatch,
): FlowRecordPatch {
  switch (mutation) {
    case "setWaiting":
      return {
        status:
          normalizeOptionalString(input.blockedTaskId) ||
          normalizeOptionalString(input.blockedSummary)
            ? "blocked"
            : "waiting",
        currentStep: input.currentStep,
        stateJson: input.stateJson,
        waitJson: input.waitJson,
        blockedTaskId: input.blockedTaskId,
        blockedSummary: input.blockedSummary,
        endedAt: null,
        updatedAt: input.updatedAt,
      };
    case "resume":
      return {
        status: input.status ?? "queued",
        currentStep: input.currentStep,
        stateJson: input.stateJson,
        waitJson: null,
        blockedTaskId: null,
        blockedSummary: null,
        endedAt: null,
        updatedAt: input.updatedAt,
      };
    case "finish":
    case "fail": {
      const endedAt = input.endedAt ?? input.updatedAt ?? Date.now();
      return {
        status: mutation === "finish" ? "succeeded" : "failed",
        currentStep: input.currentStep,
        stateJson: input.stateJson,
        waitJson: null,
        blockedTaskId: mutation === "finish" ? null : input.blockedTaskId,
        blockedSummary: mutation === "finish" ? null : input.blockedSummary,
        endedAt,
        updatedAt: input.updatedAt ?? endedAt,
      };
    }
    case "requestCancel":
      return {
        cancelRequestedAt: input.cancelRequestedAt ?? input.updatedAt ?? Date.now(),
        updatedAt: input.updatedAt,
      };
  }
  throw new Error("Unknown managed task-flow mutation");
}

export type CreateFlowRecordParams = FlowRecordCreateFields & {
  syncMode?: TaskFlowSyncMode;
  controllerId?: string | null;
  revision?: number;
};

export type PreparedTaskMirroredFlowSync = {
  current: TaskFlowRecord;
  next: TaskFlowRecord;
};

function cloneStructuredValue<T>(value: T | undefined): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone(value);
}

export function cloneFlowRecord(record: TaskFlowRecord): TaskFlowRecord {
  return {
    ...record,
    ...(record.requesterOrigin
      ? { requesterOrigin: cloneStructuredValue(record.requesterOrigin)! }
      : {}),
    ...(record.stateJson !== undefined
      ? { stateJson: cloneStructuredValue(record.stateJson)! }
      : {}),
    ...(record.waitJson !== undefined ? { waitJson: cloneStructuredValue(record.waitJson)! } : {}),
  };
}

/** Optional record fields decode without own undefined properties; JSON payloads retain their shape. */
export function areTaskFlowRecordsEqual(
  left: TaskFlowRecord | undefined,
  right: TaskFlowRecord | undefined,
): boolean {
  const fields = (record: TaskFlowRecord | undefined) =>
    record
      ? Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
      : undefined;
  return isDeepStrictEqual(fields(left), fields(right));
}

export function normalizeRestoredFlowRecord(record: TaskFlowRecord): TaskFlowRecord {
  const syncMode = record.syncMode === "task_mirrored" ? "task_mirrored" : "managed";
  const controllerId =
    syncMode === "managed"
      ? (normalizeOptionalString(record.controllerId) ?? "core/legacy-restored")
      : undefined;
  return {
    ...record,
    syncMode,
    ownerKey: assertFlowOwnerKey(record.ownerKey),
    ...(record.requesterOrigin
      ? { requesterOrigin: cloneStructuredValue(record.requesterOrigin)! }
      : {}),
    ...(controllerId ? { controllerId } : {}),
    currentStep: normalizeOptionalString(record.currentStep),
    blockedTaskId: normalizeOptionalString(record.blockedTaskId),
    blockedSummary: normalizeOptionalString(record.blockedSummary),
    ...(record.stateJson !== undefined
      ? { stateJson: cloneStructuredValue(record.stateJson)! }
      : {}),
    ...(record.waitJson !== undefined ? { waitJson: cloneStructuredValue(record.waitJson)! } : {}),
    revision: Math.max(0, record.revision),
    cancelRequestedAt: record.cancelRequestedAt ?? undefined,
    endedAt: record.endedAt ?? undefined,
  };
}

export function snapshotFlowRecords(source: ReadonlyMap<string, TaskFlowRecord>): TaskFlowRecord[] {
  return [...source.values()].map((record) => cloneFlowRecord(record));
}

function ensureNotifyPolicy(notifyPolicy?: TaskNotifyPolicy): TaskNotifyPolicy {
  return notifyPolicy ?? "done_only";
}

function normalizeJsonBlob(value: JsonValue | null | undefined): JsonValue | undefined {
  return value === undefined ? undefined : cloneStructuredValue(value);
}

function assertFlowOwnerKey(ownerKey: string): string {
  const normalized = normalizeOptionalString(ownerKey);
  if (!normalized) {
    throw new Error("Flow ownerKey is required.");
  }
  return normalized;
}

export function assertControllerId(controllerId?: string | null): string {
  const normalized = normalizeOptionalString(controllerId);
  if (!normalized) {
    throw new Error("Managed flow controllerId is required.");
  }
  return normalized;
}

export function resolveFlowBlockedSummary(
  task: Pick<TaskRecord, "status" | "terminalOutcome" | "terminalSummary" | "progressSummary">,
): string | undefined {
  if (task.status !== "succeeded" || task.terminalOutcome !== "blocked") {
    return undefined;
  }
  return (
    normalizeOptionalString(task.terminalSummary) ?? normalizeOptionalString(task.progressSummary)
  );
}

export function deriveTaskFlowStatusFromTask(
  task: Pick<TaskRecord, "status" | "terminalOutcome">,
): TaskFlowStatus {
  if (task.status === "queued") {
    return "queued";
  }
  if (task.status === "running") {
    return "running";
  }
  if (task.status === "succeeded") {
    return task.terminalOutcome === "blocked" ? "blocked" : "succeeded";
  }
  if (task.status === "cancelled") {
    return "cancelled";
  }
  if (task.status === "lost") {
    return "lost";
  }
  return "failed";
}

/**
 * Terminality for a mirrored flow projected from one task.
 *
 * `succeeded`, `failed`, `cancelled` and `lost` are unconditionally terminal:
 * the underlying run is over and nothing can move it.
 *
 * `failed` is terminal without qualification, and that is not an oversight: a
 * task run has no redrive anywhere. Terminal task statuses are absorbing
 * (`shouldApplyRunScopedStatusUpdate` refuses terminal -> non-terminal), and
 * `openclaw tasks retry` redrives a completion DELIVERY, never a run — its
 * redrive projects `status: "succeeded"`, so a failed run can never enter it.
 * The orphan sweeper's retry and tombstone paths both leave the task `running`
 * rather than writing a failure, so "might still recover" never reaches a
 * mirrored flow as `failed` in the first place.
 *
 * `blocked` is the status whose terminality genuinely varies. A mirrored
 * `blocked` flow means the run itself succeeded but its completion delivery was
 * not handed to the requester, and only the task's `deliveryStatus` says
 * whether anything can still act on that:
 *
 * - `failed` — the delivery is suspended. `openclaw tasks retry` redrives it
 *   and `openclaw tasks dismiss` abandons it, and a successful redrive clears
 *   `terminalOutcome: "blocked"`, so the flow must be able to leave `blocked`.
 *   NOT terminal.
 * - `dismissed` — the operator gave up on it. Terminal.
 * - `suppressed` — the delivery was deliberately and terminally never made.
 *   Retry and dismiss both refuse it (each requires the suspended state), so
 *   treating it as resumable would strand the flow with no exit at all: not
 *   retryable, not dismissable, and — because a non-terminal flow is neither
 *   deletable nor prunable — not removable either. Terminal.
 *
 * Returning false here leaves `endedAt` unset, which is exactly what keeps
 * `isTerminalTaskFlow` false and the flow resumable rather than buried. A
 * delivery that has exhausted its redrive generations stays non-terminal until
 * it is dismissed; `openclaw tasks dismiss <taskId>` is the operator's path to
 * a terminal, clearable flow.
 */
export function isTerminalTaskMirroredFlowStatus(
  status: TaskFlowStatus,
  deliveryStatus: TaskRecord["deliveryStatus"] | undefined,
): boolean {
  if (status === "blocked") {
    return deliveryStatus === "dismissed" || deliveryStatus === "suppressed";
  }
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

export function resolveTaskMirroredFlowTiming(
  task: Pick<TaskRecord, "createdAt" | "lastEventAt" | "endedAt">,
  isTerminal: boolean,
): { updatedAt: number; endedAt?: number } {
  if (!isTerminal) {
    return { updatedAt: task.lastEventAt ?? task.createdAt };
  }
  const endedAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  return { updatedAt: endedAt, endedAt };
}

export function buildFlowRecord(params: CreateFlowRecordParams): TaskFlowRecord {
  const now = params.createdAt ?? Date.now();
  const syncMode = params.syncMode ?? "managed";
  const controllerId = syncMode === "managed" ? assertControllerId(params.controllerId) : undefined;
  return {
    flowId: crypto.randomUUID(),
    syncMode,
    ownerKey: assertFlowOwnerKey(params.ownerKey),
    ...(params.requesterOrigin
      ? { requesterOrigin: cloneStructuredValue(params.requesterOrigin)! }
      : {}),
    ...(controllerId ? { controllerId } : {}),
    revision: Math.max(0, params.revision ?? 0),
    status: params.status ?? "queued",
    notifyPolicy: ensureNotifyPolicy(params.notifyPolicy),
    goal: params.goal,
    currentStep: normalizeOptionalString(params.currentStep),
    blockedTaskId: normalizeOptionalString(params.blockedTaskId),
    blockedSummary: normalizeOptionalString(params.blockedSummary),
    ...(normalizeJsonBlob(params.stateJson) !== undefined
      ? { stateJson: normalizeJsonBlob(params.stateJson)! }
      : {}),
    ...(normalizeJsonBlob(params.waitJson) !== undefined
      ? { waitJson: normalizeJsonBlob(params.waitJson)! }
      : {}),
    ...(params.cancelRequestedAt != null ? { cancelRequestedAt: params.cancelRequestedAt } : {}),
    createdAt: now,
    updatedAt: params.updatedAt ?? now,
    ...(params.endedAt != null ? { endedAt: params.endedAt } : {}),
  };
}

export function applyFlowPatch(current: TaskFlowRecord, patch: FlowRecordPatch): TaskFlowRecord {
  const controllerId =
    patch.controllerId === undefined
      ? current.controllerId
      : normalizeOptionalString(patch.controllerId);
  if (current.syncMode === "managed") {
    assertControllerId(controllerId);
  }
  return {
    ...current,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.notifyPolicy ? { notifyPolicy: patch.notifyPolicy } : {}),
    ...(patch.goal ? { goal: patch.goal } : {}),
    controllerId,
    currentStep:
      patch.currentStep === undefined
        ? current.currentStep
        : normalizeOptionalString(patch.currentStep),
    blockedTaskId:
      patch.blockedTaskId === undefined
        ? current.blockedTaskId
        : normalizeOptionalString(patch.blockedTaskId),
    blockedSummary:
      patch.blockedSummary === undefined
        ? current.blockedSummary
        : normalizeOptionalString(patch.blockedSummary),
    stateJson:
      patch.stateJson === undefined ? current.stateJson : normalizeJsonBlob(patch.stateJson),
    waitJson: patch.waitJson === undefined ? current.waitJson : normalizeJsonBlob(patch.waitJson),
    cancelRequestedAt:
      patch.cancelRequestedAt === undefined
        ? current.cancelRequestedAt
        : (patch.cancelRequestedAt ?? undefined),
    revision: current.revision + 1,
    updatedAt: patch.updatedAt ?? Date.now(),
    endedAt: patch.endedAt === undefined ? current.endedAt : (patch.endedAt ?? undefined),
  };
}

export function prepareTaskMirroredFlowSyncFromCurrent(
  task: TaskFlowSyncInput,
  flow: TaskFlowRecord,
): PreparedTaskMirroredFlowSync {
  const terminalFlowStatus = deriveTaskFlowStatusFromTask(task);
  const isTerminal = isTerminalTaskMirroredFlowStatus(terminalFlowStatus, task.deliveryStatus);
  const timing = resolveTaskMirroredFlowTiming(
    {
      createdAt: flow.createdAt,
      lastEventAt: task.lastEventAt,
      endedAt: task.endedAt,
    },
    isTerminal,
  );
  const next = applyFlowPatch(flow, {
    status: terminalFlowStatus,
    notifyPolicy: task.notifyPolicy,
    goal: normalizeOptionalString(task.label) ?? (task.task.trim() || "Background task"),
    blockedTaskId: terminalFlowStatus === "blocked" ? task.taskId.trim() || null : null,
    blockedSummary:
      terminalFlowStatus === "blocked" ? (resolveFlowBlockedSummary(task) ?? null) : null,
    waitJson: null,
    updatedAt: timing.updatedAt,
    ...(isTerminal
      ? {
          endedAt: timing.endedAt ?? timing.updatedAt,
        }
      : { endedAt: null }),
  });
  return { current: cloneFlowRecord(flow), next };
}
