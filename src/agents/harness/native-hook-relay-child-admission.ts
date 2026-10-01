/**
 * Relay-side bound on native child hook admission.
 *
 * A child thread's pre_tool_use hook is admitted by its parent's relay
 * registration, and the admission only settles when the parent's subagent
 * monitor separately observes the spawn and claims the child. Without a bound
 * here, the child's own CLI deadline is the only clock: losing that race spends
 * the child's whole budget and surfaces as an ordinary fail-closed policy deny.
 */
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { DEFAULT_RELAY_TIMEOUT_MS } from "./native-hook-relay-constants.js";
import { normalizePositiveInteger } from "./native-hook-relay-utils.js";

/**
 * Fraction of the relay's own command budget allowed for child admission. The
 * child abandons the request at its full budget, so the relay must fail first
 * for the failure to be attributable to admission rather than to transport.
 */
const CHILD_ADMISSION_TIMEOUT_RATIO = 0.6;

/**
 * Distinguishes a lost admission race from a generic retained-policy refusal.
 * Module-private on purpose: its only consumers assert the message text, and an
 * export with no production consumer fails the unused-export gate.
 */
const CHILD_ADMISSION_TIMEOUT_ERROR = "native hook relay child admission timed out";

/** Bounds child admission strictly below the relay's own command budget. */
export function resolveNativeHookRelayChildAdmissionTimeoutMs(
  commandTimeoutMs: number | undefined,
): number {
  const budgetMs = normalizePositiveInteger(commandTimeoutMs, DEFAULT_RELAY_TIMEOUT_MS);
  return Math.max(1, Math.floor(budgetMs * CHILD_ADMISSION_TIMEOUT_RATIO));
}

/** Releases the retention owner's wait once this attempt can no longer consume it. */
const CHILD_ADMISSION_RELEASED_ERROR = "native hook relay child admission attempt released";

/**
 * Races child admission against the relay-side bound, on a per-attempt signal
 * the caller cannot see.
 *
 * The attempt signal is aborted on every exit path, including expiry. Nothing
 * else would release the wait: the bridge answers this invocation before the
 * child's HTTP request closes, and `createHttpRequestAbortSignal` deliberately
 * does not abort a completed response, so an expiry that left the wait alive
 * would pin it until the relay's TTL and inflate the retention owner's waiter
 * count once per retry. Retention across foreground close is the retention
 * owner's own record of the request, not this wait.
 */
export async function awaitBoundedNativeHookRelayChildAdmission(params: {
  admit: (signal: AbortSignal) => Promise<(() => boolean) | undefined>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<(() => boolean) | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = new AbortController();
  const admission = params.admit(attempt.signal);
  // The admission settles after this race by design; adopt its rejection here
  // so the release below cannot surface as an unhandled rejection.
  admission.catch(() => {});
  try {
    return await Promise.race([
      racePromiseWithAbortSignal(admission, params.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(CHILD_ADMISSION_TIMEOUT_ERROR)),
          params.timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    attempt.abort(new Error(CHILD_ADMISSION_RELEASED_ERROR));
  }
}
