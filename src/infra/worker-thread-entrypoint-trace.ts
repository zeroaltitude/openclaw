// Temporary diagnostic for openclaw-npk1: names which `new Worker()` call site
// owns each live threadId. Local-only instrumentation branch; not for upstream.
// Gated on OPENCLAW_TRACE_WORKER_THREADS so it is inert unless explicitly enabled.
import type { Worker } from "node:worker_threads";

function isWorkerThreadTraceEnabled(): boolean {
  const raw = process.env.OPENCLAW_TRACE_WORKER_THREADS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Logs the assigned threadId against a human label once the worker comes online. */
export function traceWorkerThreadEntrypoint(worker: Worker, label: string): void {
  if (!isWorkerThreadTraceEnabled()) {
    return;
  }
  worker.once("online", () => {
    console.error(
      `[worker-thread-trace] threadId=${worker.threadId} label=${JSON.stringify(label)} pid=${process.pid}`,
    );
  });
}
