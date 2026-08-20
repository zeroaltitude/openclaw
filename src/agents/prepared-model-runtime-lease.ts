/** Agent-run lease admission for lifecycle-owned prepared model runtimes. */
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
  hasConfiguredOwnerMatching,
  ownerKey,
  normalizePreparedModelRuntimeInput,
  publishModelRuntimeSnapshot,
  rebindInputToCommittedConfiguredOwner,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeLease,
  type PreparedModelRuntimeOwner,
  type PreparedModelRuntimeOwnerRetention,
  type PreparedModelRuntimeReplacement,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";
import type { PreparedModelRuntimeCatalogMode } from "./prepared-model-runtime.types.js";

type PreparedModelRuntimeLeaseContext = {
  owners: Map<string, PreparedModelRuntimeOwner>;
  agentBuildCompletions: Map<string, Promise<void>>;
  retainedDirectRunOwners: PreparedModelRuntimeOwnerRetention;
  retainedGatewayRunOwners: PreparedModelRuntimeOwnerRetention;
  getBuildTimeoutMs(): number;
  getGatewayLifecycleActive(): boolean;
  getPendingReplacement(): PreparedModelRuntimeReplacement | undefined;
  prepareSnapshot(input: PreparedModelRuntimeInput): Promise<PreparedModelRuntimeSnapshot>;
};

/**
 * Whether an existing owner already carries the generation a run was pinned to.
 *
 * A pinned caller passes the generation its run was ADMITTED against, and the
 * admitting caller then re-checks the lease by REFERENCE identity —
 * run-orchestrator.ts compares
 * `snapshot.metadataSnapshot !== pluginGeneration.pluginMetadataSnapshot` and
 * throws "prepared model runtime replaced the admitted plugin generation".
 * Structurally identical snapshots from two different generations are not `===`,
 * so reusing an owner built by a different generation fails that check and kills
 * the run — roughly 10ms in, with no error surfaced to the spawner.
 *
 * Returning false routes the caller to the publish path, which threads the
 * pinned `PluginMetadataSnapshot` object through unchanged
 * (prepared-model-runtime.build.ts:149) and so satisfies the identity check by
 * construction.
 *
 * Fails toward publishing: an owner with no snapshot yet cannot be shown to hold
 * the pinned generation, and reusing it on a guess is what produced the
 * outage. Unpinned callers are always satisfied, leaving their behaviour
 * untouched.
 */
export function preparedGenerationPinSatisfied(params: {
  existing: Pick<PreparedModelRuntimeOwner, "snapshot"> | undefined;
  pluginGeneration?: { pluginMetadataSnapshot: PluginMetadataSnapshot };
}): boolean {
  if (params.pluginGeneration === undefined) {
    return true;
  }
  return (
    params.existing?.snapshot?.metadataSnapshot === params.pluginGeneration.pluginMetadataSnapshot
  );
}

export async function acquirePreparedModelRuntimeLeaseFromOwners(
  rawInput: PreparedModelRuntimeInput,
  provenance: "run" | "ephemeral",
  context: PreparedModelRuntimeLeaseContext,
  options: {
    retainIdleRunOwner?: boolean;
    catalogMode?: PreparedModelRuntimeCatalogMode;
    pluginGeneration?: PreparedModelRuntimeOwner["pluginGeneration"];
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
  } = {},
): Promise<PreparedModelRuntimeLease> {
  let normalizedInput = normalizePreparedModelRuntimeInput({
    ...rawInput,
    preserveWorkspaceDirOnRefresh:
      rawInput.preserveWorkspaceDirOnRefresh ?? rawInput.workspaceDir !== undefined,
  });
  if (
    provenance === "run" &&
    context.getGatewayLifecycleActive() &&
    !options.pluginGeneration &&
    !context.getPendingReplacement()
  ) {
    try {
      normalizedInput = rebindInputToCommittedConfiguredOwner(context.owners, normalizedInput);
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
    }
  }
  let input = normalizedInput;
  let key = ownerKey(input);
  let owner: PreparedModelRuntimeOwner;
  let snapshot: PreparedModelRuntimeSnapshot;
  for (;;) {
    // Replacement owns publication from synchronous staling through atomic generation commit.
    // Dynamic work arriving inside that window must retry after the new owners become visible.
    const replacement = context.getPendingReplacement();
    if (replacement) {
      await replacement.promise;
      if (context.getPendingReplacement()) {
        continue;
      }
      if (provenance === "run" && !options.pluginGeneration) {
        input = rebindInputToCommittedConfiguredOwner(context.owners, input);
        key = ownerKey(input);
      }
      continue;
    }
    let existing = context.owners.get(key);
    let staleDynamicOwner =
      existing?.needsRefresh &&
      !existing.pending &&
      (existing.provenance === "run" || existing.provenance === "ephemeral");
    if (
      context.getGatewayLifecycleActive() &&
      provenance === "run" &&
      !options.pluginGeneration &&
      (!existing || staleDynamicOwner)
    ) {
      // Dynamic workspaces still inherit the committed agent/config generation. Only their
      // explicitly pinned workspace may differ from the configured owner. A stale leased owner
      // can share this key, so rebase its input before publishing a replacement generation.
      try {
        input = rebindInputToCommittedConfiguredOwner(context.owners, input);
        key = ownerKey(input);
        existing = context.owners.get(key);
        staleDynamicOwner =
          existing?.needsRefresh &&
          !existing.pending &&
          (existing.provenance === "run" || existing.provenance === "ephemeral");
      } catch (error) {
        if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
          throw error;
        }
        const canActivateConfiglessSetup =
          input.agentId !== undefined && isReservedSystemAgentId(input.agentId);
        if (hasConfiguredOwnerMatching(context.owners, input) || !canActivateConfiglessSetup) {
          throw error;
        }
        // First-run Model Setup uses the reserved system-agent identity before a configless gateway
        // has an owner to rebind. Keep ordinary agent runs fail-closed at this ownership boundary.
      }
    }
    // A pinned generation has to be honoured on BOTH branches below.
    // `prepareSnapshot()` takes no generation argument, so reusing an existing
    // owner returns whatever generation currently lives at this key. When that
    // is not the generation the run was ADMITTED against, the caller rejects the
    // lease by reference identity — run-orchestrator.ts compares
    // `snapshot.metadataSnapshot !== pluginGeneration.pluginMetadataSnapshot`
    // and throws "prepared model runtime replaced the admitted plugin
    // generation", killing the run ~10ms in with no error reaching the spawner.
    //
    // That made every sessions_spawn fail on a warm gateway: a warm gateway
    // nearly always has an owner at the key, and a boot that publishes several
    // generations leaves the pinned one no longer current. Publishing re-honours
    // the pin instead — a pinned publish threads the same PluginMetadataSnapshot
    // object through (prepared-model-runtime.build.ts:149), so the caller's
    // identity check passes by construction rather than by luck.
    //
    // Unpinned callers are unaffected: with no pin this is vacuously true and
    // the reuse path stays exactly as before.
    const pinnedGenerationSatisfied = preparedGenerationPinSatisfied({
      existing,
      ...(options.pluginGeneration ? { pluginGeneration: options.pluginGeneration } : {}),
    });
    try {
      if (existing && !staleDynamicOwner && pinnedGenerationSatisfied) {
        snapshot = await context.prepareSnapshot(input);
      } else {
        // Fresh keys publish a first generation; stale dynamic owners — and runs
        // whose pinned generation is no longer the one at this key — publish a
        // distinct replacement owner because existing leases retain their
        // immutable snapshot, so their release cannot delete the generation
        // admitted for new work at this key.
        snapshot = await publishModelRuntimeSnapshot(
          input,
          context.owners,
          context.agentBuildCompletions,
          context.getBuildTimeoutMs(),
          undefined,
          provenance,
          options.catalogMode,
          options.pluginGeneration,
          options.pluginMetadataSnapshot,
        );
      }
    } catch (error) {
      if (error instanceof PreparedModelRuntimePublicationSupersededError) {
        continue;
      }
      throw error;
    }
    const published = context.owners.get(key);
    if (
      context.getPendingReplacement() ||
      !published ||
      published.snapshot !== snapshot ||
      published.needsRefresh ||
      published.pending
    ) {
      continue;
    }
    owner = published;
    break;
  }
  if (owner.provenance !== provenance) {
    return { snapshot, release: () => {} };
  }
  if (provenance === "run" && options.retainIdleRunOwner) {
    context.retainedDirectRunOwners.retain(key, owner, context.owners);
  } else if (provenance === "run" && context.getGatewayLifecycleActive()) {
    context.retainedGatewayRunOwners.retain(key, owner, context.owners);
  }
  owner.leaseCount = (owner.leaseCount ?? 0) + 1;
  let released = false;
  return {
    snapshot,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      owner.leaseCount = Math.max(0, (owner.leaseCount ?? 1) - 1);
      // Direct runs retain one idle generation; gateways retain a bounded LRU so repeated selections
      // reuse workspace facts. Identity checks keep old releases from deleting replacements.
      if (owner.leaseCount === 0 && context.owners.get(key) === owner) {
        if (
          !context.retainedDirectRunOwners.has(key, owner) &&
          !context.retainedGatewayRunOwners.has(key, owner)
        ) {
          context.owners.delete(key);
        }
      }
    },
  };
}
