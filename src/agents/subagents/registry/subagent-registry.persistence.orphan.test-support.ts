import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { callGateway } from "../../../gateway/call.js";
import { recordGatewayBootStart } from "../../../infra/gateway-boot-lifecycle.js";
import { loadGatewayBootSegmentsForAttribution } from "./subagent-orphan-attribution.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { getSubagentRunByChildSessionKey, testing } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentSessionStatus } from "./subagent-session-metrics.js";

export function registerSubagentOrphanTaskCases({
  announceSpy,
  flushQueuedRegistryWork,
  readPersistedRegistry,
  writePersistedRegistry,
  restartRegistry,
  waitForRegistryWork,
}: {
  announceSpy: () => Promise<"delivered" | "retryable">;
  flushQueuedRegistryWork: () => Promise<void>;
  readPersistedRegistry: () => { runs: Record<string, SubagentRunRecord> };
  writePersistedRegistry: (
    persisted: Record<string, unknown>,
    opts?: { seedChildSessions?: boolean },
  ) => Promise<void>;
  restartRegistry: () => Promise<void>;
  waitForRegistryWork: (predicate: () => boolean | Promise<boolean>) => Promise<void>;
}) {
  it("preserves stale unended restored runs for attributed sweeper recovery", async () => {
    const now = Date.now();
    const runId = "run-stale-unended-restore";
    const childSessionKey = "agent:main:subagent:stale-unended-restore";
    await writePersistedRegistry({
      version: 2,
      runs: {
        [runId]: {
          runId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "stale unended restored work",
          cleanup: "keep",
          createdAt: now - 3 * 60 * 60 * 1_000,
          startedAt: now - 3 * 60 * 60 * 1_000,
        },
      },
    });
    const priorBootId = recordGatewayBootStart(process.env, now - 4 * 60 * 60 * 1_000);
    expect(priorBootId).toBeDefined();
    expect(recordGatewayBootStart(process.env, now - 2 * 60 * 60 * 1_000)).toBeDefined();
    // Refresh the process-level boot snapshot after writing the two lifecycle
    // rows so the production sweeper observes this test's persisted state.
    await loadGatewayBootSegmentsForAttribution(Date.now(), { forceRefresh: true });

    await restartRegistry();
    await flushQueuedRegistryWork();

    expect(callGateway).not.toHaveBeenCalled();
    expect(readPersistedRegistry().runs?.[runId]).toBeDefined();

    await testing.sweepOnceForTests();

    expect(callGateway).not.toHaveBeenCalled();
    expect(getSubagentRunByChildSessionKey(childSessionKey)?.execution.outcome).toMatchObject({
      status: "error",
      // Attribution must name the persisted owning boot on every platform;
      // exact host/process wording depends on authoritative kernel boot IDs.
      error: expect.stringContaining(`(previous boot ${priorBootId} ended without a clean stop`),
    });
    await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled(), {
      timeout: 1_000,
      interval: 10,
    });
  });

  it.each(["observation-only", "ordinary"] as const)(
    "handles a missing-session restored %s run without inventing child stop evidence",
    async (representation) => {
      const now = Date.now();
      const runId = `run-missing-session-${representation}`;
      const childSessionKey = `agent:main:subagent:missing-session-${representation}`;
      const observed = representation === "observation-only";
      await writePersistedRegistry(
        {
          runs: {
            [runId]: {
              runId,
              taskRunId: runId,
              generation: 1,
              childSessionKey,
              requesterSessionKey: "agent:main:main",
              requesterDisplayKey: "main",
              task: "restore missing session without stop evidence",
              cleanup: "keep",
              expectsCompletionMessage: false,
              createdAt: now - 10_000,
              execution: { status: "running", startedAt: now - 10_000 },
              ...(observed ? { waitExpiryObservedAt: now - 1_000 } : {}),
            },
          },
        },
        { seedChildSessions: false },
      );
      const childResult = createDeferred<{ status: "ok"; startedAt: number; endedAt: number }>();
      vi.mocked(callGateway).mockImplementation(async (request) =>
        request.method === "agent.wait" ? await childResult.promise : {},
      );
      const hasWait = () =>
        vi.mocked(callGateway).mock.calls.some(([request]) => request.method === "agent.wait");
      try {
        restartRegistry();
        // Reach either the legitimate re-wait or the erroneous terminal path;
        // do not use a sleep to infer absence of asynchronous completion.
        await waitForRegistryWork(
          () => hasWait() || resolveSubagentSessionStatus(subagentRuns.get(runId)) === "failed",
        );
        if (observed) {
          expect(hasWait(), "unconfirmed child is re-waited after restore").toBe(true);
          const retained = subagentRuns.get(runId);
          expect(resolveSubagentSessionStatus(retained)).toBe("running");
          expect(retained?.waitExpiryObservedAt).toBe(now - 1_000);
          expect(retained?.execution.endedAt).toBeUndefined();
          expect(retained?.execution.outcome).toBeUndefined();
          expect(retained?.cleanupCompletedAt).toBeUndefined();
          childResult.resolve({ status: "ok", startedAt: now - 10_000, endedAt: now });
          await waitForRegistryWork(
            () => subagentRuns.get(runId)?.execution.outcome?.status === "ok",
          );
        } else {
          expect(hasWait(), "ordinary orphan still reaches canonical completion").toBe(false);
          expect(subagentRuns.get(runId)?.execution.outcome).toMatchObject({
            status: "error",
            error: "subagent run orphaned: missing-session-entry",
          });
          await waitForRegistryWork(() => subagentRuns.get(runId)?.cleanupCompletedAt !== undefined);
        }
      } finally {
        childResult.resolve({ status: "ok", startedAt: now - 10_000, endedAt: now });
      }
    },
  );

  it("terminalizes a stale restored orphan without replaying its provider", async () => {
    const now = Date.now();
    const runId = "run-stale-unended-restore";
    const childSessionKey = "agent:main:subagent:stale-unended-restore";
    await writePersistedRegistry({
      version: 2,
      runs: {
        [runId]: {
          runId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "stale unended restored work",
          cleanup: "keep",
          createdAt: now - 3 * 60 * 60 * 1_000,
          startedAt: now - 3 * 60 * 60 * 1_000,
        },
      },
    });
    // The boot snapshot is process-level; drop rows cached by earlier cases so
    // this fresh state dir (no boot history) takes the unattributed path.
    await loadGatewayBootSegmentsForAttribution(Date.now(), { forceRefresh: true });

    await restartRegistry();
    await testing.sweepOnceForTests();
    await waitForRegistryWork(
      () => resolveSubagentSessionStatus(subagentRuns.get(runId)) === "failed",
    );
    expect(callGateway).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });
}
