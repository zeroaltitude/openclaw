/**
 * Pinned-generation admission for prepared model runtime leases.
 *
 * openclaw-bkzd: every `sessions_spawn` on a warm gateway died ~10ms after being
 * accepted, with `errorCode=UNAVAILABLE` and the message "prepared model runtime
 * replaced the admitted plugin generation" — and the spawning session saw no
 * error at all, only an absent result. That made autonomous delegation silently
 * unusable: a heartbeat believed it had dispatched two subagents when neither
 * ever ran a turn.
 *
 * Cause: `acquirePreparedModelRuntimeLeaseFromOwners` honoured
 * `options.pluginGeneration` only on the publish path. The reuse path called
 * `prepareSnapshot(input)`, which takes no generation argument, so a pinned run
 * that found an existing owner silently received whatever generation lived at
 * that key. Because the admitting caller re-checks by REFERENCE identity, a
 * structurally identical snapshot from another generation still failed. A warm
 * gateway nearly always has an owner at the key, and a boot publishing several
 * generations leaves the pinned one no longer current — so this was ~100%
 * reproducible rather than a rare race.
 *
 * These pin the predicate that decides reuse-vs-publish. Nothing passed a pin to
 * this code in any prior test, which is exactly why the asymmetry shipped.
 */

import { describe, expect, it } from "vitest";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { preparedGenerationPinSatisfied } from "./prepared-model-runtime-lease.js";

/**
 * Two distinct objects that are structurally identical. The bug lives entirely
 * in the gap between `===` and deep equality, so the fixtures have to be
 * indistinguishable by value.
 */
function makeSnapshot(): PluginMetadataSnapshot {
  return { plugins: [] } as unknown as PluginMetadataSnapshot;
}

describe("preparedGenerationPinSatisfied", () => {
  it("is satisfied when there is no pin, leaving unpinned callers untouched", () => {
    // The overwhelmingly common path: ordinary turns pass no generation and must
    // keep reusing the owner at their key.
    expect(preparedGenerationPinSatisfied({ existing: undefined })).toBe(true);
    expect(preparedGenerationPinSatisfied({ existing: { snapshot: undefined } })).toBe(true);
  });

  it("is satisfied when the existing owner already holds the pinned generation", () => {
    const pinned = makeSnapshot();
    expect(
      preparedGenerationPinSatisfied({
        existing: { snapshot: { metadataSnapshot: pinned } as never },
        pluginGeneration: { pluginMetadataSnapshot: pinned },
      }),
    ).toBe(true);
  });

  it("is NOT satisfied for a different generation object — the actual outage", () => {
    // Structurally identical, referentially distinct. This is precisely the
    // comparison run-orchestrator.ts performs, and the case that killed every
    // spawn: before the fix the reuse path was taken here, handing back the
    // wrong generation and tripping the admitted-generation guard.
    const admitted = makeSnapshot();
    const current = makeSnapshot();
    expect(admitted).toEqual(current);
    expect(admitted).not.toBe(current);
    expect(
      preparedGenerationPinSatisfied({
        existing: { snapshot: { metadataSnapshot: current } as never },
        pluginGeneration: { pluginMetadataSnapshot: admitted },
      }),
    ).toBe(false);
  });

  it("is NOT satisfied when there is no owner to inspect", () => {
    expect(
      preparedGenerationPinSatisfied({
        existing: undefined,
        pluginGeneration: { pluginMetadataSnapshot: makeSnapshot() },
      }),
    ).toBe(false);
  });

  it("is NOT satisfied when the owner has no snapshot yet", () => {
    // A pending owner cannot be shown to hold the pinned generation. Guessing
    // that it does is what produced the outage, so this fails toward publishing.
    expect(
      preparedGenerationPinSatisfied({
        existing: { snapshot: undefined },
        pluginGeneration: { pluginMetadataSnapshot: makeSnapshot() },
      }),
    ).toBe(false);
  });
});
