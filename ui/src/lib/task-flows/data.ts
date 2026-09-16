// Normalizes taskFlows.listAll responses for the cross-agent TaskFlows page.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as optionalString } from "@openclaw/normalization-core/string-coerce";
import { t } from "../../i18n/index.ts";

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

function isTaskFlowStatus(value: unknown): value is TaskFlowStatus {
  return typeof value === "string" && (TASK_FLOW_STATUSES as readonly string[]).includes(value);
}

export type TaskFlowListAllEntry = {
  flowId: string;
  ownerKey: string;
  agentId?: string;
  syncMode: string;
  status: TaskFlowStatus;
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
  wait?: unknown;
  waitingForMs?: number;
};

function normalizeTaskFlowListAllEntry(value: unknown): TaskFlowListAllEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const flowId = optionalString(value.flowId);
  const ownerKey = optionalString(value.ownerKey);
  const syncMode = optionalString(value.syncMode);
  const goal = optionalString(value.goal);
  const status = value.status;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  const revision = value.revision;
  if (
    !flowId ||
    !ownerKey ||
    !syncMode ||
    !isTaskFlowStatus(status) ||
    typeof createdAt !== "number" ||
    typeof updatedAt !== "number" ||
    typeof revision !== "number"
  ) {
    return null;
  }
  return {
    flowId,
    ownerKey,
    ...(optionalString(value.agentId) ? { agentId: optionalString(value.agentId) } : {}),
    syncMode,
    status,
    goal: goal ?? "",
    ...(optionalString(value.currentStep)
      ? { currentStep: optionalString(value.currentStep) }
      : {}),
    ...(optionalString(value.controllerId)
      ? { controllerId: optionalString(value.controllerId) }
      : {}),
    revision,
    ...(optionalString(value.blockedTaskId)
      ? { blockedTaskId: optionalString(value.blockedTaskId) }
      : {}),
    ...(optionalString(value.blockedSummary)
      ? { blockedSummary: optionalString(value.blockedSummary) }
      : {}),
    ...(typeof value.cancelRequestedAt === "number"
      ? { cancelRequestedAt: value.cancelRequestedAt }
      : {}),
    createdAt,
    updatedAt,
    ...(typeof value.endedAt === "number" ? { endedAt: value.endedAt } : {}),
    ...(value.wait !== undefined ? { wait: value.wait } : {}),
    ...(typeof value.waitingForMs === "number" ? { waitingForMs: value.waitingForMs } : {}),
  } as TaskFlowListAllEntry;
}

export function normalizeTaskFlowListAllResult(
  payload: unknown,
): { flows: TaskFlowListAllEntry[] } | null {
  if (!isRecord(payload) || !Array.isArray(payload.flows)) {
    return null;
  }
  const flows: TaskFlowListAllEntry[] = [];
  for (const entry of payload.flows) {
    const normalized = normalizeTaskFlowListAllEntry(entry);
    if (!normalized) {
      return null;
    }
    flows.push(normalized);
  }
  return { flows };
}

const STATUS_LABEL_KEYS = {
  queued: "taskFlowsPage.status.queued",
  running: "taskFlowsPage.status.running",
  waiting: "taskFlowsPage.status.waiting",
  blocked: "taskFlowsPage.status.blocked",
  succeeded: "taskFlowsPage.status.succeeded",
  failed: "taskFlowsPage.status.failed",
  cancelled: "taskFlowsPage.status.cancelled",
  lost: "taskFlowsPage.status.lost",
} as const satisfies Record<TaskFlowStatus, string>;

export function taskFlowStatusLabel(status: TaskFlowStatus): string {
  return t(STATUS_LABEL_KEYS[status]);
}

export type TaskFlowStatusKind = "ok" | "warn" | "danger" | "accent" | "muted";

export function taskFlowStatusKind(status: TaskFlowStatus): TaskFlowStatusKind {
  switch (status) {
    case "succeeded":
      return "ok";
    case "failed":
    case "lost":
      return "danger";
    case "blocked":
      return "danger";
    case "waiting":
    case "queued":
    case "running":
      return "warn";
    case "cancelled":
      return "muted";
  }
  return status satisfies never;
}

export function taskFlowGoal(flow: TaskFlowListAllEntry): string {
  return flow.goal.trim() || t("taskFlowsPage.untitledGoal");
}

/** Rendered "agent:<agentId>:<rest>" owner label, or the raw ownerKey when unparseable. */
export function taskFlowOwnerLabel(flow: TaskFlowListAllEntry): string {
  return flow.agentId ? t("taskFlowsPage.owner", { agent: flow.agentId }) : flow.ownerKey;
}

export function sortTaskFlowsByCreatedAtDesc(
  flows: readonly TaskFlowListAllEntry[],
): TaskFlowListAllEntry[] {
  return flows.toSorted((left, right) => right.createdAt - left.createdAt);
}
