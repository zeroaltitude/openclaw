import type { AgentHarnessCompletionCustody } from "openclaw/plugin-sdk/agent-harness-completion";
import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  MAX_PENDING_CHILD_ADMISSION_EVIDENCE,
  admitNativeChildModelExecution,
  consumeNativeChildModelAdmission,
  retainNativeModelSource,
  retainNativeModelExecution,
} from "./native-subagent-model-source.js";
import type {
  ChildState,
  DirectSpawnEvidence,
  KnownChild,
  NativeChildAdmissionEvidence,
  NativeSubagentMonitorRuntime,
  ParentState,
  ParentOwner,
} from "./native-subagent-monitor-types.js";
export function releaseCompletionCustody(holder: {
  completionCustody?: AgentHarnessCompletionCustody;
}) {
  holder.completionCustody?.release();
  holder.completionCustody = undefined;
}

/** Own retained assignment authority while native evidence waits for its exact parent turn. */
export class CodexNativeSubagentAdmissionCustody {
  // Notifications can precede turn/start's response. Binding selects the parent;
  // custody must remain with that evidence until it is consumed or discarded.
  private readonly pending = new Map<string, NativeChildAdmissionEvidence[]>();

  constructor(
    private readonly dependencies: {
      parentState: (id: string) => ParentState | undefined;
      knownChild: (id: string) => KnownChild | undefined;
      childState: (runId: string) => ChildState | undefined;
      isTerminalRevision: (threadId: string) => boolean;
      runtime: NativeSubagentMonitorRuntime;
    },
  ) {}

  get entries(): ReadonlyMap<string, NativeChildAdmissionEvidence[]> {
    return this.pending;
  }

  buffer(turnIdInput: string | undefined, evidence: NativeChildAdmissionEvidence): void {
    const turnId = turnIdInput?.trim();
    const requiresUnboundOwner =
      evidence.kind !== "interaction" || (!evidence.owner && !evidence.modelOwner);
    if (!turnId || (requiresUnboundOwner && !this.hasUnboundParentOwner(evidence.parentThreadId))) {
      return;
    }
    const pending = this.pending.get(turnId) ?? [];
    if (evidence.kind === "interaction" && !evidence.nativeTurnId) {
      // Interrupted continuations leave the receipt queue before their
      // interaction can arrive. Keep pairing against the observed starts.
      const nativeTurn = [
        ...(this.dependencies.knownChild(evidence.childThreadId)?.observedTurns ?? []),
      ].find(
        ([nativeTurnId, observed]) =>
          observed.awaitingInteraction &&
          ![...this.pending.values()]
            .flat()
            .some(
              (candidate) =>
                candidate.kind === "interaction" &&
                candidate.parentThreadId === evidence.parentThreadId &&
                candidate.childThreadId === evidence.childThreadId &&
                candidate.nativeTurnId === nativeTurnId,
            ),
      );
      if (nativeTurn) {
        evidence.nativeTurnId = nativeTurn[0];
      }
    }
    if (
      pending.some(
        (candidate) =>
          candidate.parentThreadId === evidence.parentThreadId &&
          candidate.kind === evidence.kind &&
          candidate.childThreadId === evidence.childThreadId &&
          candidate.agentPath === evidence.agentPath &&
          (candidate.kind === "spawn" ||
            evidence.kind === "spawn" ||
            (candidate.modelSourceTurnId === evidence.modelSourceTurnId &&
              ((candidate.nativeTurnId !== undefined &&
                candidate.nativeTurnId === evidence.nativeTurnId) ||
                (evidence.itemId !== undefined && candidate.itemId === evidence.itemId)))),
      )
    ) {
      return;
    }
    if (requiresUnboundOwner) {
      // At capacity, evict the oldest rather than refusing the newest. Refusing
      // silently discarded the only evidence that could ever claim a live child,
      // whose first pre_tool_use hook is already blocked on that claim.
      this.evictOldestPending();
    }
    try {
      if (evidence.kind === "interaction") {
        evidence.completionCustody ??= (
          evidence.owner ?? evidence.modelOwner
        )?.completionCustody?.retain();
        if (!evidence.modelSourceConsumed) {
          const owner = evidence.modelOwner ?? evidence.owner;
          if (owner?.unqualifiedModelExecution && !owner.nativeInputConfiguration) {
            evidence.modelSourceRequiresInference = evidence.modelSourceTurnId ? undefined : true;
            evidence.modelSource = retainNativeModelExecution(
              owner,
              undefined,
              evidence.childThreadId,
              evidence.completionCustody,
            );
          } else {
            evidence.modelSource = retainNativeModelSource(owner);
          }
        }
      }
    } catch (error) {
      if (evidence.kind === "interaction") {
        releaseCompletionCustody(evidence);
        consumeNativeChildModelAdmission(evidence);
      }
      throw error;
    }
    pending.push(evidence);
    this.pending.set(turnId, pending);
  }

  hasUnboundParentOwner(parentThreadId: string): boolean {
    const owners = this.dependencies.parentState(parentThreadId)?.owners.values() ?? [];
    return [...owners].some((owner) => owner.turnId === undefined);
  }

  /** Frees a slot so a new admission evidence fits, oldest turn first. */
  private evictOldestPending(): void {
    while (
      [...this.pending.values()].reduce((count, entries) => count + entries.length, 0) >=
      MAX_PENDING_CHILD_ADMISSION_EVIDENCE
    ) {
      const oldest = [...this.pending.entries()].find(([, entries]) => entries.length > 0);
      if (!oldest) {
        return;
      }
      const [oldestTurnId, entries] = oldest;
      this.replace(oldestTurnId, entries.slice(1));
    }
  }

  replace(turnId: string, remaining: NativeChildAdmissionEvidence[]): void {
    const previous = this.pending.get(turnId) ?? [];
    for (const evidence of previous) {
      if (evidence.kind === "interaction" && !remaining.includes(evidence)) {
        releaseCompletionCustody(evidence);
      }
    }
    if (remaining.length) {
      this.pending.set(turnId, remaining);
    } else {
      this.pending.delete(turnId);
    }
    for (const evidence of previous) {
      if (evidence.kind === "interaction" && !remaining.includes(evidence)) {
        consumeNativeChildModelAdmission(evidence);
      }
    }
  }

  retainOnly(keep: (evidence: NativeChildAdmissionEvidence) => boolean): void {
    for (const [turnId, pending] of this.pending) {
      this.replace(turnId, pending.filter(keep));
    }
  }

  prune(isRetired: (state: ParentState) => boolean): void {
    this.retainOnly((evidence) => {
      const known = this.dependencies.knownChild(evidence.childThreadId);
      if (known && known.parent.parentThreadId !== evidence.parentThreadId) {
        return false;
      }
      const state = this.dependencies.parentState(evidence.parentThreadId);
      if (evidence.kind === "interaction" && (evidence.owner || evidence.modelSource)) {
        return Boolean(
          (evidence.modelSource && state && !isRetired(state)) ||
          (state && evidence.owner && [...state.owners.values()].includes(evidence.owner)),
        );
      }
      return this.hasUnboundParentOwner(evidence.parentThreadId);
    });
  }

  /**
   * Provisional admission for direct-spawn evidence that owner resolution can
   * never consume. Only turn-less evidence qualifies: it is keyed by nothing, so
   * no bindTurn will ever drain it, and the child's first pre_tool_use hook is
   * already blocked on the claim it will never receive. Evidence whose turn id
   * matches no owner stays unclaimed on purpose — it is not authoritative for
   * this parent's live runs, and its own turn's owner still drains the buffer.
   */
  private claimDirectChildWithoutTurn(parentThreadId: string, childState: ChildState): void {
    if (
      childState.terminal ||
      childState.settledWithoutCompletion ||
      childState.releaseDirectChild
    ) {
      return;
    }
    if (this.dependencies.isTerminalRevision(childState.childThreadId)) {
      // Matches registerChildThread: a late spawn event must not mint direct
      // authority for a child this client has already seen terminate.
      return;
    }
    const state = this.dependencies.parentState(parentThreadId);
    // Without a turn ID, the parent must have exactly one owner. Fan-out would
    // grant unrelated runs authority over a child they did not spawn.
    if (state?.owners.size !== 1) {
      return;
    }
    const owner = state.owners.values().next().value;
    if (owner?.claimDirectChild) {
      childState.directOwner = owner;
      childState.releaseDirectChild = owner.claimDirectChild(childState.childThreadId);
    }
  }

  registerDirectSpawnChild(
    turnIdInput: string | undefined,
    evidence: DirectSpawnEvidence,
    owner: ParentOwner | undefined,
    registerChild: (
      options: Pick<DirectSpawnEvidence, "agentPath" | "nativeParentThreadId"> & {
        directOwner?: ParentOwner;
      },
    ) => ChildState | undefined,
  ): ChildState | undefined {
    const childState = registerChild({
      ...(evidence.agentPath === undefined ? {} : { agentPath: evidence.agentPath }),
      nativeParentThreadId: evidence.nativeParentThreadId,
      ...(owner ? { directOwner: owner } : {}),
    });
    if (!owner) {
      // The child's first pre_tool_use hook blocks on this claim, so evidence
      // that owner resolution can never consume must still admit the child.
      if (childState && !turnIdInput?.trim()) {
        this.claimDirectChildWithoutTurn(evidence.parentThreadId, childState);
      }
      this.buffer(turnIdInput, { ...evidence, kind: "spawn" });
    } else if (childState) {
      admitNativeChildModelExecution(
        childState,
        owner,
        this.dependencies.knownChild(childState.childThreadId),
      );
    }
    return childState;
  }

  bindEventSink(child: ChildState): void {
    const parent = this.dependencies.parentState(child.parentThreadId);
    if (!child.completionCustody || !parent?.completionScope || child.emitEvent) {
      return;
    }
    child.emitEvent = this.dependencies.runtime.createAgentHarnessCompletionEventSink({
      scope: parent.completionScope,
      completionCustody: child.completionCustody,
      runId: child.runId,
      isSourceCurrent: () =>
        this.dependencies.childState(child.runId) === child &&
        this.dependencies.parentState(child.parentThreadId) === parent,
    });
  }

  emitEvent(
    child: ChildState,
    event: Pick<Parameters<typeof emitAgentEvent>[0], "stream" | "data">,
  ): void {
    if (this.dependencies.childState(child.runId) !== child) {
      return;
    }
    if (child.emitEvent) {
      child.emitEvent(event);
      return;
    }
    if (child.completionCustody) {
      throw new Error("Native event assignment has not been bound");
    }
    emitAgentEvent({ ...event, runId: child.runId, agentId: child.agentId });
  }
}
