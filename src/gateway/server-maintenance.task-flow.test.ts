// TaskFlow registry retention: hourly sweep that retires terminal records
// past their retention window. Split from server-maintenance.test.ts, which
// sits at the max-lines cap; mocks are hoisted per file, so the module-mock
// preamble is repeated while pure fixtures stay local to each block.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const { assertTaskFlowRegistryMaintenanceReadyMock, runTaskFlowRegistryMaintenanceMock } =
  vi.hoisted(() => ({
    assertTaskFlowRegistryMaintenanceReadyMock: vi.fn(),
    runTaskFlowRegistryMaintenanceMock: vi.fn(async () => ({ reconciled: 0, pruned: 0 })),
  }));

vi.mock("../infra/device-bootstrap.js", () => ({
  pruneExpiredDevicePairSetupCompletions: vi.fn(async () => 0),
}));

vi.mock("../infra/delivery-queue-sqlite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/delivery-queue-sqlite.js")>()),
  pruneExpiredDeliveryQueueTombstones: vi.fn(),
}));

vi.mock("../infra/outbound/delivery-queue-media-spool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/outbound/delivery-queue-media-spool.js")>()),
  pruneOrphanedDeliveryQueueMedia: vi.fn(async () => undefined),
}));

vi.mock("../media/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/store.js")>()),
  cleanOldMedia: vi.fn(async () => {}),
  pruneOutboundMedia: vi.fn(async () => {}),
  prunePlaybackTranscodeCache: vi.fn(async () => {}),
}));

vi.mock("../tasks/task-flow-registry.maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tasks/task-flow-registry.maintenance.js")>()),
  assertTaskFlowRegistryMaintenanceReady: assertTaskFlowRegistryMaintenanceReadyMock,
  runTaskFlowRegistryMaintenance: runTaskFlowRegistryMaintenanceMock,
}));

async function stopMaintenanceTimers(
  timers: ReturnType<typeof import("./server-maintenance.js").startGatewayMaintenanceTimers>,
): Promise<void> {
  clearInterval(timers.tickInterval);
  clearInterval(timers.healthInterval);
  clearInterval(timers.dedupeCleanup);
  clearInterval(timers.worktreeCleanup);
  await timers.stopMediaCleanup();
  await timers.stopSessionColdStorageMaintenance();
}

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    ...createGatewayMaintenanceStateForTest(),
    logHealth: { info: vi.fn(), error: vi.fn() },
    runWorktreeGc: vi.fn(async () => undefined),
    runDeliveryQueueMediaGc: vi.fn(async () => undefined),
    runManagedOutgoingMediaGc: vi.fn(async () => ({
      deletedRecordCount: 0,
      deletedFileCount: 0,
      retainedCount: 0,
    })),
    ...overrides,
  };
}

describe("gateway task-flow registry maintenance", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    assertTaskFlowRegistryMaintenanceReadyMock.mockReset();
    runTaskFlowRegistryMaintenanceMock.mockReset().mockResolvedValue({ reconciled: 0, pruned: 0 });
  });

  it("runs the real maintenance sweep at startup and hourly when no override is supplied", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const timers = startGatewayMaintenanceTimers(createDeps());

    await vi.advanceTimersByTimeAsync(0);
    expect(assertTaskFlowRegistryMaintenanceReadyMock).toHaveBeenCalledTimes(1);
    expect(runTaskFlowRegistryMaintenanceMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runTaskFlowRegistryMaintenanceMock).toHaveBeenCalledTimes(2);

    await stopMaintenanceTimers(timers);
  });

  it("runs an injected override at startup and hourly instead of the real sweep", async () => {
    vi.useFakeTimers();
    const runTaskFlowRegistryMaintenance = vi.fn(async () => undefined);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const timers = startGatewayMaintenanceTimers(createDeps({ runTaskFlowRegistryMaintenance }));

    await vi.advanceTimersByTimeAsync(0);
    expect(runTaskFlowRegistryMaintenance).toHaveBeenCalledTimes(1);
    expect(assertTaskFlowRegistryMaintenanceReadyMock).not.toHaveBeenCalled();
    expect(runTaskFlowRegistryMaintenanceMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runTaskFlowRegistryMaintenance).toHaveBeenCalledTimes(2);

    await stopMaintenanceTimers(timers);
  });

  it("logs and keeps retrying hourly when a sweep fails", async () => {
    vi.useFakeTimers();
    runTaskFlowRegistryMaintenanceMock.mockRejectedValueOnce(new Error("registry restore failed"));
    const logHealth = { info: vi.fn(), error: vi.fn() };
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const timers = startGatewayMaintenanceTimers(createDeps({ logHealth }));

    await vi.advanceTimersByTimeAsync(0);
    expect(logHealth.error).toHaveBeenCalledWith(
      expect.stringContaining("task-flow registry maintenance failed"),
    );
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runTaskFlowRegistryMaintenanceMock).toHaveBeenCalledTimes(2);

    await stopMaintenanceTimers(timers);
  });
});
