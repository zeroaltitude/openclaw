import type {
  NativeHookRelayInvocation,
  NativeHookRelaySharedState,
  NativeHookRelayRegistration,
} from "./native-hook-relay-types.js";
import { snapshotNativeHookRelayPayload } from "./native-hook-relay-utils.js";

const NATIVE_HOOK_RELAY_STATE_SYMBOL = Symbol.for("openclaw.nativeHookRelay.state");
export const MAX_NATIVE_HOOK_RELAY_INVOCATIONS = 200;

function getNativeHookRelaySharedState(): NativeHookRelaySharedState {
  const globalRecord = globalThis as typeof globalThis & {
    [key: symbol]: NativeHookRelaySharedState | undefined;
  };
  globalRecord[NATIVE_HOOK_RELAY_STATE_SYMBOL] ??= {
    relays: new Map(),
    relayBridges: new Map(),
    pendingOperations: new Set(),
    invocations: [],
    pendingPermissionApprovals: new Map(),
    pendingPreToolUseApprovals: new Map(),
    permissionApprovalWindows: new Map(),
    permissionAllowAlwaysApprovals: new Map(),
  };
  return globalRecord[NATIVE_HOOK_RELAY_STATE_SYMBOL];
}

export const nativeHookRelayState = getNativeHookRelaySharedState();

export function recordNativeHookRelayInvocation(invocation: NativeHookRelayInvocation): void {
  nativeHookRelayState.invocations.push({
    ...invocation,
    rawPayload: snapshotNativeHookRelayPayload(invocation.rawPayload),
  });
  if (nativeHookRelayState.invocations.length > MAX_NATIVE_HOOK_RELAY_INVOCATIONS) {
    nativeHookRelayState.invocations.splice(
      0,
      nativeHookRelayState.invocations.length - MAX_NATIVE_HOOK_RELAY_INVOCATIONS,
    );
  }
}

export function removeNativeHookRelayInvocations(relayId: string): void {
  for (let index = nativeHookRelayState.invocations.length - 1; index >= 0; index -= 1) {
    if (nativeHookRelayState.invocations[index]?.relayId === relayId) {
      nativeHookRelayState.invocations.splice(index, 1);
    }
  }
}

export function canAcceptNativeHookRelayGenerationMismatch(
  registration: NativeHookRelayRegistration,
  generation: string,
): boolean {
  const expiresAtMs = registration.generationMismatchGraceExpiresAtMs;
  if (typeof expiresAtMs !== "number" || Date.now() > expiresAtMs) {
    return false;
  }
  if (registration.generationMismatchGraceAcceptedGeneration) {
    return registration.generationMismatchGraceAcceptedGeneration === generation;
  }
  registration.generationMismatchGraceAcceptedGeneration = generation;
  return true;
}
