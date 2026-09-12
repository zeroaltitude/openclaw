/** Native harness hook event relay and public Plugin SDK facade. */
import { randomUUID } from "node:crypto";
import {
  MAX_TIMER_TIMEOUT_MS,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { retainBeforeToolCallForNativeHookRelay } from "./host-private-capabilities.js";
import {
  clearNativeHookRelayBridgesForTests,
  NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
  readNativeHookRelayBridgeRecordIfExists,
  registerNativeHookRelayBridge,
  retainNativeHookRelayOperation,
  renewNativeHookRelayBridgeRecord,
  unregisterNativeHookRelayBridge,
  isRetryableNativeHookRelayBridgeLookupError,
} from "./native-hook-relay-bridge.js";
import {
  awaitBoundedNativeHookRelayChildAdmission,
  resolveNativeHookRelayChildAdmissionTimeoutMs,
} from "./native-hook-relay-child-admission.js";
import {
  getNativeHookRelayProviderAdapter,
  normalizeNativeHookInvocation,
  normalizeNativeHookToolName,
  readNativeHookRelayApprovalMode,
} from "./native-hook-relay-codec.js";
import { processNativeHookRelayInvocation } from "./native-hook-relay-events.js";
import {
  clearNativeHookRelayPermissionsForTests,
  formatPermissionApprovalDescriptionForTests,
  permissionRequestContentFingerprintForTests,
  permissionRequestToolInputKeyFingerprintForTests,
  pruneNativeHookRelayPermissionAllowAlways,
  removeNativeHookRelayPermissionState,
  removeNativeHookRelayPreToolUseApprovals,
  setNativeHookRelayDeferredToolApprovalRequesterForTests,
  setNativeHookRelayPermissionApprovalRequesterForTests,
} from "./native-hook-relay-permissions.js";
import { buildNativeHookRelayCommandPlan } from "./native-hook-relay-plan.js";
import {
  recordNativeHookRelayInvocation,
  removeNativeHookRelayInvocations,
  canAcceptNativeHookRelayGenerationMismatch,
  nativeHookRelayState,
} from "./native-hook-relay-state.js";
import { NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR } from "./native-hook-relay-transport-error.js";
import {
  nativeHookRelayTransportFailureDisposition,
  projectNativeHookRelayPreToolUseFailure,
  readNativeHookRelayTransportFailureTerminal,
  resetNativeHookRelayTransportFailures,
} from "./native-hook-relay-transport-failure.js";
import type {
  ActiveNativeHookRelayRegistration,
  ActiveNativeHookRelayRegistrationHandle,
  InvokeNativeHookRelayParams,
  NativeHookRelayEvent,
  NativeHookRelayInvocation,
  NativeHookRelayProcessResponse,
  NativeHookRelayRegistration,
  OwnedNativeHookRelayRegistrationHandle,
  RegisterNativeHookRelayParams,
} from "./native-hook-relay-types.js";
import { NATIVE_HOOK_RELAY_EVENTS } from "./native-hook-relay-types.js";
import {
  isJsonValue,
  normalizePositiveInteger,
  readNativeHookRelayEvent,
  readNativeHookRelayProvider,
  readNonEmptyString,
} from "./native-hook-relay-utils.js";
import {
  assertNativeHookRelayForegroundCurrent,
  drainNativeHookRelayWork,
  prepareNativeHookRelayMcpPolicy,
} from "./native-hook-relay-work.js";
export { buildNativeHookRelayCommand } from "./native-hook-relay-command.js";
export { resolveNativeHookRelayDeferredToolApproval } from "./native-hook-relay-permissions.js";
export type {
  NativeHookRelayEvent,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
  NativeHookRelayRegistrationHandle,
} from "./native-hook-relay-types.js";

const DEFAULT_RELAY_TTL_MS = 30 * 60 * 1000;
const log = createSubsystemLogger("agents/harness/native-hook-relay");

const { relays, relayBridges, invocations } = nativeHookRelayState;
type RelayLifetime = {
  foregroundOpen: boolean;
  foregroundToken: symbol;
  childAdmissionTimeoutMs: number;
  policyReady: Promise<void>;
  retained?: ReturnType<typeof retainBeforeToolCallForNativeHookRelay>;
  retention?: NativeHookRelayRetention;
  removeAbortListener?: () => void;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

const RELAY_LIFETIME = "__openclawNativeHookRelayLifetimeV1";

/** Private bundled-runtime callbacks for retained direct-child hook policy. */
export type NativeHookRelayRetention = Readonly<{
  readClaim: (rawPayload: unknown) => string | undefined;
  shouldRetainAfterForegroundClose: () => boolean;
  allowPreToolUse: (claim: string) => boolean;
  awaitForegroundAdmission?: (claim: string) => Promise<(() => boolean) | undefined>;
  onDispose: () => void;
}>;

type OwnedNativeHookRelayParams = RegisterNativeHookRelayParams & {
  retention?: NativeHookRelayRetention;
};

function readRelayLifetime(
  registration: ActiveNativeHookRelayRegistration,
): RelayLifetime | undefined {
  // SAFETY: this private symbol-keyed expando is installed only by setRelayLifetime below.
  return (registration as ActiveNativeHookRelayRegistration & { [RELAY_LIFETIME]?: RelayLifetime })[
    RELAY_LIFETIME
  ];
}

function setRelayLifetime(
  registration: ActiveNativeHookRelayRegistration,
  lifetime: RelayLifetime,
): void {
  Object.defineProperty(registration, RELAY_LIFETIME, {
    configurable: true,
    value: lifetime,
  });
}

function scheduleNativeHookRelayExpiry(
  relayId: string,
  registration: ActiveNativeHookRelayRegistration,
): void {
  const lifetime = readRelayLifetime(registration);
  if (!lifetime) {
    return;
  }
  if (lifetime.expiryTimer) {
    clearTimeout(lifetime.expiryTimer);
  }
  const rearm = () => {
    if (relays.get(relayId) !== registration) {
      return;
    }
    const remainingMs = registration.expiresAtMs - Date.now();
    if (remainingMs < 0) {
      unregisterNativeHookRelay(relayId, registration);
      return;
    }
    lifetime.expiryTimer = setTimeout(rearm, Math.min(remainingMs + 1, MAX_TIMER_TIMEOUT_MS));
    lifetime.expiryTimer.unref();
  };
  rearm();
}

function resolveNativeHookRelayExpiresAtMs(ttlMs: number | undefined): number | undefined {
  return resolveExpiresAtMsFromDurationMs(normalizePositiveInteger(ttlMs, DEFAULT_RELAY_TTL_MS));
}

export function registerNativeHookRelay(
  params: RegisterNativeHookRelayParams,
): ActiveNativeHookRelayRegistrationHandle {
  return registerNativeHookRelayInternal(params, undefined);
}

/** Private-local bundled runtime entrypoint; not exported through the public SDK. */
export function registerOwnedNativeHookRelay(
  params: OwnedNativeHookRelayParams,
): OwnedNativeHookRelayRegistrationHandle {
  const { retention, ...registrationParams } = params;
  return registerNativeHookRelayInternal(registrationParams, retention);
}

function registerNativeHookRelayInternal(
  params: RegisterNativeHookRelayParams,
  retention: NativeHookRelayRetention | undefined,
): OwnedNativeHookRelayRegistrationHandle {
  pruneExpiredNativeHookRelays();
  pruneNativeHookRelayPermissionAllowAlways();
  const relayId = normalizeRelayKey(params.relayId, "id") ?? randomUUID();
  const generation = normalizeRelayKey(params.generation, "generation") ?? randomUUID();
  const generationMismatchGraceMs = normalizePositiveInteger(params.generationMismatchGraceMs, 0);
  const now = Date.now();
  const expiresAtMs = resolveNativeHookRelayExpiresAtMs(params.ttlMs);
  if (expiresAtMs === undefined) {
    throw new Error("Native hook relay expiry is outside the supported Date range");
  }
  const allowedEvents = normalizeAllowedEvents(params.allowedEvents);
  const stateDbPath = resolveOpenClawStateSqlitePath();
  let partialRegistration: ActiveNativeHookRelayRegistration | undefined;
  const policy = prepareNativeHookRelayMcpPolicy(
    params,
    stateDbPath,
    () => partialRegistration !== undefined && relays.get(relayId) === partialRegistration,
  );
  const deliverReplacedRegistrationUnregister = unregisterNativeHookRelay(relayId, undefined, {
    deferListenerCloseMs: NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
    deferOnUnregister: true,
  });
  try {
    const retained =
      params.runBeforeToolCall && retention
        ? retainBeforeToolCallForNativeHookRelay(params.runBeforeToolCall)
        : undefined;
    let deferMcpToolApprovals: boolean | undefined;
    const registration = {
      relayId,
      provider: params.provider,
      generation,
      ...(generationMismatchGraceMs > 0
        ? { generationMismatchGraceExpiresAtMs: now + generationMismatchGraceMs }
        : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionId: params.sessionId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.config ? { config: params.config } : {}),
      get deferMcpToolApprovals() {
        return deferMcpToolApprovals;
      },
      runId: params.runId,
      ...(params.channelId ? { channelId: params.channelId } : {}),
      ...(params.requester ? { requester: params.requester } : {}),
      ...(params.approvalContext ? { approvalContext: params.approvalContext } : {}),
      allowedEvents,
      preToolUseLoopDetection: params.preToolUseLoopDetection !== false,
      expiresAtMs,
      preToolUseFailureProjections: new Map(),
      relayTransportFailures: { consecutive: 0 },
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.runBeforeToolCall ? { runBeforeToolCall: params.runBeforeToolCall } : {}),
      ...(params.assertActive ? { assertActive: params.assertActive } : {}),
      ...(params.onPreToolUseFailure ? { onPreToolUseFailure: params.onPreToolUseFailure } : {}),
      // SAFETY: the literal supplies the complete mutable internal registration contract.
    } as ActiveNativeHookRelayRegistration;
    partialRegistration = registration;
    relays.set(relayId, registration);
    const policyReady = policy.then((prepared) => {
      deferMcpToolApprovals = prepared;
    });
    retainNativeHookRelayOperation(relayId, policyReady);
    setRelayLifetime(registration, {
      foregroundOpen: true,
      foregroundToken: Symbol("native-hook-relay-foreground"),
      childAdmissionTimeoutMs: resolveNativeHookRelayChildAdmissionTimeoutMs(
        params.command?.timeoutMs,
      ),
      policyReady,
      ...(retained ? { retained } : {}),
      ...(retention ? { retention } : {}),
    });
    if (params.signal) {
      const abort = () => unregisterNativeHookRelay(relayId, registration);
      params.signal.addEventListener("abort", abort, { once: true });
      readRelayLifetime(registration)!.removeAbortListener = () =>
        params.signal?.removeEventListener("abort", abort);
      if (params.signal.aborted) {
        unregisterNativeHookRelay(relayId, registration);
        throw new Error("native hook relay registration aborted");
      }
    }
    const bridge = registerNativeHookRelayBridge(registration, stateDbPath, invokeNativeHookRelay);
    scheduleNativeHookRelayExpiry(relayId, registration);
    let pendingRenewal = Promise.resolve();
    const ready = Promise.all([bridge.ready, policyReady]).then(() => undefined);
    // Component owners report failure even when a public synchronous caller never awaits readiness.
    void ready.catch(() => undefined);
    const handle: OwnedNativeHookRelayRegistrationHandle = {
      ...registration,
      ...buildNativeHookRelayCommandPlan({ ...params, relayId, generation }),
      get deferMcpToolApprovals() {
        return deferMcpToolApprovals;
      },
      ready,
      prepareInvocation: async () => {
        const lifetime = readRelayLifetime(registration);
        if (!lifetime) {
          throw new Error("native hook relay registration is inactive");
        }
        const foregroundToken = lifetime.foregroundToken;
        assertNativeHookRelayForegroundCurrent(registration, lifetime, foregroundToken);
        await policyReady;
        // Only direct transport failure may use the existing Gateway route.
        await bridge.ready.catch(() => undefined);
        assertNativeHookRelayForegroundCurrent(registration, lifetime, foregroundToken);
      },
      drain: () =>
        drainNativeHookRelayWork({ policyReady, bridge, readRenewal: () => pendingRenewal }),
      renew: (ttlMs) => {
        const current = relays.get(relayId);
        if (current !== registration) {
          return;
        }
        const renewedExpiresAtMs = resolveNativeHookRelayExpiresAtMs(ttlMs);
        if (renewedExpiresAtMs === undefined) {
          return;
        }
        pendingRenewal = pendingRenewal.then(async () => {
          if (relays.get(relayId) !== current) {
            return;
          }
          if (bridge.server.listening) {
            try {
              const renewal = await renewNativeHookRelayBridgeRecord(
                current,
                bridge,
                renewedExpiresAtMs,
              );
              if (renewal === "unavailable") {
                return;
              }
              if (renewal === "ownership-changed") {
                log.debug("native hook relay bridge record ownership changed", { relayId });
                unregisterNativeHookRelay(relayId, current);
                return;
              }
            } catch (error) {
              log.debug("failed to renew native hook relay bridge record", { error, relayId });
              return;
            }
          }
          if (relays.get(relayId) !== current) {
            return;
          }
          current.expiresAtMs = renewedExpiresAtMs;
          handle.expiresAtMs = renewedExpiresAtMs;
          scheduleNativeHookRelayExpiry(relayId, current);
        });
      },
      unregister: () => deactivateNativeHookRelayForeground(relayId, registration),
    };
    return handle;
  } catch (error) {
    if (partialRegistration) {
      unregisterNativeHookRelay(relayId, partialRegistration);
    }
    throw error;
  } finally {
    // The successor is authoritative before the old callback runs. A reentrant
    // callback can therefore replace this registration normally instead of
    // being overwritten by the outer replacement path. Finally also preserves
    // the old callback if successor setup aborts partway through.
    deliverReplacedRegistrationUnregister?.();
  }
}

function unregisterNativeHookRelay(
  relayId: string,
  expectedRegistration?: ActiveNativeHookRelayRegistration,
  options?: { deferListenerCloseMs?: number; deferOnUnregister?: boolean },
): (() => void) | undefined {
  if (expectedRegistration && relays.get(relayId) !== expectedRegistration) {
    return undefined;
  }
  const registration = expectedRegistration ?? relays.get(relayId);
  if (!registration) {
    return undefined;
  }
  const lifetime = readRelayLifetime(registration);
  const bridge = relayBridges.get(relayId);
  // Detach first: owner cleanup may register a same-id successor, which must
  // never be removed by this registration's later resource cleanup.
  if (relays.get(relayId) === registration) {
    relays.delete(relayId);
  }
  if (lifetime?.expiryTimer) {
    clearTimeout(lifetime.expiryTimer);
  }
  lifetime?.removeAbortListener?.();
  lifetime?.retained?.release();
  // SAFETY: this deletes the same private expando installed by setRelayLifetime.
  delete (registration as ActiveNativeHookRelayRegistration & { [RELAY_LIFETIME]?: RelayLifetime })[
    RELAY_LIFETIME
  ];
  void unregisterNativeHookRelayBridge(relayId, {
    ...options,
    ...(bridge ? { expectedBridge: bridge } : {}),
  });
  removeNativeHookRelayInvocations(relayId);
  removeNativeHookRelayPreToolUseApprovals(relayId);
  removeNativeHookRelayPermissionState(relayId);
  const deliverOnUnregister = () => {
    try {
      lifetime?.retention?.onDispose();
    } catch (error) {
      try {
        log.warn("native hook relay unregister callback failed", { error, relayId });
      } catch {
        // Teardown has already detached every identity-bound resource. Logging
        // must not turn an observer callback failure into a cleanup failure.
      }
    }
  };
  if (options?.deferOnUnregister) {
    return deliverOnUnregister;
  }
  deliverOnUnregister();
  return undefined;
}

function deactivateNativeHookRelayForeground(
  relayId: string,
  registration: ActiveNativeHookRelayRegistration,
): void {
  if (relays.get(relayId) !== registration) {
    return;
  }
  const lifetime = readRelayLifetime(registration);
  if (!lifetime) {
    return;
  }
  lifetime.foregroundOpen = false;
  let shouldRetain = false;
  if (lifetime.retained && lifetime.retention) {
    try {
      shouldRetain = lifetime.retention.shouldRetainAfterForegroundClose();
    } catch (error) {
      try {
        log.warn("native hook relay retention predicate failed", { error, relayId });
      } catch {
        // A logging failure cannot make a throwing retention predicate retain authority.
      }
    }
  }
  if (shouldRetain) {
    return;
  }
  unregisterNativeHookRelay(relayId, registration);
}

async function resolveNativeHookRelayInvocationBinding(
  registration: ActiveNativeHookRelayRegistration,
  event: NativeHookRelayEvent,
  rawPayload: unknown,
): Promise<NativeHookRelayRegistration> {
  const lifetime = readRelayLifetime(registration);
  if (!lifetime) {
    throw new Error("native hook relay registration is inactive");
  }
  // Gateway fallback shares policy readiness without depending on HTTP locator publication.
  await lifetime.policyReady;
  if (relays.get(registration.relayId) !== registration || Date.now() > registration.expiresAtMs) {
    throw new Error("native hook relay registration is inactive");
  }
  const claim = lifetime.retention?.readClaim(rawPayload);
  if (claim && event === "pre_tool_use" && lifetime.retained && lifetime.retention) {
    const retained = lifetime.retained;
    const retention = lifetime.retention;
    let assertAdmission: (() => boolean) | undefined;
    const assertRetainedAuthority = () => {
      if (
        relays.get(registration.relayId) !== registration ||
        Date.now() > registration.expiresAtMs
      ) {
        throw new Error("native hook relay registration is inactive");
      }
      registration.signal?.throwIfAborted();
      retained.assertActive();
      if (assertAdmission && !assertAdmission()) {
        throw new Error("native hook relay retained invocation not allowed");
      }
      if (!retention.allowPreToolUse(claim)) {
        throw new Error("native hook relay retained invocation not allowed");
      }
    };
    if (lifetime.foregroundOpen && retention.awaitForegroundAdmission) {
      const admissionStartedAtMs = Date.now();
      try {
        assertAdmission = await awaitBoundedNativeHookRelayChildAdmission(
          retention.awaitForegroundAdmission(claim),
          lifetime.childAdmissionTimeoutMs,
        );
      } catch (error) {
        log.debug("native hook relay child admission failed", {
          relayId: registration.relayId,
          childThreadId: claim,
          admissionWaitMs: Date.now() - admissionStartedAtMs,
          timeoutMs: lifetime.childAdmissionTimeoutMs,
          error,
        });
        throw error;
      }
      log.debug("native hook relay child admission settled", {
        relayId: registration.relayId,
        childThreadId: claim,
        admissionWaitMs: Date.now() - admissionStartedAtMs,
        outcome: assertAdmission ? "admitted" : "not-admitted",
      });
      if (!assertAdmission) {
        throw new Error("native hook relay retained invocation not allowed");
      }
      assertRetainedAuthority();
    } else if (!retention.allowPreToolUse(claim)) {
      throw new Error("native hook relay retained invocation not allowed");
    }
    return {
      ...registration,
      assertActive: assertRetainedAuthority,
      runBeforeToolCall: retained.runBeforeToolCall,
    };
  }
  if (!lifetime.foregroundOpen) {
    throw new Error("native hook relay foreground invocation not allowed");
  }
  const foregroundToken = lifetime.foregroundToken;
  const assertActive = () =>
    assertNativeHookRelayForegroundCurrent(registration, lifetime, foregroundToken);
  return { ...registration, assertActive };
}

function normalizeRelayKey(
  value: string | undefined,
  kind: "id" | "generation",
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(trimmed)) {
    throw new Error(`native hook relay ${kind} must be non-empty, compact, and URL-safe`);
  }
  return trimmed;
}

/**
 * Reject as soon as the caller can no longer receive the response.
 *
 * The underlying work may still settle later; the point is that the handler
 * awaiting it does not stay pinned to a client that has gone away.
 */
async function withNativeHookRelayInvocationAbort<T>(
  signal: AbortSignal | undefined,
  work: Promise<T>,
): Promise<T> {
  if (!signal) {
    return await work;
  }
  if (signal.aborted) {
    void work.catch(() => {});
    throw new Error(NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR);
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      void work.catch(() => {});
      reject(new Error(NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function invokeNativeHookRelay(
  params: InvokeNativeHookRelayParams,
): Promise<NativeHookRelayProcessResponse> {
  const provider = readNativeHookRelayProvider(params.provider);
  const relayId = readNonEmptyString(params.relayId, "relayId");
  const event = readNativeHookRelayEvent(params.event);
  const registration = relays.get(relayId);
  if (!registration) {
    pruneExpiredNativeHookRelays();
    throw new Error("native hook relay not found");
  }
  const terminal = readNativeHookRelayTransportFailureTerminal(registration);
  if (terminal) {
    // The relay's transport is dead, not merely slow. Refuse loudly so the child
    // surfaces a hook execution error instead of another benign fail-closed deny.
    throw new Error(NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR);
  }
  if (Date.now() > registration.expiresAtMs) {
    unregisterNativeHookRelay(relayId, registration);
    throw new Error("native hook relay expired");
  }
  if (registration.provider !== provider) {
    throw new Error("native hook relay provider mismatch");
  }
  if (params.requireGeneration) {
    const generation = readNonEmptyString(params.generation, "generation");
    if (generation !== registration.generation) {
      if (!canAcceptNativeHookRelayGenerationMismatch(registration, generation)) {
        throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
      }
      log.debug("native hook relay accepted bootstrap generation mismatch", {
        relayId,
        event,
        runId: registration.runId,
      });
    }
  }
  if (!registration.allowedEvents.includes(event)) {
    throw new Error("native hook relay event not allowed");
  }
  if (!isJsonValue(params.rawPayload)) {
    throw new Error("native hook relay payload must be JSON-compatible");
  }

  const normalized = normalizeNativeHookInvocation({
    registration,
    event,
    rawPayload: params.rawPayload,
  });
  const startedAt = Date.now();
  const shouldProjectFailure =
    Boolean(normalized.toolUseId) &&
    readNativeHookRelayApprovalMode(normalized.rawPayload) !== "report";
  const projectFailure = (
    disposition: NonNullable<NativeHookRelayProcessResponse["failureDisposition"]>,
  ) => {
    if (!shouldProjectFailure || !normalized.toolUseId) {
      return;
    }
    projectNativeHookRelayPreToolUseFailure(registration, {
      toolName: normalizeNativeHookToolName(normalized.toolName),
      toolCallId: normalized.toolUseId,
      disposition,
      durationMs: Date.now() - startedAt,
    });
  };
  try {
    const effectiveRegistration = await withNativeHookRelayInvocationAbort(
      params.signal,
      resolveNativeHookRelayInvocationBinding(registration, event, params.rawPayload),
    );
    if (event === "pre_tool_use" || event === "permission_request") {
      effectiveRegistration.assertActive?.();
    }
    recordNativeHookRelayInvocation(normalized);
    const response = await withNativeHookRelayInvocationAbort(
      params.signal,
      processNativeHookRelayInvocation({
        registration: effectiveRegistration,
        invocation: normalized,
        adapter: getNativeHookRelayProviderAdapter(provider),
      }),
    );
    // Policy and approval callbacks may yield while their admitted run closes.
    // Never let a late allow cross back into the native runtime.
    if (event === "pre_tool_use" || event === "permission_request") {
      effectiveRegistration.assertActive?.();
    }
    if (response.failureDisposition) {
      projectFailure(response.failureDisposition);
    }
    resetNativeHookRelayTransportFailures(registration);
    return response;
  } catch (error) {
    // A caller that abandoned this invocation is a transport failure the parent
    // observed directly, and the only record that a child hook was attempted.
    if (params.signal?.aborted) {
      projectFailure(nativeHookRelayTransportFailureDisposition("client-disconnected"));
    }
    throw error;
  }
}

export function hasNativeHookRelayInvocation(params: {
  relayId: string;
  event: NativeHookRelayEvent;
  toolUseId?: string;
}): boolean {
  const toolUseId = params.toolUseId?.trim();
  if (!toolUseId) {
    return false;
  }
  return invocations.some(
    (invocation) =>
      invocation.relayId === params.relayId &&
      invocation.event === params.event &&
      invocation.toolUseId === toolUseId,
  );
}

function pruneExpiredNativeHookRelays(now = Date.now()): void {
  for (const [relayId, registration] of relays) {
    if (now > registration.expiresAtMs) {
      unregisterNativeHookRelay(relayId, registration);
    }
  }
}

function normalizeAllowedEvents(
  events: readonly NativeHookRelayEvent[] | undefined,
): readonly NativeHookRelayEvent[] {
  return events?.length ? [...new Set(events)] : NATIVE_HOOK_RELAY_EVENTS;
}

export const testing = {
  async clearNativeHookRelaysForTests(): Promise<void> {
    for (const [relayId, registration] of relays) {
      unregisterNativeHookRelay(relayId, registration);
    }
    await clearNativeHookRelayBridgesForTests();
    invocations.length = 0;
    clearNativeHookRelayPermissionsForTests();
  },
  getNativeHookRelayInvocationsForTests(): NativeHookRelayInvocation[] {
    return [...invocations];
  },
  getNativeHookRelayRegistrationForTests(relayId: string): NativeHookRelayRegistration | undefined {
    return relays.get(relayId);
  },
  getNativeHookRelayBridgeDirForTests(): string {
    throw new Error("native hook relay bridge files were retired");
  },
  getNativeHookRelayBridgeRegistryPathForTests(relayId: string): string {
    void relayId;
    throw new Error("native hook relay bridge files were retired");
  },
  async getNativeHookRelayBridgeRecordForTests(
    relayId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const record = await readNativeHookRelayBridgeRecordIfExists(relayId);
    return record ? { ...record } : undefined;
  },
  isNativeHookRelayBridgeLookupRetryableForTests(error: unknown, elapsedMs = 0): boolean {
    return isRetryableNativeHookRelayBridgeLookupError({ error, elapsedMs });
  },
  formatPermissionApprovalDescriptionForTests,
  permissionRequestContentFingerprintForTests,
  permissionRequestToolInputKeyFingerprintForTests,
  setNativeHookRelayDeferredToolApprovalRequesterForTests,
  setNativeHookRelayPermissionApprovalRequesterForTests,
} as const;
