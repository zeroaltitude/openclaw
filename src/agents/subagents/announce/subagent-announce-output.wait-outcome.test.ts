// Wait-outcome announce tests, split from subagent-announce-output.test.ts to keep
// each file under the max-lines ratchet. Same subject, same test-support shim.
import { describe, expect, it } from "vitest";
import { applySubagentWaitOutcome } from "./subagent-announce-output.test-support.js";

describe("applySubagentWaitOutcome", () => {
  it.each([
    { endedAt: undefined, prior: undefined, expected: "still-running" },
    { endedAt: 150, prior: undefined, expected: "exited" },
    { endedAt: undefined, prior: "exited", expected: "exited" },
    { endedAt: undefined, prior: "killed", expected: "killed" },
  ] as const)(
    "preserves stop evidence (endedAt=$endedAt, prior=$prior)",
    ({ endedAt, prior, expected }) => {
      const applied = applySubagentWaitOutcome({
        wait: { status: "timeout", endedAt },
        outcome: prior ? { status: "timeout", disposition: prior } : undefined,
      });
      expect(applied.outcome).toMatchObject({ status: "timeout", disposition: expected });
    },
  );

  it.each([
    {
      name: "treats blocked ok waits as errors",
      wait: {
        status: "ok",
        livenessState: "blocked",
        error: "Context overflow: prompt too large for the model.",
      },
      expected: { status: "error", error: "Context overflow: prompt too large for the model." },
    },
    {
      name: "treats abandoned ok waits as incomplete failures",
      wait: { status: "ok", livenessState: "abandoned" },
      expected: { status: "error", error: "Agent run ended before producing a complete result." },
    },
    {
      // A provider hard timeout is the run's own budget firing, so unlike a bare
      // wait timeout it does prove the child stopped.
      name: "keeps provider hard timeouts stronger than blocked metadata",
      wait: {
        status: "error",
        livenessState: "blocked",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "model timed out",
      },
      expected: { status: "timeout", disposition: "exited" },
    },
    ...(["rpc", "superseded"] as const).map((stopReason) => ({
      name: `keeps explicit ${stopReason} cancellation distinct from timeouts`,
      wait: { status: "timeout", stopReason },
      expected: { status: "error", error: "subagent run terminated", disposition: "killed" },
    })),
    // Explicit cancellation must outrank blocked liveness (openclaw#125407).
    ...(["restart", "aborted"] as const).map((stopReason) => ({
      name: `keeps ${stopReason} as cancellation even when liveness is blocked`,
      wait: {
        status: "ok",
        stopReason,
        livenessState: "blocked",
        error: "Context overflow: prompt too large for the model.",
      },
      expected: { status: "error", error: "subagent run terminated", disposition: "killed" },
    })),
    {
      name: "keeps the failure cause on pending-error timeout waits",
      wait: {
        status: "timeout",
        pendingError: true,
        error: "model returned an unrecoverable tool-call sequence",
      },
      expected: {
        status: "timeout",
        error: "model returned an unrecoverable tool-call sequence",
        disposition: "exited",
      },
    },
    {
      name: "ignores error text when the run did not end in a pending error",
      wait: { status: "timeout", error: "waited too long" },
      expected: { status: "timeout", disposition: "exited" },
    },
  ])("$name", ({ wait, expected }) => {
    const applied = applySubagentWaitOutcome({
      wait: { ...wait, startedAt: 100, endedAt: 150 },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      ...expected,
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  // Regression (openclaw-kkv1): a wait expiry and a dead child both arrived as
  // a bare `status: "timeout"`, so the announce layer could only report one
  // wording for both. The disposition is what keeps them apart downstream.
  it("records an unconfirmed stop when a timeout snapshot carries no terminal evidence", () => {
    const applied = applySubagentWaitOutcome({
      wait: { status: "timeout", startedAt: 100 },
      outcome: undefined,
    });

    expect(applied.outcome?.status).toBe("timeout");
    expect(applied.outcome?.disposition).toBe("still-running");
  });

  it.each([
    { wait: { status: "timeout" }, expected: "still-running" },
    { wait: { status: "timeout", endedAt: 175 }, expected: "exited" },
    { wait: { status: "timeout", stopReason: "timeout" }, expected: "exited" },
  ])(
    "distinguishes retained provisional timing from fresh wait evidence: $expected",
    ({ wait, expected }) => {
      // Old persisted rows called the wait deadline endedAt. Replaying that
      // timestamp is not a child stop; a new terminal wait snapshot is.
      const applied = applySubagentWaitOutcome({
        wait,
        startedAt: 100,
        endedAt: 150,
        outcome: {
          status: "timeout",
          timeoutDisposition: "child-unconfirmed",
          startedAt: 100,
          endedAt: 150,
        },
      });
      expect(applied.outcome?.disposition).toBe(expected);
      expect(applied.outcome?.timeoutDisposition).toBeUndefined();
    },
  );

  it("records an observed stop when a timeout snapshot carries terminal evidence", () => {
    const applied = applySubagentWaitOutcome({
      wait: { status: "timeout", startedAt: 100, endedAt: 150 },
      outcome: undefined,
    });

    expect(applied.outcome?.status).toBe("timeout");
    expect(applied.outcome?.disposition).toBe("exited");
  });

  it("does not downgrade an already-observed stop when a later wait expiry has no evidence", () => {
    const applied = applySubagentWaitOutcome({
      wait: { status: "timeout" },
      outcome: { status: "timeout", timeoutDisposition: "child-stopped" },
    });

    expect(applied.outcome?.disposition).toBe("exited");
  });
});
