// Reconciles stale task-flow records with their child task state.
import { listTasksForFlowId } from "./runtime-internal.js";
import { isTaskFlowCancellationPending } from "./task-cancellation-state.js";
import {
  listTaskFlowAuditFindings,
  summarizeTaskFlowAuditFindings,
  type TaskFlowAuditSummary,
} from "./task-flow-registry.audit.js";
import {
  deleteTaskFlowRecordById,
  getTaskFlowById,
  getTaskFlowRegistryRestoreFailure,
  listTaskFlowRecords,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-registry.js";
import { isTerminalTaskFlow, type TaskFlowRecord } from "./task-flow-registry.types.js";

const TASK_FLOW_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Counts task-flow registry maintenance actions without exposing individual records. */
type TaskFlowRegistryMaintenanceSummary = {
  reconciled: number;
  pruned: number;
};

export function assertTaskFlowRegistryMaintenanceReady(): void {
  const restoreFailure = getTaskFlowRegistryRestoreFailure();
  if (restoreFailure) {
    throw new Error(
      `Task-flow registry restore failed: ${restoreFailure}. Refusing task maintenance.`,
    );
  }
}

function hasActiveLinkedTasks(flowId: string): boolean {
  return listTasksForFlowId(flowId).some(isTaskFlowCancellationPending);
}

function resolveTerminalAt(flow: TaskFlowRecord): number {
  return flow.endedAt ?? flow.updatedAt ?? flow.createdAt;
}

function shouldPruneFlow(flow: TaskFlowRecord, now: number): boolean {
  if (!isTerminalTaskFlow(flow)) {
    return false;
  }
  if (hasActiveLinkedTasks(flow.flowId)) {
    return false;
  }
  return now - resolveTerminalAt(flow) >= TASK_FLOW_RETENTION_MS;
}

function shouldFinalizeCancelledFlow(flow: TaskFlowRecord): boolean {
  if (flow.syncMode !== "managed") {
    return false;
  }
  if (flow.cancelRequestedAt == null || isTerminalTaskFlow(flow)) {
    return false;
  }
  return !hasActiveLinkedTasks(flow.flowId);
}

function finalizeCancelledFlow(flow: TaskFlowRecord, now: number): boolean {
  let current = flow;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const endedAt = Math.max(now, current.updatedAt, current.cancelRequestedAt ?? now);
    const result = updateFlowRecordByIdExpectedRevision({
      flowId: current.flowId,
      expectedRevision: current.revision,
      patch: {
        status: "cancelled",
        blockedTaskId: null,
        blockedSummary: null,
        waitJson: null,
        endedAt,
        updatedAt: endedAt,
      },
    });
    if (result.applied) {
      return true;
    }
    if (result.reason === "not_found" || !result.current) {
      return false;
    }
    current = result.current;
    if (!shouldFinalizeCancelledFlow(current)) {
      return false;
    }
  }
  return false;
}

function shouldRepairTerminalMirroredFlowTimestamp(flow: TaskFlowRecord): boolean {
  if (flow.syncMode !== "task_mirrored" || !isTerminalTaskFlow(flow)) {
    return false;
  }
  if (flow.endedAt == null || flow.endedAt < flow.createdAt) {
    return false;
  }
  return flow.updatedAt > flow.endedAt;
}

function repairTerminalMirroredFlowTimestamp(flow: TaskFlowRecord): boolean {
  let current = flow;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!shouldRepairTerminalMirroredFlowTimestamp(current)) {
      return false;
    }
    const result = updateFlowRecordByIdExpectedRevision({
      flowId: current.flowId,
      expectedRevision: current.revision,
      patch: {
        updatedAt: current.endedAt,
      },
    });
    if (result.applied) {
      return true;
    }
    if (result.reason === "not_found" || !result.current) {
      return false;
    }
    current = result.current;
  }
  return false;
}

export function getInspectableTaskFlowAuditSummary(): TaskFlowAuditSummary {
  return summarizeTaskFlowAuditFindings(listTaskFlowAuditFindings());
}

export function previewTaskFlowRegistryMaintenance(): TaskFlowRegistryMaintenanceSummary {
  const now = Date.now();
  let reconciled = 0;
  let pruned = 0;
  for (const flow of listTaskFlowRecords()) {
    if (shouldRepairTerminalMirroredFlowTimestamp(flow)) {
      reconciled += 1;
      continue;
    }
    if (shouldFinalizeCancelledFlow(flow)) {
      reconciled += 1;
      continue;
    }
    if (shouldPruneFlow(flow, now)) {
      pruned += 1;
    }
  }
  return { reconciled, pruned };
}

export async function runTaskFlowRegistryMaintenance(): Promise<TaskFlowRegistryMaintenanceSummary> {
  const now = Date.now();
  let reconciled = 0;
  let pruned = 0;
  for (const flow of listTaskFlowRecords()) {
    const current = getTaskFlowById(flow.flowId);
    if (!current) {
      continue;
    }
    if (shouldRepairTerminalMirroredFlowTimestamp(current)) {
      if (repairTerminalMirroredFlowTimestamp(current)) {
        reconciled += 1;
      }
      continue;
    }
    if (shouldFinalizeCancelledFlow(current)) {
      if (finalizeCancelledFlow(current, now)) {
        reconciled += 1;
      }
      continue;
    }
    if (shouldPruneFlow(current, now) && deleteTaskFlowRecordById(current.flowId)) {
      pruned += 1;
    }
  }
  return { reconciled, pruned };
}

/** Terminal statuses an operator can manually clear ahead of the retention window. */
export type ClearableTerminalTaskFlowStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost"
  | "blocked";

/**
 * Immediately deletes every TaskFlow record in the given terminal status,
 * bypassing TASK_FLOW_RETENTION_MS. Backs the operator-governed "Clear
 * succeeded" / "Clear failed" TaskFlows UI actions. Records with active
 * linked tasks are skipped for the same safety reason `shouldPruneFlow`
 * skips them: they should not normally exist (a flow whose status is
 * terminal has no active linked tasks), so a match here means the status
 * is stale and deleting the record now would be premature.
 *
 * `blocked` is status-terminal but not *record*-terminal: a blocked flow whose
 * completion delivery can still be redriven has no `endedAt` and must survive.
 * Matching on status alone would bulk-delete exactly those recoverable flows,
 * so every candidate is re-checked with `isTerminalTaskFlow` and a
 * still-resumable one is skipped rather than cleared.
 */
export function clearTerminalTaskFlowsByStatus(status: ClearableTerminalTaskFlowStatus): {
  cleared: number;
  skipped: number;
} {
  let cleared = 0;
  let skipped = 0;
  for (const flow of listTaskFlowRecords()) {
    if (flow.status !== status) {
      continue;
    }
    const current = getTaskFlowById(flow.flowId);
    if (!current || current.status !== status) {
      continue;
    }
    if (!isTerminalTaskFlow(current)) {
      skipped += 1;
      continue;
    }
    if (hasActiveLinkedTasks(current.flowId)) {
      skipped += 1;
      continue;
    }
    if (deleteTaskFlowRecordById(current.flowId)) {
      cleared += 1;
    }
  }
  return { cleared, skipped };
}
