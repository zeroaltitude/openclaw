/**
 * Sweep handling for runs that are still marked active but have no execution
 * context left — the shape a subagent run is left in when the gateway dies
 * underneath it.
 *
 * Split out of the sweeper so the reap decision, which has to reason about boot
 * history and about who still needs to be told, reads as one thing.
 */
import { createWorkerSessionPlacementStore } from "../../../gateway/worker-environments/placement-store.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { formatDurationCompact } from "../../../infra/format-time/format-duration.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import {
  formatSubagentOrphanErrorMessage,
  hasRecordedSubagentOutput,
  loadGatewayBootSegmentsForAttribution,
  resolveSubagentOrphanAttribution,
  resolveSubagentRunLastActivityMs,
} from "./subagent-orphan-attribution.js";
import type {
  SubagentCompletionRequest,
  SubagentRecoveryCurrent,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import { isSubagentChildStopUnconfirmed } from "./subagent-session-metrics.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  resolveSubagentRunOrphanReason,
} from "./subagent-session-reconciliation.js";

const LOST_CONTEXT_ERROR = "subagent run lost active execution context";
const ORPHAN_COMPLETION_SOURCE = "sweeper-orphaned-by-gateway-death";
// Without a host reboot, an unconfirmed child stop is deferred every sweep
// forever — correct while evidence could still arrive, but a run that has
// carried that ambiguity this long is not waiting on evidence anymore; it is
// stuck. This is the one place ambiguity is allowed to expire on age alone,
// deliberately generous (a legitimate long-running task must never lose to
// this clock) and only reached after the real-time liveness recheck below
// still finds nothing claiming the child.
export const MAX_UNCONFIRMED_ORPHAN_AGE_MS = 24 * 60 * 60_000;

/**
 * Settles one stale active run through the canonical completion owner.
 * The caller stops processing this run; cleanup never bypasses canonical completion.
 */
export async function reconcileStaleActiveSubagentRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  /**
   * Re-asserts the caller's selection criteria. Boot history is read off the
   * gateway thread, so the run can be replaced or settled across that await;
   * anything learned before it describes a row we may no longer own.
   */
  isCurrent: () => boolean;
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
}): Promise<void> {
  const { entry, now, runId } = params;
  const accountId = entry.requesterOrigin?.accountId;
  const runStartedAtMs = entry.execution.startedAt ?? entry.createdAt;
  const sessionEntry = loadSubagentSessionEntry({
    childSessionKey: entry.childSessionKey,
  });
  // A fresh persisted terminal state is the child's authoritative outcome.
  // Resolve it before crash attribution so a later gateway death cannot
  // rewrite a real failure, timeout, or kill as an orphan diagnosis.
  const persistedCompletion = resolveCompletionFromSessionEntry(sessionEntry, now, {
    notBeforeMs: runStartedAtMs,
  });
  if (persistedCompletion) {
    await params.completeSubagentRunWithRecovery(
      {
        runId,
        expectedEntry: entry,
        startedAt: persistedCompletion.startedAt,
        endedAt: persistedCompletion.endedAt,
        outcome: persistedCompletion.outcome,
        reason: persistedCompletion.reason,
        sendFarewell: true,
        accountId,
        triggerCleanup: true,
      },
      "sweeper-session-completion",
    );
    return;
  }
  // The reap happens arbitrarily long after the death — it includes however
  // long the host stayed down. Correlate against boot history before writing
  // anything about this run: the reap clock is not evidence of its lifetime.
  const boots = await loadGatewayBootSegmentsForAttribution(now);
  if (!params.isCurrent()) {
    // The run was replaced or settled while the history read was in flight.
    // Whoever owns it now is ahead of us; a later sweep re-evaluates it.
    return;
  }
  const hasRecordedOutput = hasRecordedSubagentOutput(entry);
  const currentBootId = boots
    .toReversed()
    .find(
      (boot) => boot.pid === process.pid && boot.completedAtMs === null && boot.outcome === null,
    )?.bootId;
  const attribution = resolveSubagentOrphanAttribution({
    runStartedAtMs,
    lastActivityAtMs: resolveSubagentRunLastActivityMs(entry),
    hasRecordedOutput,
    boots,
    currentBootId,
  });
  // A missing process-local context is not child-stop evidence. Only an
  // authoritative host reboot (not a Gateway-only restart or inferred host
  // identity) can promote an unconfirmed wait without child terminal metadata.
  // Past MAX_UNCONFIRMED_ORPHAN_AGE_MS, stop deferring on that alone and fall
  // through to the real-time liveness recheck below instead — evidence of a
  // still-live child still wins there regardless of how long this has aged.
  const unconfirmedSinceMs =
    entry.waitExpiryObservedAt ?? resolveSubagentRunLastActivityMs(entry) ?? runStartedAtMs;
  const unconfirmedForMs = now - unconfirmedSinceMs;
  const unconfirmedAgedOut = unconfirmedForMs >= MAX_UNCONFIRMED_ORPHAN_AGE_MS;
  if (
    isSubagentChildStopUnconfirmed(entry) &&
    attribution?.cause !== "host_reboot" &&
    !unconfirmedAgedOut
  ) {
    return;
  }
  // Remote worker ownership survives missing session metadata. Default dispatch
  // is local only when no unreconciled worker placement exists; unknown
  // placement state is not positive local-child stop evidence.
  const hasNoRemoteOwner = () => {
    try {
      return !createWorkerSessionPlacementStore()
        .listForReconcile()
        .some((placement) => placement.sessionKey === entry.childSessionKey);
    } catch {
      return false;
    }
  };
  const recoveryCurrent: SubagentRecoveryCurrent | undefined = isSubagentChildStopUnconfirmed(entry)
    ? {
        isHostCurrent: () => !getAgentRunContext(runId),
        prepare: async () => !getAgentRunContext(runId) && hasNoRemoteOwner(),
      }
    : undefined;
  if (recoveryCurrent && !(await recoveryCurrent.prepare())) {
    return;
  }
  const attributedError = attribution ? formatSubagentOrphanErrorMessage(attribution) : undefined;

  const orphanReason = resolveSubagentRunOrphanReason({ entry });
  // Reached only when there was never a host-reboot attribution to explain the
  // gap: the ceiling expired before any attribution did. Name that plainly so
  // it reads as "we gave up waiting," not as a confirmed death.
  const agedOutError = unconfirmedAgedOut
    ? `subagent run's child stop could not be confirmed after ${formatDurationCompact(unconfirmedForMs) ?? "under 1s"}; treating as orphaned to avoid an indefinite stuck state`
    : undefined;
  // Every orphan settles through canonical completion; missing session metadata
  // never permits direct row or attachment pruning.

  await params.completeSubagentRunWithRecovery(
    {
      runId,
      expectedEntry: entry,
      // An attributed death ended when the run died, not when it was found.
      endedAt: attribution?.diedAtMs ?? now,
      outcome: {
        status: "error",
        error:
          attributedError ??
          agedOutError ??
          (orphanReason ? `subagent run orphaned: ${orphanReason}` : LOST_CONTEXT_ERROR),
      },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      ...(attribution ? { recoverInterrupted: true as const } : {}),
      // A freshly dispatched remote worker claim can still be forming when the
      // terminal completion lock resolves; only this attributed host-reboot
      // orphan path needs a settle window before trusting recoveryCurrent.
      ...(attribution && recoveryCurrent ? { hostRebootRecovery: true as const } : {}),
      ...(recoveryCurrent ? { recoveryCurrent } : {}),
      sendFarewell: true,
      accountId,
      triggerCleanup: true,
    },
    attribution ? ORPHAN_COMPLETION_SOURCE : "sweeper-lost-context",
  );
}
