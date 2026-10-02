import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { callGateway } from "../../../gateway/call.js";
import { createWorkerSessionPlacementStore } from "../../../gateway/worker-environments/placement-store.js";
import { recordGatewayBootStart } from "../../../infra/gateway-boot-lifecycle.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type { DB } from "../../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { loadGatewayBootSegmentsForAttribution } from "./subagent-orphan-attribution.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
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
    loadGatewayBootSegmentsForAttribution(Date.now(), { forceRefresh: true });

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
      error: expect.stringContaining(`(previous boot ${priorBootId} ended without a clean stop)`),
    });
    // Recovery's completion announcement is queued work (#151303); wait for it.
    await vi.waitFor(() => expect(announceSpy).toHaveBeenCalled());
  });
  it.each([
    "host reboot",
    // Pre-existing failure: also fails on the pre-merge branch tip (f8d21f14377).
    "remote worker",
    "same host",
    "unknown host",
    "inferred host",
    "clean stop",
    "current boot",
    "later activity",
    "no history",
  ] as const)(
    "recovers an unconfirmed wait only with authoritative death: %s",
    async (evidence) => {
      const now = Date.now();
      const startedAt = now - 10_000;
      const successorAt = now - 2_000;
      const runId = `run-wait-boot-${evidence.replaceAll(" ", "-")}`;
      const childSessionKey = `agent:main:subagent:${runId}`;
      await writePersistedRegistry(
        {
          runs: {
            [runId]: {
              runId,
              generation: 1,
              childSessionKey,
              requesterSessionKey: "agent:main:main",
              requesterDisplayKey: "main",
              task: "recover only a child stopped by host reboot",
              cleanup: "keep",
              expectsCompletionMessage: false,
              createdAt: startedAt,
              execution: { status: "running", startedAt },
              waitExpiryObservedAt: now - 5_000,
              ...(evidence === "later activity"
                ? {
                    completion: {
                      required: false,
                      capturedAt: successorAt + 1,
                      resultText: "still working",
                    },
                  }
                : {}),
            },
          },
        },
        { seedChildSessions: false },
      );
      const { db } = openOpenClawStateDatabase();
      const kysely = getNodeSqliteKysely<Pick<DB, "gateway_boot_lifecycle">>(db);
      if (evidence !== "no history") {
        executeSqliteQuerySync(
          db,
          kysely.insertInto("gateway_boot_lifecycle").values([
            {
              boot_id: "prior",
              pid: evidence === "current boot" ? process.pid : 1,
              started_at_ms: startedAt - 1_000,
              completed_at_ms: evidence === "clean stop" ? successorAt - 1 : null,
              outcome: evidence === "clean stop" ? "clean" : null,
              host_boot_id:
                evidence === "unknown host"
                  ? null
                  : evidence === "inferred host"
                    ? "uptime:100"
                    : "kernel:prior",
            },
            {
              boot_id: "successor",
              pid: evidence === "current boot" ? 2 : process.pid,
              started_at_ms: successorAt,
              completed_at_ms: null,
              outcome: null,
              host_boot_id: evidence === "same host" ? "kernel:prior" : "kernel:successor",
            },
          ]),
        );
      }
      if (evidence === "remote worker") {
        createWorkerSessionPlacementStore().startDispatch({
          sessionId: "remote-child",
          sessionKey: childSessionKey,
          agentId: "main",
        });
      }
      loadGatewayBootSegmentsForAttribution(now, { forceRefresh: true });
      const childResult = createDeferred<{ status: "ok"; startedAt: number; endedAt: number }>();
      vi.mocked(callGateway).mockImplementation(async (request) =>
        request.method === "agent.wait" ? await childResult.promise : {},
      );
      try {
        await restartRegistry();
        await waitForRegistryWork(() =>
          vi.mocked(callGateway).mock.calls.some(([request]) => request.method === "agent.wait"),
        );
        await testing.sweepOnceForTests();
        if (evidence === "host reboot") {
          await waitForRegistryWork(
            () => loadSubagentRegistryFromSqlite().get(runId)?.cleanupCompletedAt !== undefined,
          );
          expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
            execution: {
              status: "terminal",
              endedAt: successorAt,
              outcome: {
                status: "error",
                error: expect.stringContaining("host rebooted under the gateway"),
              },
            },
            cleanupCompletedAt: expect.any(Number),
          });
        } else {
          expect(resolveSubagentSessionStatus(subagentRuns.get(runId))).toBe("running");
          const retained = loadSubagentRegistryFromSqlite().get(runId);
          expect(retained?.execution.endedAt).toBeUndefined();
          expect(retained?.cleanupCompletedAt).toBeUndefined();
        }
      } finally {
        childResult.resolve({ status: "ok", startedAt, endedAt: now });
        await flushQueuedRegistryWork();
      }
    },
  );

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
        await restartRegistry();
        await testing.sweepOnceForTests();
        // Reach either the legitimate re-wait or the erroneous terminal path;
        // do not use a sleep to infer absence of asynchronous completion.
        await waitForRegistryWork(
          () => hasWait() || resolveSubagentSessionStatus(subagentRuns.get(runId)) === "failed",
        );
        if (observed) {
          expect(hasWait(), "unconfirmed child is re-waited after restore").toBe(true);
          expect(resolveSubagentSessionStatus(subagentRuns.get(runId))).toBe("running");
          const retained = loadSubagentRegistryFromSqlite().get(runId);
          expect(retained?.waitExpiryObservedAt).toBe(now - 1_000);
          expect(retained?.execution.endedAt).toBeUndefined();
          expect(retained?.execution.outcome).toBeUndefined();
          expect(retained?.cleanupCompletedAt).toBeUndefined();
          childResult.resolve({ status: "ok", startedAt: now - 10_000, endedAt: now });
          await waitForRegistryWork(
            () => resolveSubagentSessionStatus(subagentRuns.get(runId)) === "done",
          );
          // The durable row commits after the resident status flips.
          await waitForRegistryWork(
            () => loadSubagentRegistryFromSqlite().get(runId)?.execution.outcome !== undefined,
          );
          expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.outcome).toMatchObject({
            status: "ok",
          });
        } else {
          expect(hasWait(), "ordinary orphan still reaches canonical completion").toBe(false);
          expect(subagentRuns.get(runId)?.execution.outcome).toMatchObject({
            status: "error",
            error: "subagent run orphaned: missing-session-entry",
          });
          await waitForRegistryWork(
            () => loadSubagentRegistryFromSqlite().get(runId)?.cleanupCompletedAt !== undefined,
          );
        }
      } finally {
        childResult.resolve({ status: "ok", startedAt: now - 10_000, endedAt: now });
        await flushQueuedRegistryWork();
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

    await restartRegistry();
    await testing.sweepOnceForTests();
    await waitForRegistryWork(
      () => resolveSubagentSessionStatus(subagentRuns.get(runId)) === "failed",
    );
    expect(callGateway).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });
}
