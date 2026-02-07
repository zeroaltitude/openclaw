import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "./types.js";
import { recomputeNextRuns } from "./service/jobs.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job-1",
    name: "Test Job",
    enabled: true,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 60_000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "hello" },
    state: {},
    ...overrides,
  };
}

describe("recomputeNextRuns", () => {
  it("preserves nextRunAtMs for a due job that has not yet executed", () => {
    // Regression test: when recomputeNextRuns runs at (or just after) the
    // trigger time, it must NOT advance nextRunAtMs past the current slot
    // if the job hasn't been executed yet. This prevents a TOCTOU race
    // where runDueJobs never sees the job as due.
    const triggerAtMs = 60_000;
    const job = makeJob({
      state: {
        nextRunAtMs: triggerAtMs,
        // lastRunAtMs is undefined — job has never run
      },
    });

    const state = {
      store: { version: 1, jobs: [job] },
      deps: {
        nowMs: () => triggerAtMs, // exactly at trigger time
        log: noopLogger,
      },
    } as any;

    recomputeNextRuns(state);

    // nextRunAtMs should be preserved (not advanced to the next slot)
    expect(job.state.nextRunAtMs).toBe(triggerAtMs);
  });

  it("preserves nextRunAtMs when timer fires slightly late", () => {
    const triggerAtMs = 60_000;
    const job = makeJob({
      state: {
        nextRunAtMs: triggerAtMs,
      },
    });

    const state = {
      store: { version: 1, jobs: [job] },
      deps: {
        nowMs: () => triggerAtMs + 50, // 50ms late
        log: noopLogger,
      },
    } as any;

    recomputeNextRuns(state);

    expect(job.state.nextRunAtMs).toBe(triggerAtMs);
  });

  it("advances nextRunAtMs after the job has executed", () => {
    const triggerAtMs = 60_000;
    const job = makeJob({
      state: {
        nextRunAtMs: triggerAtMs,
        lastRunAtMs: triggerAtMs, // job already ran for this slot
      },
    });

    const state = {
      store: { version: 1, jobs: [job] },
      deps: {
        nowMs: () => triggerAtMs + 100,
        log: noopLogger,
      },
    } as any;

    recomputeNextRuns(state);

    // Should advance to the next occurrence
    expect(job.state.nextRunAtMs).toBe(triggerAtMs + 60_000);
  });

  it("advances nextRunAtMs normally when the job is not yet due", () => {
    const triggerAtMs = 60_000;
    const job = makeJob({
      state: {
        nextRunAtMs: triggerAtMs,
      },
    });

    const state = {
      store: { version: 1, jobs: [job] },
      deps: {
        nowMs: () => 30_000, // well before trigger time
        log: noopLogger,
      },
    } as any;

    recomputeNextRuns(state);

    // Should remain at the original trigger time (still in the future)
    expect(job.state.nextRunAtMs).toBe(triggerAtMs);
  });

  it("does not preserve nextRunAtMs for a currently-running job", () => {
    // If the job is already running (runningAtMs set), recompute should
    // advance normally — the "preserve" guard only applies to unstarted slots.
    const triggerAtMs = 60_000;
    const job = makeJob({
      state: {
        nextRunAtMs: triggerAtMs,
        runningAtMs: triggerAtMs, // currently executing
      },
    });

    const state = {
      store: { version: 1, jobs: [job] },
      deps: {
        nowMs: () => triggerAtMs + 100,
        log: noopLogger,
      },
    } as any;

    recomputeNextRuns(state);

    // Should advance since the job is currently running
    expect(job.state.nextRunAtMs).toBe(triggerAtMs + 60_000);
  });
});
