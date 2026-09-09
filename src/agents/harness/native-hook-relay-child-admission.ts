/**
 * Relay-side bound on native child hook admission.
 *
 * A child thread's pre_tool_use hook is admitted by its parent's relay
 * registration, and the admission only settles when the parent's subagent
 * monitor separately observes the spawn and claims the child. Without a bound
 * here, the child's own CLI deadline is the only clock: losing that race spends
 * the child's whole budget and surfaces as an ordinary fail-closed policy deny.
 */
import { DEFAULT_RELAY_TIMEOUT_MS } from "./native-hook-relay-constants.js";
import { normalizePositiveInteger } from "./native-hook-relay-utils.js";

/**
 * Fraction of the relay's own command budget allowed for child admission. The
 * child abandons the request at its full budget, so the relay must fail first
 * for the failure to be attributable to admission rather than to transport.
 */
const CHILD_ADMISSION_TIMEOUT_RATIO = 0.6;

/** Distinguishes a lost admission race from a generic retained-policy refusal. */
export const NATIVE_HOOK_RELAY_CHILD_ADMISSION_TIMEOUT_ERROR =
  "native hook relay child admission timed out";

/** Bounds child admission strictly below the relay's own command budget. */
export function resolveNativeHookRelayChildAdmissionTimeoutMs(
  commandTimeoutMs: number | undefined,
): number {
  const budgetMs = normalizePositiveInteger(commandTimeoutMs, DEFAULT_RELAY_TIMEOUT_MS);
  return Math.max(1, Math.floor(budgetMs * CHILD_ADMISSION_TIMEOUT_RATIO));
}

/**
 * Races child admission against the relay-side bound. The pending admission is
 * deliberately left in place on expiry: the codex retention predicate keeps the
 * relay registered while an admission is pending, so a claim that lands late
 * still admits the child's next tool call instead of finding a dead relay.
 */
export async function awaitBoundedNativeHookRelayChildAdmission(
  admission: Promise<(() => boolean) | undefined>,
  timeoutMs: number,
): Promise<(() => boolean) | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The admission outlives this race by design; adopt its rejection here so a
  // later settlement cannot surface as an unhandled rejection.
  admission.catch(() => {});
  try {
    return await Promise.race([
      admission,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(NATIVE_HOOK_RELAY_CHILD_ADMISSION_TIMEOUT_ERROR)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
