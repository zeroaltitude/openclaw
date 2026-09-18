/**
 * Real-behavior proof that a mirrored `blocked` TaskFlow is not permanently terminal.
 *
 * Why this exists: the bug was not "blocked flows are listed oddly" — it was that a
 * mirrored flow projecting a *retryable* completion delivery got `endedAt` stamped the
 * instant it went `blocked`, which made `isTerminalTaskFlow` true forever. `cancel`
 * then refused with "Flow is already blocked." and no path led back out. So the thing
 * worth proving is the asymmetry: a blocked flow whose delivery can still be redriven
 * must survive every deletion path, while a blocked flow whose delivery is genuinely
 * finished (operator-dismissed) must be deletable.
 *
 * Real vs stubbed:
 *   - REAL: the TaskFlow registry (`createTaskFlowForTask`, `syncFlowFromTaskResult`,
 *     `getTaskFlowById`, `deleteTaskFlowRecordById`) backed by a real on-disk SQLite
 *     store in a temp state dir.
 *   - REAL: the records kernel that decides terminality
 *     (`isTerminalTaskMirroredFlowStatus` -> `resolveTaskMirroredFlowTiming`), exercised
 *     through both of its call sites: flow creation AND flow resync.
 *   - REAL: `isTerminalTaskFlow` (src/tasks/task-flow-registry.types.ts), the predicate
 *     every consumer uses.
 *   - REAL: the CLI commands `flowsDeleteCommand` / `flowsRetryCommand` from
 *     src/commands/flows.ts, driven through a genuine `RuntimeEnv` that records
 *     log/error/exit rather than writing to the terminal.
 *   - REAL: `clearTerminalTaskFlowsByStatus`, the bulk path behind the gateway's
 *     `taskFlows.clearTerminal` method and the Control-UI clear actions.
 *   - STUBBED (edge only): nothing between an entrypoint and the registry. The task
 *     records fed in are constructed to match exactly what the production delivery
 *     paths persist — `blockSubagentCompletionDelivery` writes
 *     `deliveryStatus: "failed"` + `terminalOutcome: "blocked"` for a suspended,
 *     still-redrivable delivery; `dismissSubagentCompletionDelivery` writes
 *     `deliveryStatus: "dismissed"` + `terminalOutcome: "blocked"`;
 *     `projectRedrivenTask` writes `terminalOutcome: "succeeded"` +
 *     `deliveryStatus: "pending"` after a successful redrive
 *     (src/agents/subagents/completion/subagent-completion-{admission.store,delivery}.ts).
 *     `flowsRetryCommand`'s final hop is a real `tasks.retry` gateway call, which has no
 *     live Gateway here; the proof asserts on that boundary being reached, not faked.
 *
 * Scenarios:
 *   1. A blocked + still-redrivable mirrored flow is born NON-terminal (no `endedAt`)
 *      at creation, and stays non-terminal across a resync.
 *   2. `openclaw tasks flow delete` REFUSES that flow and the record survives.
 *   3. The bulk clear path skips it too, so the UI/gateway cannot bury it either.
 *   4. A successful redrive clears the blocked state: the flow leaves `blocked`.
 *   5. A blocked + operator-dismissed mirrored flow IS terminal and CAN be deleted.
 *   6. `openclaw tasks flow retry` resolves the flow's `blockedTaskId` and reaches the
 *      real gateway seam; it refuses a flow that has nothing to retry.
 *
 * Run: pnpm tsx scripts/proof-taskflow-blocked-nonterminal.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RuntimeEnv } from "../src/runtime.js";
import type { TaskRecord } from "../src/tasks/task-registry.types.js";

const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-proof-blocked-nonterminal-"));
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

type CapturedRuntime = {
  runtime: RuntimeEnv;
  logs: string[];
  errors: string[];
  exits: number[];
};

function captureRuntime(): CapturedRuntime {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  return {
    logs,
    errors,
    exits,
    runtime: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
      exit: (code: number) => exits.push(code),
    },
  };
}

/**
 * The exact task shape `blockSubagentCompletionDelivery` persists when a required
 * completion delivery is suspended: the run itself succeeded, its terminal outcome is
 * `blocked`, and the delivery is `failed` — i.e. retryable, not dismissed.
 */
function suspendedBlockedTask(taskId: string, at: number): TaskRecord {
  return {
    taskId,
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    runId: `run-${taskId}`,
    label: "Deliver subagent result",
    task: "Deliver subagent result",
    status: "succeeded",
    terminalOutcome: "blocked",
    deliveryStatus: "failed",
    notifyPolicy: "done_only",
    createdAt: at - 50,
    lastEventAt: at,
    endedAt: at,
    terminalSummary: "Task completed; result delivery is blocked.",
  } as TaskRecord;
}

async function main(): Promise<void> {
  const {
    createTaskFlowForTask,
    deleteTaskFlowRecordById,
    getTaskFlowById,
    syncFlowFromTaskResult,
  } = await import("../src/tasks/task-flow-registry.js");
  const { isTerminalTaskFlow } = await import("../src/tasks/task-flow-registry.types.js");
  const { clearTerminalTaskFlowsByStatus } =
    await import("../src/tasks/task-flow-registry.maintenance.js");
  const { flowsDeleteCommand, flowsRetryCommand } = await import("../src/commands/flows.js");

  const now = Date.now();

  console.log("scenario 1: a redrivable blocked mirrored flow is born non-terminal");
  const suspended = suspendedBlockedTask("task-suspended", now);
  const retryable = createTaskFlowForTask({ task: suspended });
  if (!retryable) {
    throw new Error("registry did not create the suspended mirrored flow");
  }
  check("flow mirrors the task as blocked", retryable.status === "blocked", retryable.status);
  check("flow is task_mirrored", retryable.syncMode === "task_mirrored", retryable.syncMode);
  check("no endedAt stamped at creation", retryable.endedAt === undefined, retryable.endedAt);
  check("isTerminalTaskFlow is false", isTerminalTaskFlow(retryable) === false);
  check(
    "blockedTaskId is recorded for retry",
    retryable.blockedTaskId === "task-suspended",
    retryable.blockedTaskId,
  );

  const resyncedResult = syncFlowFromTaskResult({
    ...suspended,
    parentFlowId: retryable.flowId,
    lastEventAt: now + 1_000,
  });
  const resynced = resyncedResult.ok ? resyncedResult.flow : undefined;
  check("resync succeeded", resyncedResult.ok);
  check("still blocked after resync", resynced?.status === "blocked", resynced?.status);
  check("still no endedAt after resync", resynced?.endedAt === undefined, resynced?.endedAt);
  check("still non-terminal after resync", resynced ? !isTerminalTaskFlow(resynced) : false);

  console.log("scenario 2: `tasks flow delete` refuses the redrivable flow");
  const deleteRetryable = captureRuntime();
  await flowsDeleteCommand({ lookup: retryable.flowId }, deleteRetryable.runtime);
  check("delete exited non-zero", deleteRetryable.exits.includes(1), deleteRetryable.exits);
  check(
    "refusal explains the flow is still blocked",
    deleteRetryable.errors.some((line) => line.includes("still blocked")),
    deleteRetryable.errors,
  );
  check(
    "refusal points at retry/dismiss as the way out",
    deleteRetryable.errors.some((line) => line.includes("retry") && line.includes("dismiss")),
    deleteRetryable.errors,
  );
  check("nothing was logged as deleted", deleteRetryable.logs.length === 0, deleteRetryable.logs);
  check(
    "the record SURVIVED the delete attempt",
    getTaskFlowById(retryable.flowId)?.flowId === retryable.flowId,
  );

  console.log("scenario 3: the bulk clear path skips it as well");
  const bulk = clearTerminalTaskFlowsByStatus("blocked");
  check("bulk clear deleted nothing", bulk.cleared === 0, bulk);
  check("bulk clear counted it as skipped", bulk.skipped === 1, bulk);
  check(
    "the record SURVIVED the bulk clear",
    getTaskFlowById(retryable.flowId)?.flowId === retryable.flowId,
  );

  console.log("scenario 4: a successful redrive clears the blocked state");
  // `projectRedrivenTask` flips terminalOutcome off "blocked" and re-queues delivery.
  const redrivenResult = syncFlowFromTaskResult({
    ...suspended,
    parentFlowId: retryable.flowId,
    terminalOutcome: "succeeded",
    deliveryStatus: "delivered",
    lastEventAt: now + 2_000,
    endedAt: now + 2_000,
  });
  const redriven = redrivenResult.ok ? redrivenResult.flow : undefined;
  check("redrive resync succeeded", redrivenResult.ok);
  check("flow left the blocked state", redriven?.status === "succeeded", redriven?.status);
  check("flow is now terminal", redriven ? isTerminalTaskFlow(redriven) : false);
  check(
    "endedAt is stamped now that it really ended",
    redriven?.endedAt === now + 2_000,
    redriven?.endedAt,
  );
  check(
    "blockedTaskId was cleared",
    redriven?.blockedTaskId === undefined,
    redriven?.blockedTaskId,
  );

  console.log("scenario 5: a dismissed blocked flow is terminal and deletable");
  const dismissedTask: TaskRecord = {
    ...suspendedBlockedTask("task-dismissed", now),
    // `dismissSubagentCompletionDelivery` records the operator's give-up.
    deliveryStatus: "dismissed",
    terminalSummary: "Task completed; result delivery was dismissed by the operator.",
  };
  const dismissed = createTaskFlowForTask({ task: dismissedTask });
  if (!dismissed) {
    throw new Error("registry did not create the dismissed mirrored flow");
  }
  check("dismissed flow is blocked", dismissed.status === "blocked", dismissed.status);
  check("dismissed flow HAS endedAt", dismissed.endedAt === now, dismissed.endedAt);
  check("dismissed flow is terminal", isTerminalTaskFlow(dismissed) === true);

  const deleteDismissed = captureRuntime();
  await flowsDeleteCommand({ lookup: dismissed.flowId }, deleteDismissed.runtime);
  check("delete did NOT exit non-zero", deleteDismissed.exits.length === 0, deleteDismissed.exits);
  check("delete reported no error", deleteDismissed.errors.length === 0, deleteDismissed.errors);
  check(
    "delete confirmed the removal",
    deleteDismissed.logs.some(
      (line) => line.includes("Deleted") && line.includes(dismissed.flowId),
    ),
    deleteDismissed.logs,
  );
  check("the record is GONE", getTaskFlowById(dismissed.flowId) === undefined);
  check(
    "deleting it again is a no-op at the registry",
    deleteTaskFlowRecordById(dismissed.flowId) === false,
  );

  console.log("scenario 6: `tasks flow retry` resolves the flow's blocked task");
  // The redriven flow from scenario 4 is no longer blocked, so retry must refuse it.
  const retryNonBlocked = captureRuntime();
  await flowsRetryCommand({ lookup: retryable.flowId }, retryNonBlocked.runtime);
  check(
    "retry refused a non-blocked flow",
    retryNonBlocked.exits.includes(1),
    retryNonBlocked.exits,
  );
  check(
    "refusal names the absent blocked task",
    retryNonBlocked.errors.some((line) => line.includes("no blocked task to retry")),
    retryNonBlocked.errors,
  );

  // A genuinely blocked flow gets past the guard and reaches the real gateway seam.
  const secondSuspended = suspendedBlockedTask("task-suspended-2", now + 3_000);
  const stillBlocked = createTaskFlowForTask({ task: secondSuspended });
  if (!stillBlocked) {
    throw new Error("registry did not create the second suspended mirrored flow");
  }
  check("second flow is blocked and non-terminal", !isTerminalTaskFlow(stillBlocked));
  const retryBlocked = captureRuntime();
  // No live Gateway here, so the real `tasks.retry` call raises an expected CLI error
  // that `rethrowExpectedCliError` deliberately propagates (same contract as
  // `openclaw tasks retry`). Catching it is the proof that the command resolved the
  // flow's blockedTaskId and reached the genuine gateway method rather than a stub.
  let reachedGateway: { method?: unknown } | undefined;
  try {
    await flowsRetryCommand({ lookup: stillBlocked.flowId }, retryBlocked.runtime);
  } catch (error: unknown) {
    reachedGateway = error as { method?: unknown };
  }
  check("retry reached the real gateway call and surfaced its error", reachedGateway !== undefined);
  check(
    "the gateway method invoked was tasks.retry",
    reachedGateway?.method === "tasks.retry",
    reachedGateway?.method,
  );
  check(
    "the blocked record SURVIVED the retry attempt",
    getTaskFlowById(stillBlocked.flowId)?.flowId === stillBlocked.flowId,
  );
  check(
    "it is still non-terminal, so it remains retryable",
    !isTerminalTaskFlow(getTaskFlowById(stillBlocked.flowId)!),
  );
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
