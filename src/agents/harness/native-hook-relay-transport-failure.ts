/** Relay pre-tool-use failure projection shared with the relay entrypoint. */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { MAX_NATIVE_HOOK_RELAY_INVOCATIONS } from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  NativeHookRelayRegistration,
} from "./native-hook-relay-types.js";

const log = createSubsystemLogger("agents/harness/native-hook-relay");

export function projectNativeHookRelayPreToolUseFailure(
  registration: ActiveNativeHookRelayRegistration,
  failure: Parameters<NonNullable<NativeHookRelayRegistration["onPreToolUseFailure"]>>[0],
): void {
  const callback = registration.onPreToolUseFailure;
  if (!callback || registration.preToolUseFailureProjections.has(failure.toolCallId)) {
    return;
  }
  const record = {
    promise: Promise.resolve().then(() => callback(failure)),
    settled: false,
  };
  registration.preToolUseFailureProjections.set(failure.toolCallId, record);
  void record.promise.then(
    () => {
      record.settled = true;
    },
    (error: unknown) => {
      record.settled = true;
      if (registration.preToolUseFailureProjections.get(failure.toolCallId) === record) {
        registration.preToolUseFailureProjections.delete(failure.toolCallId);
      }
      log.debug("native pre-tool failure projection failed", {
        error,
        relayId: registration.relayId,
        toolCallId: failure.toolCallId,
      });
    },
  );
  if (registration.preToolUseFailureProjections.size > MAX_NATIVE_HOOK_RELAY_INVOCATIONS) {
    let oldestToolCallId: string | undefined;
    for (const [toolCallId, candidate] of registration.preToolUseFailureProjections) {
      oldestToolCallId ??= toolCallId;
      if (candidate.settled) {
        registration.preToolUseFailureProjections.delete(toolCallId);
        return;
      }
    }
    if (oldestToolCallId) {
      registration.preToolUseFailureProjections.delete(oldestToolCallId);
    }
  }
}
