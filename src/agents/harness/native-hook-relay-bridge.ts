import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import {
  isNativeHookRelayBridgeStaleRegistrationError,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
} from "./native-hook-relay-client.js";
import {
  getNativeHookRelayProviderAdapter,
  normalizeNativeHookToolName,
} from "./native-hook-relay-codec.js";
import { nativeHookRelayState } from "./native-hook-relay-state.js";
import {
  clearNativeHookRelayBridgeRecordsForTests,
  deleteNativeHookRelayBridgeRecordIfOwned,
  pruneNativeHookRelayBridgeRecords,
  readNativeHookRelayBridgeRecord as readNativeHookRelayBridgeRecordFromStore,
  renewOrRestoreNativeHookRelayBridgeRecord,
  writeNativeHookRelayBridgeRecord,
  type NativeHookRelayBridgeRecord,
} from "./native-hook-relay-store.js";
import { NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR } from "./native-hook-relay-transport-error.js";
import {
  NATIVE_HOOK_RELAY_BRIDGE_INVOCATION_DEADLINE_MS,
  recordNativeHookRelayTransportFailure,
} from "./native-hook-relay-transport-failure.js";
import type {
  ActiveNativeHookRelayRegistration,
  InvokeNativeHookRelayParams,
  NativeHookRelayBridgeRegistration,
  NativeHookRelayEvent,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
  NativeHookRelayTransportFailureCause,
} from "./native-hook-relay-types.js";
import {
  isJsonObject,
  isJsonValue,
  normalizePositiveInteger,
  readNativeHookRelayEvent,
  readNonEmptyString,
} from "./native-hook-relay-utils.js";

const MAX_NATIVE_HOOK_BRIDGE_BODY_BYTES = 5_000_000;
const log = createSubsystemLogger("agents/harness/native-hook-relay");

export {
  isRetryableNativeHookRelayBridgeLookupError,
  NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
} from "./native-hook-relay-client.js";

const { relays, relayBridges } = nativeHookRelayState;

type InvokeNativeHookRelay = (
  params: InvokeNativeHookRelayParams,
) => Promise<NativeHookRelayProcessResponse>;

type NativeHookRelayBridgeRequestAuth = {
  provider: NativeHookRelayProvider;
  relayId: string;
  token: string;
  registration: ActiveNativeHookRelayRegistration;
  bridge: NativeHookRelayBridgeRegistration;
  invokeRelay: InvokeNativeHookRelay;
};

export function registerNativeHookRelayBridge(
  registration: ActiveNativeHookRelayRegistration,
  stateDbPath: string,
  invokeRelay: InvokeNativeHookRelay,
): void {
  // Liveness checks stay outside the write transaction. The store rereads each
  // authoritative row before deletion so renewal or replacement wins the race.
  try {
    const pruned = pruneNativeHookRelayBridgeRecords({
      currentPid: process.pid,
      isPidDead: isPidDefinitelyDead,
      stateDbPath,
    });
    for (const row of pruned) {
      log.debug("pruned stale native hook relay bridge record", {
        relayId: row.relayId,
        stalePid: row.pid,
        currentPid: process.pid,
        reason: row.reason,
      });
    }
  } catch (error) {
    log.debug("native hook relay bridge record prune skipped", { error });
  }
  unregisterNativeHookRelayBridge(registration.relayId);
  const token = randomUUID();
  const server = createServer();
  const bridge: NativeHookRelayBridgeRegistration = {
    relayId: registration.relayId,
    stateDbPath,
    token,
    server,
  };
  server.on("request", (req, res) => {
    void handleNativeHookRelayBridgeRequest(req, res, {
      provider: registration.provider,
      relayId: registration.relayId,
      token,
      registration,
      bridge,
      invokeRelay,
    });
  });
  relayBridges.set(registration.relayId, bridge);
  server.on("error", (error) => {
    log.debug("native hook relay bridge server error", { error, relayId: registration.relayId });
  });
  server.listen(0, "127.0.0.1", () => {
    if (relayBridges.get(registration.relayId) !== bridge) {
      return;
    }
    try {
      writeNativeHookRelayBridgeRecordForRegistration(registration, bridge);
    } catch (error) {
      log.debug("failed to publish native hook relay bridge record", {
        error,
        relayId: registration.relayId,
      });
    }
  });
  server.unref();
}

function writeNativeHookRelayBridgeRecordForRegistration(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
): void {
  const record = resolveNativeHookRelayBridgeRecord(registration, bridge);
  if (!record) {
    return;
  }
  writeNativeHookRelayBridgeRecord({ record, stateDbPath: bridge.stateDbPath });
}

function resolveNativeHookRelayBridgeRecord(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
  expiresAtMs = registration.expiresAtMs,
): NativeHookRelayBridgeRecord | undefined {
  const address = bridge.server.address();
  if (!address || typeof address === "string") {
    log.debug("native hook relay bridge server address unavailable", {
      relayId: registration.relayId,
    });
    return undefined;
  }
  return {
    relayId: registration.relayId,
    pid: process.pid,
    hostname: "127.0.0.1",
    port: address.port,
    token: bridge.token,
    expiresAtMs,
  };
}

export function renewNativeHookRelayBridgeRecord(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
  expiresAtMs: number,
): "renewed" | "unavailable" | "ownership-changed" {
  const record = resolveNativeHookRelayBridgeRecord(registration, bridge, expiresAtMs);
  if (!record) {
    return "unavailable";
  }
  return renewOrRestoreNativeHookRelayBridgeRecord({
    record,
    stateDbPath: bridge.stateDbPath,
  })
    ? "renewed"
    : "ownership-changed";
}

export function unregisterNativeHookRelayBridge(
  relayId: string,
  options?: {
    deferListenerCloseMs?: number;
    expectedBridge?: NativeHookRelayBridgeRegistration;
  },
): void {
  const bridge = options?.expectedBridge ?? relayBridges.get(relayId);
  if (!bridge) {
    return;
  }
  if (relayBridges.get(relayId) === bridge) {
    relayBridges.delete(relayId);
  }
  // Stop advertising the retired endpoint before its listener can close.
  // Token-scoped removal cannot delete an already-published successor.
  try {
    deleteNativeHookRelayBridgeRecordIfOwned({ ...bridge, pid: process.pid });
  } catch (error) {
    log.debug("failed to remove native hook relay bridge record", { error, relayId });
  }
  const closeListener = () => bridge.server.close();
  const deferListenerCloseMs = normalizePositiveInteger(options?.deferListenerCloseMs, 0);
  if (deferListenerCloseMs > 0) {
    // Readers that already captured the old locator still receive a stale-owner
    // rejection. New lookups wait for the successor's listener publication.
    const timeout = setTimeout(closeListener, deferListenerCloseMs);
    timeout.unref();
    return;
  }
  closeListener();
}

/**
 * Tracks one bridge request so a client that walks away is not a non-event.
 *
 * Before this existed, a child whose socket died mid-invocation left the parent
 * awaiting a promise nobody would ever read, wrote the eventual response into a
 * closed socket, and logged nothing — so the dispatcher never learned that a
 * child hook had been attempted at all.
 */
type NativeHookRelayBridgeRequestTracker = {
  controller: AbortController;
  signal: AbortSignal;
  markResponded: () => void;
  observe: (payload: InvokeNativeHookRelayParams) => void;
  dispose: () => void;
};

function trackNativeHookRelayBridgeRequest(
  res: ServerResponse,
  auth: NativeHookRelayBridgeRequestAuth,
): NativeHookRelayBridgeRequestTracker {
  const startedAt = Date.now();
  const controller = new AbortController();
  let responded = false;
  let event: NativeHookRelayEvent | undefined;
  let toolName: string | undefined;
  let toolCallId: string | undefined;
  const fail = (cause: NativeHookRelayTransportFailureCause, message: string) => {
    if (responded || controller.signal.aborted) {
      return;
    }
    if (!isCurrentNativeHookRelayBridgeRequest(auth)) {
      // Settle the retired invocation without charging its same-ID successor.
      controller.abort(new Error(NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR));
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    log.warn(message, {
      relayId: auth.relayId,
      ...(event ? { event } : {}),
      elapsedMs,
    });
    recordNativeHookRelayTransportFailure({
      relayId: auth.relayId,
      cause,
      ...(event ? { event } : {}),
      elapsedMs,
      ...(toolName ? { toolName } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    });
    controller.abort(new Error(NATIVE_HOOK_RELAY_TRANSPORT_FAILED_ERROR));
  };
  const onResponseClose = () => {
    // `res` close also fires on a completed response, and `req` close fires as
    // soon as the request body is fully read. Only an unfinished writable side
    // means the peer went away while this invocation was still in flight.
    if (res.writableFinished) {
      return;
    }
    fail("client-disconnected", "native hook relay bridge client disconnected");
  };
  const deadline = setTimeout(() => {
    fail("server-deadline", "native hook relay bridge invocation deadline exceeded");
  }, NATIVE_HOOK_RELAY_BRIDGE_INVOCATION_DEADLINE_MS);
  deadline.unref();
  res.on("close", onResponseClose);
  return {
    controller,
    signal: controller.signal,
    markResponded: () => {
      responded = true;
    },
    observe: (payload) => {
      try {
        event = readNativeHookRelayEvent(payload.event);
      } catch {
        // An unreadable event only costs the log a field; the request still fails below.
      }
      if (!isJsonValue(payload.rawPayload)) {
        return;
      }
      try {
        const metadata = getNativeHookRelayProviderAdapter(auth.provider).normalizeMetadata(
          payload.rawPayload,
        );
        toolCallId = metadata.toolUseId;
        toolName = normalizeNativeHookToolName(metadata.toolName);
      } catch {
        // Metadata is only used to attribute the failure to a tool call.
      }
    },
    dispose: () => {
      clearTimeout(deadline);
      res.off("close", onResponseClose);
    },
  };
}

async function handleNativeHookRelayBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  auth: NativeHookRelayBridgeRequestAuth,
): Promise<void> {
  const tracker = trackNativeHookRelayBridgeRequest(res, auth);
  const respond = (statusCode: number, payload: unknown) => {
    tracker.markResponded();
    writeNativeHookRelayBridgeJson(res, statusCode, payload);
  };
  try {
    if (req.method !== "POST" || req.url !== "/invoke") {
      respond(404, { ok: false, error: "not found" });
      return;
    }
    if (req.headers.authorization !== `Bearer ${auth.token}`) {
      respond(403, { ok: false, error: "forbidden" });
      return;
    }
    if (!isCurrentNativeHookRelayBridgeRequest(auth)) {
      respond(410, {
        ok: false,
        error: NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
      });
      return;
    }
    const body = await readNativeHookRelayBridgeBody(req);
    const payload = readNativeHookRelayBridgePayload(JSON.parse(body));
    tracker.observe(payload);
    if (payload.provider !== auth.provider || payload.relayId !== auth.relayId) {
      respond(403, {
        ok: false,
        error: "native hook relay bridge target mismatch",
      });
      return;
    }
    if (!isCurrentNativeHookRelayBridgeRequest(auth)) {
      respond(410, {
        ok: false,
        error: NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
      });
      return;
    }
    const result = await auth.invokeRelay({
      ...payload,
      requireGeneration: true,
      signal: tracker.signal,
    });
    respond(200, { ok: true, result });
  } catch (error) {
    respond(isNativeHookRelayBridgeStaleRegistrationError(error) ? 410 : 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    tracker.dispose();
  }
}

function isCurrentNativeHookRelayBridgeRequest(auth: NativeHookRelayBridgeRequestAuth): boolean {
  return (
    relays.get(auth.relayId) === auth.registration && relayBridges.get(auth.relayId) === auth.bridge
  );
}

async function readNativeHookRelayBridgeBody(req: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_NATIVE_HOOK_BRIDGE_BODY_BYTES) {
      throw new Error("native hook relay bridge payload too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function readNativeHookRelayBridgePayload(value: unknown): InvokeNativeHookRelayParams {
  if (!isJsonObject(value)) {
    throw new Error("native hook relay bridge payload must be an object");
  }
  return {
    provider: value.provider,
    relayId: value.relayId,
    generation: readNonEmptyString(value.generation, "generation"),
    event: value.event,
    rawPayload: value.rawPayload,
  };
}

function writeNativeHookRelayBridgeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    // The client is already gone (or already answered); the disconnect handler
    // owns the failure accounting, so dropping this write is the whole point.
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function readNativeHookRelayBridgeRecordIfExists(
  relayId: string,
  stateDbPath?: string,
): NativeHookRelayBridgeRecord | undefined {
  try {
    return readNativeHookRelayBridgeRecordFromStore({ relayId, stateDbPath });
  } catch (error) {
    log.debug("failed to read native hook relay bridge record", { error, relayId });
  }
  return undefined;
}

export function clearNativeHookRelayBridgesForTests(): void {
  for (const relayId of relayBridges.keys()) {
    unregisterNativeHookRelayBridge(relayId);
  }
  clearNativeHookRelayBridgeRecordsForTests();
}
