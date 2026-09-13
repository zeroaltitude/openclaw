/** Relay-transport failure accounting shared by the bridge and the relay entrypoint. */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  MAX_NATIVE_HOOK_RELAY_INVOCATIONS,
  nativeHookRelayState,
} from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  NativeHookRelayEvent,
  NativeHookRelayRegistration,
  NativeHookRelayTransportFailureCause,
} from "./native-hook-relay-types.js";

const log = createSubsystemLogger("agents/harness/native-hook-relay");

const { relays } = nativeHookRelayState;

/**
 * Consecutive relay-transport failures tolerated before the relay refuses every
 * further invocation with an explicit error.
 *
 * One failure is expected and recoverable: a stable-id replacement keeps the
 * previous locator for NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS and the
 * client retries through it, so a single lost race is normal. Two can still fall
 * inside one rotation window when it straddles two hooks. Three consecutive
 * failures with no intervening success cannot be explained by a rotation race —
 * at the default relay timeout that is a transport unusable for >=15s, during
 * which every hook has already fail-closed denied a tool call, so the child is
 * making no progress either way.
 */
const NATIVE_HOOK_RELAY_TRANSPORT_FAILURE_THRESHOLD = 3;

/** Server-side ceiling on one bridge invocation, independent of the client budget. */
export const NATIVE_HOOK_RELAY_BRIDGE_INVOCATION_DEADLINE_MS = 30_000;

export type NativeHookRelayTransportFailureState = {
  consecutive: number;
  terminal?: {
    cause: NativeHookRelayTransportFailureCause;
    consecutive: number;
    atMs: number;
  };
};

function readTransportFailureState(
  registration: ActiveNativeHookRelayRegistration,
): NativeHookRelayTransportFailureState {
  registration.relayTransportFailures ??= { consecutive: 0 };
  return registration.relayTransportFailures;
}

/** Map a transport cause onto the closed diagnostic disposition union. */
export function nativeHookRelayTransportFailureDisposition(
  cause: NativeHookRelayTransportFailureCause,
): "timed_out" | "failed" {
  return cause === "client-disconnected" || cause === "server-deadline" || cause === "relay-timeout"
    ? "timed_out"
    : "failed";
}

/**
 * Record one relay-transport failure the parent observed directly.
 *
 * The fail-closed deny a child manufactures for itself never reaches the parent,
 * so this is the only place the parent learns a child hook was attempted and
 * abandoned. Crossing the threshold latches a terminal state that makes every
 * later invocation on the relay throw, which is what turns a silent
 * normal-looking completion into an explicit error result.
 */
export function recordNativeHookRelayTransportFailure(params: {
  relayId: string;
  cause: NativeHookRelayTransportFailureCause;
  event?: NativeHookRelayEvent;
  elapsedMs?: number;
  toolName?: string;
  toolCallId?: string;
}): NativeHookRelayTransportFailureState | undefined {
  const registration = relays.get(params.relayId);
  if (!registration) {
    return undefined;
  }
  const state = readTransportFailureState(registration);
  state.consecutive += 1;
  const disposition = nativeHookRelayTransportFailureDisposition(params.cause);
  log.warn("native hook relay transport failure", {
    relayId: params.relayId,
    runId: registration.runId,
    sessionId: registration.sessionId,
    cause: params.cause,
    disposition,
    ...(params.event ? { event: params.event } : {}),
    ...(typeof params.elapsedMs === "number" ? { elapsedMs: params.elapsedMs } : {}),
    consecutiveFailures: state.consecutive,
    threshold: NATIVE_HOOK_RELAY_TRANSPORT_FAILURE_THRESHOLD,
  });
  if (params.toolCallId) {
    projectNativeHookRelayPreToolUseFailure(registration, {
      toolName: params.toolName ?? "",
      toolCallId: params.toolCallId,
      disposition,
      durationMs: params.elapsedMs ?? 0,
    });
  }
  if (state.consecutive >= NATIVE_HOOK_RELAY_TRANSPORT_FAILURE_THRESHOLD && !state.terminal) {
    state.terminal = {
      cause: params.cause,
      consecutive: state.consecutive,
      atMs: Date.now(),
    };
    log.error("native hook relay transport failed", {
      relayId: params.relayId,
      runId: registration.runId,
      sessionId: registration.sessionId,
      cause: params.cause,
      consecutiveFailures: state.consecutive,
      threshold: NATIVE_HOOK_RELAY_TRANSPORT_FAILURE_THRESHOLD,
    });
  }
  return state;
}

/** Clear the consecutive counter after a relay invocation completed end to end. */
export function resetNativeHookRelayTransportFailures(
  registration: ActiveNativeHookRelayRegistration,
): void {
  const state = registration.relayTransportFailures;
  if (!state || state.terminal || state.consecutive === 0) {
    return;
  }
  state.consecutive = 0;
}

/** Read the latched terminal transport state, if the relay has one. */
export function readNativeHookRelayTransportFailureTerminal(
  registration: ActiveNativeHookRelayRegistration,
): NativeHookRelayTransportFailureState["terminal"] {
  return registration.relayTransportFailures?.terminal;
}

/**
 * Hand one pre-tool-use failure to the run owner exactly once per tool call.
 *
 * Lives here rather than in the relay entrypoint so the bridge can project a
 * failure for an invocation that never produced a response.
 */
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
