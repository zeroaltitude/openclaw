// Diagnostics for openclaw-e2m1 (refused native tool captures on warm CLI processes).
// Holds run ids and call-site names only, never bearer material.
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import {
  readAgentRunDelegatedAuthorityFailure,
  registerAgentRunDelegatedAuthorityClosedHandler,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";

/** The grant fields a refusal report reads. */
type RefusedGrant = {
  token: string;
  activeCaptureKey?: string;
  abortSignal?: AbortSignal;
  assertCurrent?: () => void;
  assertCaptureCurrent?: () => void;
  context: {
    runId?: string;
    sessionKey: string;
    nativeCronCreatorToolAllowlist?: string[] | null;
  };
};

function formatStackOrigin(stack: string | undefined, from: number, to: number): string {
  return (stack ?? "")
    .split("\n")
    .slice(from, to)
    .map((frame) => /^\s*at (?:async )?([^\s(]+) \(/.exec(frame)?.[1] ?? "?")
    .join("<");
}

/**
 * Diagnostic trail for openclaw-e2m1: who closed a run's delegated authority.
 * The registry notifies synchronously from the closing call, so the stack
 * taken here names the caller that retired it.
 */
type AuthorityClosure = { atMs: number; origin: string; approvalReason?: string };
const authorityClosures = new WeakMap<AgentRunDelegatedAuthority, AuthorityClosure>();
let authorityClosureTrailInstalled = false;

export function installAuthorityClosureTrail(): void {
  if (authorityClosureTrailInstalled) {
    return;
  }
  authorityClosureTrailInstalled = true;
  registerAgentRunDelegatedAuthorityClosedHandler((authority, approvalReason) => {
    if (!authorityClosures.has(authority)) {
      authorityClosures.set(authority, {
        atMs: Date.now(),
        origin: formatStackOrigin(new Error().stack, 2, 20),
        ...(approvalReason ? { approvalReason: JSON.stringify(approvalReason).slice(0, 80) } : {}),
      });
    }
  });
}

type GrantRowWrite = { op: string; runId?: string; atMs: number; origin: string };
const GRANT_ROW_WRITE_TRAIL_MAX = 256;
const lastGrantRowWriteByToken = new Map<string, GrantRowWrite>();

export function noteGrantRowWrite(token: string, op: string, runId: string | undefined): void {
  const origin = formatStackOrigin(new Error().stack, 3, 7);
  lastGrantRowWriteByToken.delete(token);
  lastGrantRowWriteByToken.set(token, { op, runId, atMs: Date.now(), origin });
  if (lastGrantRowWriteByToken.size > GRANT_ROW_WRITE_TRAIL_MAX) {
    const oldest = lastGrantRowWriteByToken.keys().next().value;
    if (oldest !== undefined) {
      lastGrantRowWriteByToken.delete(oldest);
    }
  }
}

/** Names every condition that refused a native capture (diagnostic, openclaw-e2m1). */
export function describeNativeCaptureRefusal(
  grant: RefusedGrant,
  row: RefusedGrant | undefined,
  admission: AdmittedRunContext | undefined,
  authority: AgentRunDelegatedAuthority | undefined,
): string {
  const reasons: string[] = [];
  const probe = (label: string, assertion: (() => void) | undefined) => {
    try {
      assertion?.();
    } catch (error) {
      reasons.push(
        `${label}(${String(error instanceof Error ? error.message : error).slice(0, 160)})`,
      );
    }
  };
  if (!admission) {
    reasons.push("no-admission");
  } else if (!authority) {
    reasons.push("no-authority-at-activation");
  } else {
    const current = getAdmittedRunDelegatedAuthority(admission);
    if (!current) {
      // The registry retires an authority when its session source assertion throws,
      // and keeps that error. It names what changed under the run.
      const cause = readAgentRunDelegatedAuthorityFailure(authority)?.cause;
      const describeError = (error: unknown): string =>
        error instanceof Error
          ? `${error.name}: ${error.message.slice(0, 200)}${
              error.cause === undefined ? "" : ` <- ${describeError(error.cause)}`
            }`
          : String(error).slice(0, 200);
      const closure = authorityClosures.get(authority);
      reasons.push(
        `authority-closed(cause=${cause === undefined ? "none" : describeError(cause)}${
          cause instanceof Error ? ` thrownAt=${formatStackOrigin(cause.stack, 1, 21)}` : ""
        } closedBy=${closure?.origin ?? "unknown"}${
          closure ? ` closedAgeMs=${Date.now() - closure.atMs}` : ""
        }${closure?.approvalReason ? ` approvalReason=${closure.approvalReason}` : ""})`,
      );
    } else if (current !== authority) {
      reasons.push("authority-replaced");
    }
  }
  if (grant.abortSignal?.aborted) {
    reasons.push("aborted");
  }
  probe("caller-assertion", grant.assertCurrent);
  probe("capture-assertion", grant.assertCaptureCurrent);
  if (!row) {
    reasons.push("row-missing");
  } else if (row !== grant) {
    reasons.push(
      `row-replaced(rowRun=${row.context.runId ?? "none"} rowCapture=${
        row.activeCaptureKey
          ? row.activeCaptureKey === grant.activeCaptureKey
            ? "same-key"
            : "other-key"
          : "inactive"
      })`,
    );
  }
  if (grant.context.nativeCronCreatorToolAllowlist === undefined) {
    reasons.push("no-allowlist-slot");
  }
  const last = lastGrantRowWriteByToken.get(grant.token);
  return [
    `reason=${reasons.join("+") || "unknown"}`,
    `run=${grant.context.runId ?? "none"}`,
    `session=${grant.context.sessionKey}`,
    last
      ? `lastWrite=${last.op} lastWriteRun=${last.runId ?? "none"} lastWriteAgeMs=${Date.now() - last.atMs} lastWriteOrigin=${last.origin}`
      : "lastWrite=none",
  ].join(" ");
}
