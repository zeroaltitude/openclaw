import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../../sessions/input-provenance.js";
import { SourceOwnerChangedError } from "./subagent-announce-delivery-retry.js";
import { dispatchSubagentAnnounceAgent } from "./subagent-announce-delivery.runtime.js";
import type { SubagentCompletionToolHandoffRegistration } from "./subagent-announce-handoff.js";

export async function runAnnounceAgentCall(params: {
  agentParams: Record<string, unknown>;
  delegatedToolPolicyHandoff?: SubagentCompletionToolHandoffRegistration;
  expectFinal?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  isExecutionAllowed: () => boolean;
  onWorkLaneAdmitted: () => void;
  resolveGatewayContext?: import("../../../gateway/server-methods/types.js").GatewayContextResolver;
}): Promise<unknown> {
  const deadline = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, deadline.signal])
    : deadline.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let executionStarted = false;
  const armDeadline = () => {
    clearTimeout(timer);
    if (params.timeoutMs !== undefined) {
      timer = setTimeout(
        () => deadline.abort(new Error("gateway request timeout for agent")),
        params.timeoutMs,
      );
      timer.unref?.();
    }
  };
  armDeadline();
  try {
    return await dispatchSubagentAnnounceAgent(params.agentParams, {
      cancelOnDeadline: true,
      expectFinal: params.expectFinal,
      forceSyntheticClient: shouldPreserveUserFacingSessionStateForInputProvenance(
        params.agentParams.inputProvenance,
      ),
      operatorRoleActor: { kind: "system" },
      delegatedToolPolicyHandoff: params.delegatedToolPolicyHandoff,
      signal,
      timeoutMs: params.timeoutMs,
      // Busy-parent admission must not spend the execution budget or retry quota.
      onAccepted: () => {
        if (!executionStarted) {
          clearTimeout(timer);
        }
      },
      onExecutionStarted: () => {
        signal.throwIfAborted();
        if (!params.isExecutionAllowed()) {
          throw new SourceOwnerChangedError();
        }
        executionStarted = true;
        armDeadline();
      },
      onWorkLaneAdmitted: params.onWorkLaneAdmitted,
      resolveGatewayContext: params.resolveGatewayContext,
    });
  } finally {
    clearTimeout(timer);
  }
}
