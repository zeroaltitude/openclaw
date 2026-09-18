// Proves each "armed background work" source against the real registry it
// reads, not a mock of the seam under test: the real TaskFlow registry, the
// real subagent-registry live-run map cross-checked against the real
// agent-run-registry liveness state, and the real cron session-binding
// resolver. Only the cron *service* itself is a minimal fake satisfying the
// exact narrow contract (`list`/`getDefaultAgentId`) the production wiring
// consumes -- there is no in-process singleton cron service to drive here.
import { afterEach, describe, expect, it } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import {
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  resumeFlow,
  setFlowWaiting,
} from "../tasks/task-flow-registry.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { resetTaskFlowRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { claimAgentRunContext, resetAgentRunRegistryForTest } from "./agent-run-registry.js";
import {
  listArmedCronWakeSessionKeys,
  listArmedSubagentWaitSessionKeys,
  listRunningTaskFlowSessionKeys,
} from "./background-activity-sources.js";

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

async function withFlowRegistryTempDir<T>(run: () => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-background-activity-taskflow-" },
    async () => {
      resetTaskFlowRegistryForTests({ persist: false });
      try {
        return await run();
      } finally {
        resetTaskFlowRegistryForTests({ persist: false });
      }
    },
  );
}

describe("listRunningTaskFlowSessionKeys", () => {
  it("includes a session whose TaskFlow status is running", async () => {
    await withFlowRegistryTempDir(async () => {
      const created = createManagedTaskFlow({
        ownerKey: "agent:main:armed-running",
        controllerId: "tests/armed-running-controller",
        goal: "background work",
      });
      const resumed = resumeFlow({
        flowId: created.flowId,
        expectedRevision: created.revision,
        status: "running",
        currentStep: "working",
      });
      expect(resumed.applied).toBe(true);

      expect(listRunningTaskFlowSessionKeys()).toContain("agent:main:armed-running");
    });
  });

  it("excludes a session whose TaskFlow status is waiting on an approval gate", async () => {
    await withFlowRegistryTempDir(async () => {
      const created = createManagedTaskFlow({
        ownerKey: "agent:main:armed-waiting",
        controllerId: "tests/armed-waiting-controller",
        goal: "background work",
      });
      const waiting = setFlowWaiting({
        flowId: created.flowId,
        expectedRevision: created.revision,
        currentStep: "await_review",
        waitJson: { kind: "task", taskId: "task-1" },
      });
      expect(waiting.applied).toBe(true);

      expect(listRunningTaskFlowSessionKeys()).not.toContain("agent:main:armed-waiting");
    });
  });
});

describe("listArmedSubagentWaitSessionKeys", () => {
  afterEach(() => {
    subagentRuns.clear();
    resetAgentRunRegistryForTest();
  });

  function fakeRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
    return {
      runId: overrides.runId ?? "run-live",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "agent:main:requester",
      task: "background proof task",
      cleanup: "keep",
      createdAt: Date.now(),
      execution: { status: "running" },
      ...overrides,
    } as SubagentRunRecord;
  }

  it("includes the requester session for a genuinely live, currently-tracked run", () => {
    const entry = fakeRun({ runId: "run-live", requesterSessionKey: "agent:main:live-requester" });
    subagentRuns.set(entry.runId, entry);
    // Real, currently-tracked gateway-side registration -- not a bare in-memory claim.
    claimAgentRunContext(entry.runId, {}, { trackOwner: true });

    expect(listArmedSubagentWaitSessionKeys()).toContain("agent:main:live-requester");
  });

  it("excludes an unended run with no live agent-run-registry registration (the hollow-wait case)", () => {
    const entry = fakeRun({
      runId: "run-hollow",
      requesterSessionKey: "agent:main:hollow-requester",
    });
    subagentRuns.set(entry.runId, entry);
    // Deliberately no claimAgentRunContext call: the run claims to still be
    // executing (`execution.endedAt` unset) but nothing real backs it.

    expect(listArmedSubagentWaitSessionKeys()).not.toContain("agent:main:hollow-requester");
  });

  it("excludes a run whose execution has already ended even if still claimed live", () => {
    const entry = fakeRun({
      runId: "run-ended",
      requesterSessionKey: "agent:main:ended-requester",
      execution: { status: "terminal", endedAt: Date.now() },
    });
    subagentRuns.set(entry.runId, entry);
    claimAgentRunContext(entry.runId, {}, { trackOwner: true });

    expect(listArmedSubagentWaitSessionKeys()).not.toContain("agent:main:ended-requester");
  });
});

describe("listArmedCronWakeSessionKeys", () => {
  const cfg = {} as OpenClawConfig;

  function fakeJob(overrides: Partial<CronJob> & Pick<CronJob, "id">): CronJob {
    return {
      agentId: "main",
      name: overrides.id,
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
      ...overrides,
    } as unknown as CronJob;
  }

  function fakeCron(jobs: CronJob[]) {
    return {
      list: async () => jobs,
      getDefaultAgentId: () => "main",
    };
  }

  it("includes a session bound to an enabled job with a pending future fire", async () => {
    const now = Date.parse("2026-09-17T00:00:00Z");
    const job = fakeJob({
      id: "armed-job",
      agentId: "cronowner",
      sessionTarget: "main",
      state: { nextRunAtMs: now + 60_000 },
    });
    const keys = await listArmedCronWakeSessionKeys({ cron: fakeCron([job]), cfg, now });
    expect(keys).toContain("agent:cronowner:main");
  });

  it("excludes a job with no scheduled next fire", async () => {
    const now = Date.parse("2026-09-17T00:00:00Z");
    const job = fakeJob({
      id: "unarmed-job",
      agentId: "cronowner2",
      sessionTarget: "main",
      state: {},
    });
    const keys = await listArmedCronWakeSessionKeys({ cron: fakeCron([job]), cfg, now });
    expect(keys).not.toContain("agent:cronowner2:main");
  });

  it("excludes a job whose next fire is well in the past (stale/stuck, not merely lagging)", async () => {
    const now = Date.parse("2026-09-17T00:00:00Z");
    const job = fakeJob({
      id: "stale-job",
      agentId: "cronowner3",
      sessionTarget: "main",
      state: { nextRunAtMs: now - 5 * 60_000 },
    });
    const keys = await listArmedCronWakeSessionKeys({ cron: fakeCron([job]), cfg, now });
    expect(keys).not.toContain("agent:cronowner3:main");
  });
});
