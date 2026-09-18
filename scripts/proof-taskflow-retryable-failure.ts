/**
 * Real-behavior proof that a mirrored TaskFlow distinguishes a RECOVERABLE failed
 * completion delivery from an UNRECOVERABLE one.
 *
 * Why this exists: `TaskRecord.deliveryStatus: "failed"` used to mean two different
 * things. `blockSubagentCompletionDelivery` writes it for a SUSPENDED delivery, which
 * `openclaw tasks retry` can redrive and `openclaw tasks dismiss` can abandon. The
 * announce-cleanup path wrote the same value for a delivery that was deliberately and
 * TERMINALLY not made — and both `retrySubagentCompletionDelivery` and
 * `dismissSubagentCompletionDelivery` refuse that one, because each requires
 * `delivery.status === "suspended"` on the backing run.
 *
 * With both collapsed onto `"failed"`, the rule "a blocked mirrored flow is terminal
 * only when dismissed" left the suppressed case permanently NON-terminal: not
 * retryable, not dismissable, and — because a non-terminal flow is neither deletable
 * nor prunable — not removable either. A flow with no exit at all. The fix splits the
 * value: a terminally suppressed delivery projects as `"suppressed"`, which is
 * terminal, while a suspended one keeps `"failed"` and stays resumable.
 *
 * So the thing worth proving is the three-way split, on both of the kernel's call
 * sites, and through every path that could bury or strand a record.
 *
 * Real vs stubbed:
 *   - REAL: the TaskFlow registry (`createTaskFlowForTask`, `syncFlowFromTaskResult`,
 *     `getTaskFlowById`, `deleteTaskFlowRecordById`) against a real on-disk SQLite
 *     store in a temp state dir.
 *   - REAL: the records kernel that decides terminality
 *     (`isTerminalTaskMirroredFlowStatus` -> `resolveTaskMirroredFlowTiming`),
 *     exercised through BOTH call sites: flow creation AND flow resync.
 *   - REAL: `isTerminalTaskFlow` (src/tasks/task-flow-registry.types.ts), the
 *     predicate every consumer uses.
 *   - REAL: `clearTerminalTaskFlowsByStatus`, the bulk path behind the gateway's
 *     `taskFlows.clearTerminal` method and the Control-UI clear actions.
 *   - REAL: the CLI commands `flowsDeleteCommand` / `flowsRetryCommand` from
 *     src/commands/flows.ts, driven through a genuine `RuntimeEnv` that records
 *     log/error/exit rather than writing to the terminal.
 *   - STUBBED (edge only): nothing between an entrypoint and the registry. The task
 *     records fed in are constructed to match exactly what the production paths
 *     persist:
 *       * `blockSubagentCompletionDelivery` -> `deliveryStatus: "failed"` +
 *         `terminalOutcome: "blocked"` (suspended, still redrivable)
 *         — subagent-completion-admission.store.ts
 *       * announce cleanup with `intentional_non_delivery` over an already-failed
 *         delivery -> `deliveryStatus: "suppressed"` + `terminalOutcome: "blocked"`
 *         — subagent-registry-lifecycle-announce-cleanup.ts
 *       * `dismissSubagentCompletionDelivery` -> `deliveryStatus: "dismissed"` +
 *         `terminalOutcome: "blocked"` — subagent-completion-delivery.ts
 *       * `projectRedrivenTask` -> `terminalOutcome: "succeeded"` after a redrive
 *
 * Scenarios:
 *   1. A SUSPENDED (`failed`) delivery is born non-terminal and stays non-terminal
 *      across a resync — the recoverable case is untouched by this change.
 *   2. A SUPPRESSED delivery is born terminal at creation and stays terminal across a
 *      resync, so it can actually be removed.
 *   3. `openclaw tasks flow delete` deletes the suppressed flow and REFUSES the
 *      suspended one.
 *   4. The bulk clear path clears the suppressed flow and skips the suspended one.
 *   5. `openclaw tasks flow retry` refuses the suppressed flow (nothing to redrive)
 *      and reaches the real gateway seam for the suspended one.
 *   6. A DISMISSED delivery is still terminal — the pre-existing rule is preserved.
 *   7. A successful redrive still clears the blocked state for the suspended case.
 *   8. A genuinely failed task RUN is terminal unconditionally, whatever its delivery
 *      status says — there is no run-level redrive to protect.
 *
 * Run: pnpm tsx scripts/proof-taskflow-retryable-failure.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RuntimeEnv } from "../src/runtime.js";
import type { TaskRecord } from "../src/tasks/task-registry.types.js";

const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-proof-retryable-failure-"));
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
 * A completed run whose completion delivery did not reach the requester. The run
 * itself succeeded and its terminal outcome is `blocked`; only `deliveryStatus`
 * distinguishes what can still be done about it.
 */
function blockedTask(
  taskId: string,
  deliveryStatus: TaskRecord["deliveryStatus"],
  at: number,
): TaskRecord {
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
    deliveryStatus,
    notifyPolicy: "done_only",
    createdAt: at - 50,
    lastEventAt: at,
    endedAt: at,
    terminalSummary: "Task completed; result delivery did not reach the requester.",
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

  console.log("scenario 1: a SUSPENDED delivery stays recoverable and non-terminal");
  const suspendedTask = blockedTask("task-suspended", "failed", now);
  const suspended = createTaskFlowForTask({ task: suspendedTask });
  if (!suspended) {
    throw new Error("registry did not create the suspended mirrored flow");
  }
  check("flow mirrors the task as blocked", suspended.status === "blocked", suspended.status);
  check("no endedAt stamped at creation", suspended.endedAt === undefined, suspended.endedAt);
  check("isTerminalTaskFlow is false", isTerminalTaskFlow(suspended) === false);
  check(
    "blockedTaskId is recorded so retry can find the task",
    suspended.blockedTaskId === "task-suspended",
    suspended.blockedTaskId,
  );
  const suspendedResync = syncFlowFromTaskResult({
    ...suspendedTask,
    parentFlowId: suspended.flowId,
    lastEventAt: now + 1_000,
  });
  check("resync succeeded", suspendedResync.ok);
  const suspendedAfter = suspendedResync.ok ? suspendedResync.flow : undefined;
  check("still blocked after resync", suspendedAfter?.status === "blocked", suspendedAfter?.status);
  check("still no endedAt after resync", suspendedAfter?.endedAt === undefined);
  check(
    "still non-terminal after resync",
    suspendedAfter ? !isTerminalTaskFlow(suspendedAfter) : false,
  );

  console.log("scenario 2: a SUPPRESSED delivery is terminal at creation and stays terminal");
  const suppressedTask = blockedTask("task-suppressed", "suppressed", now);
  const suppressed = createTaskFlowForTask({ task: suppressedTask });
  if (!suppressed) {
    throw new Error("registry did not create the suppressed mirrored flow");
  }
  check("flow mirrors the task as blocked", suppressed.status === "blocked", suppressed.status);
  check("endedAt IS stamped at creation", suppressed.endedAt === now, suppressed.endedAt);
  check("isTerminalTaskFlow is true", isTerminalTaskFlow(suppressed) === true);
  const suppressedResync = syncFlowFromTaskResult({
    ...suppressedTask,
    parentFlowId: suppressed.flowId,
    lastEventAt: now + 1_000,
    endedAt: now + 1_000,
  });
  const suppressedAfter = suppressedResync.ok ? suppressedResync.flow : undefined;
  check("resync succeeded", suppressedResync.ok);
  check("resync did NOT revive it", suppressedAfter ? isTerminalTaskFlow(suppressedAfter) : false);
  check(
    "endedAt tracked the newer event",
    suppressedAfter?.endedAt === now + 1_000,
    suppressedAfter?.endedAt,
  );

  console.log(
    "scenario 3: `tasks flow delete` removes the suppressed flow, refuses the suspended one",
  );
  const deleteSuppressed = captureRuntime();
  await flowsDeleteCommand({ lookup: suppressed.flowId }, deleteSuppressed.runtime);
  check(
    "delete did NOT exit non-zero",
    deleteSuppressed.exits.length === 0,
    deleteSuppressed.exits,
  );
  check("delete reported no error", deleteSuppressed.errors.length === 0, deleteSuppressed.errors);
  check(
    "delete confirmed the removal",
    deleteSuppressed.logs.some(
      (line) => line.includes("Deleted") && line.includes(suppressed.flowId),
    ),
    deleteSuppressed.logs,
  );
  check("the suppressed record is GONE", getTaskFlowById(suppressed.flowId) === undefined);
  check(
    "deleting it again is a no-op at the registry",
    deleteTaskFlowRecordById(suppressed.flowId) === false,
  );

  const deleteSuspended = captureRuntime();
  await flowsDeleteCommand({ lookup: suspended.flowId }, deleteSuspended.runtime);
  check("delete exited non-zero for the suspended flow", deleteSuspended.exits.includes(1));
  check(
    "refusal explains the flow is still blocked",
    deleteSuspended.errors.some((line) => line.includes("still blocked")),
    deleteSuspended.errors,
  );
  check("nothing was logged as deleted", deleteSuspended.logs.length === 0, deleteSuspended.logs);
  check(
    "the suspended record SURVIVED the delete attempt",
    getTaskFlowById(suspended.flowId)?.flowId === suspended.flowId,
  );

  console.log("scenario 4: the bulk clear path clears suppressed and skips suspended");
  const secondSuppressed = createTaskFlowForTask({
    task: blockedTask("task-suppressed-2", "suppressed", now + 2_000),
  });
  if (!secondSuppressed) {
    throw new Error("registry did not create the second suppressed mirrored flow");
  }
  const bulk = clearTerminalTaskFlowsByStatus("blocked");
  check("bulk clear removed the suppressed flow", bulk.cleared === 1, bulk);
  check("bulk clear skipped the suspended flow", bulk.skipped === 1, bulk);
  check("the suppressed record is GONE", getTaskFlowById(secondSuppressed.flowId) === undefined);
  check(
    "the suspended record SURVIVED the bulk clear",
    getTaskFlowById(suspended.flowId)?.flowId === suspended.flowId,
  );

  console.log(
    "scenario 5: `tasks flow retry` refuses suppressed, reaches the gateway for suspended",
  );
  const thirdSuppressed = createTaskFlowForTask({
    task: blockedTask("task-suppressed-3", "suppressed", now + 3_000),
  });
  if (!thirdSuppressed) {
    throw new Error("registry did not create the third suppressed mirrored flow");
  }
  const retrySuppressed = captureRuntime();
  await flowsRetryCommand({ lookup: thirdSuppressed.flowId }, retrySuppressed.runtime);
  check(
    "retry refused the suppressed flow",
    retrySuppressed.exits.includes(1),
    retrySuppressed.exits,
  );
  check(
    "refusal says it is already finished and cannot be redriven",
    retrySuppressed.errors.some(
      (line) => line.includes("already finished") && line.includes("cannot be redriven"),
    ),
    retrySuppressed.errors,
  );

  // No live Gateway here, so the real `tasks.retry` call raises an expected CLI error
  // that `rethrowExpectedCliError` deliberately propagates (same contract as
  // `openclaw tasks retry`). Catching it proves the command resolved the flow's
  // blockedTaskId and reached the genuine gateway method rather than a stub.
  const retrySuspended = captureRuntime();
  let reachedGateway: { method?: unknown } | undefined;
  try {
    await flowsRetryCommand({ lookup: suspended.flowId }, retrySuspended.runtime);
  } catch (error: unknown) {
    reachedGateway = error as { method?: unknown };
  }
  check("retry reached the real gateway call for the suspended flow", reachedGateway !== undefined);
  check(
    "the gateway method invoked was tasks.retry",
    reachedGateway?.method === "tasks.retry",
    reachedGateway?.method,
  );
  check(
    "the suspended record SURVIVED and is still non-terminal",
    !isTerminalTaskFlow(getTaskFlowById(suspended.flowId)!),
  );

  console.log("scenario 6: a DISMISSED delivery is still terminal (pre-existing rule preserved)");
  const dismissed = createTaskFlowForTask({
    task: blockedTask("task-dismissed", "dismissed", now + 4_000),
  });
  if (!dismissed) {
    throw new Error("registry did not create the dismissed mirrored flow");
  }
  check("dismissed flow is blocked", dismissed.status === "blocked", dismissed.status);
  check("dismissed flow HAS endedAt", dismissed.endedAt === now + 4_000, dismissed.endedAt);
  check("dismissed flow is terminal", isTerminalTaskFlow(dismissed) === true);

  console.log("scenario 7: a successful redrive still clears the blocked state");
  const redriven = syncFlowFromTaskResult({
    ...suspendedTask,
    parentFlowId: suspended.flowId,
    terminalOutcome: "succeeded",
    deliveryStatus: "delivered",
    lastEventAt: now + 5_000,
    endedAt: now + 5_000,
  });
  const redrivenFlow = redriven.ok ? redriven.flow : undefined;
  check("redrive resync succeeded", redriven.ok);
  check("flow left the blocked state", redrivenFlow?.status === "succeeded", redrivenFlow?.status);
  check("flow is now terminal", redrivenFlow ? isTerminalTaskFlow(redrivenFlow) : false);
  check("blockedTaskId was cleared", redrivenFlow?.blockedTaskId === undefined);

  console.log("scenario 8: a failed task RUN is terminal whatever its delivery status says");
  // There is no run-level redrive anywhere: terminal task statuses are absorbing, and
  // `tasks.retry` redrives a completion delivery, never a run. So `failed` needs no
  // conditional terminality — and must not get one, or it would become unremovable.
  for (const deliveryStatus of ["failed", "suppressed", "dismissed", "not_applicable"] as const) {
    const failedRun = createTaskFlowForTask({
      task: {
        ...blockedTask(`task-run-failed-${deliveryStatus}`, deliveryStatus, now + 6_000),
        status: "failed",
        terminalOutcome: undefined,
        error: "subagent run orphaned: lost active execution context",
      } as TaskRecord,
    });
    if (!failedRun) {
      throw new Error(`registry did not create the failed mirrored flow (${deliveryStatus})`);
    }
    check(
      `failed run flow is "failed" (deliveryStatus=${deliveryStatus})`,
      failedRun.status === "failed",
      failedRun.status,
    );
    check(
      `failed run flow is terminal (deliveryStatus=${deliveryStatus})`,
      isTerminalTaskFlow(failedRun) === true,
    );
    check(
      `failed run flow has endedAt (deliveryStatus=${deliveryStatus})`,
      failedRun.endedAt === now + 6_000,
      failedRun.endedAt,
    );
  }
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
