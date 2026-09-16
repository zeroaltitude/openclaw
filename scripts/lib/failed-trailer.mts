// Keeps wrapper failures visible even when preceding diagnostics are truncated,
// and marks every terminal exit so a truncated log cannot be read as a clean run.
import path from "node:path";

// A CLI shim that emits the terminal marker for its implementation publishes the
// implementation path here, so one invocation never carries two EXIT lines.
export const EXIT_TRAILER_DEFER_ENV = "OPENCLAW_CLI_EXIT_TRAILER_DEFER";

export function writeFailedTrailer(
  tool: string,
  exitCode: number | string | null | undefined,
  log: (value: unknown) => void = console.error,
): void {
  if (typeof exitCode === "number" && exitCode !== 0) {
    log(`[${tool}] FAILED (exit ${exitCode})`);
  }
}

function normalizeExitCode(exitCode: number | string | null | undefined): number {
  if (typeof exitCode === "number") {
    return exitCode;
  }
  if (exitCode === null || exitCode === undefined || exitCode === "") {
    return 0;
  }
  const parsed = Number(exitCode);
  // An unparseable exit code still describes a run that ended: report it as a
  // failure rather than dropping the marker that says the run reached an end.
  return Number.isFinite(parsed) ? parsed : 1;
}

/**
 * Return whether this process owns the terminal EXIT marker for its script.
 * A shim wrapper writes the marker for the implementation it spawned, so that
 * implementation stays silent and the log keeps exactly one marker.
 * @internal Directly tested wrapper implementation detail.
 */
export function ownsExitTrailer(
  scriptPath: string | undefined = process.argv[1],
  deferredPath: string | undefined = process.env[EXIT_TRAILER_DEFER_ENV],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!deferredPath || !scriptPath) {
    return true;
  }
  const pathImpl = platform === "win32" ? path.win32 : path;
  const normalize = (value: string) =>
    platform === "win32" ? pathImpl.resolve(value).toLowerCase() : pathImpl.resolve(value);
  return normalize(deferredPath) !== normalize(scriptPath);
}

/**
 * Write the fixed-shape terminal marker, then the human failure line.
 * The marker is unconditional: a killed run leaves no marker at all, so its
 * presence — not the log's length — is what says the run reached an end.
 * The `FAILED` line stays last so a reader still ends on the failure text.
 */
export function writeExitTrailer(
  tool: string,
  exitCode: number | string | null | undefined,
  log: (value: unknown) => void = console.error,
): void {
  const code = normalizeExitCode(exitCode);
  if (ownsExitTrailer()) {
    log(`[${tool}] EXIT ${code}`);
  }
  writeFailedTrailer(tool, code, log);
}

export async function runWithFailedTrailer(
  tool: string,
  run: () => void | Promise<void>,
  log: (value: unknown) => void = console.error,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    log(error);
    process.exitCode = 1;
  }
  writeExitTrailer(tool, process.exitCode, log);
}
