// Bootstraps documented JavaScript entrypoints before the TypeScript loader is active.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureRepoNodeModulesLink } from "./local-check-runtime.mts";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
// Mirrors EXIT_TRAILER_DEFER_ENV in scripts/lib/failed-trailer.mts.
const EXIT_TRAILER_DEFER_ENV = "OPENCLAW_CLI_EXIT_TRAILER_DEFER";
const DEFAULT_FORCE_KILL_DELAY_MS = 5_000;
const SHIM_CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function resolveTsxImport(checkoutRoot) {
  const modulesDir =
    (process.env.PNPM_CONFIG_MODULES_DIR ?? process.env.pnpm_config_modules_dir) ||
    process.env.npm_config_modules_dir;
  const localModulesDir = path.resolve(checkoutRoot, "node_modules");
  const configuredModulesDir = modulesDir ? path.resolve(checkoutRoot, modulesDir) : undefined;
  const candidates = configuredModulesDir
    ? [configuredModulesDir, localModulesDir]
    : [localModulesDir];
  for (const selectedModulesDir of candidates) {
    const tsxManifest = path.join(selectedModulesDir, "tsx", "package.json");
    if (!existsSync(tsxManifest)) {
      continue;
    }
    const require = createRequire(tsxManifest);
    // Keep compiled ESM native: tsx's CJS hook rewrites its import-only
    // dependency edges into require() calls with incompatible export conditions.
    const importUrl = pathToFileURL(require.resolve("tsx/esm")).href;
    if (selectedModulesDir === configuredModulesDir) {
      ensureRepoNodeModulesLink(selectedModulesDir, { cwd: checkoutRoot });
    }
    return importUrl;
  }
  throw new Error(
    `Repository dependencies are missing from ${localModulesDir}. Run pnpm install --frozen-lockfile in an independently owned checkout.`,
  );
}

export async function registerToolingTsx() {
  // tsx indexes the entire shared disk cache before expiration, coupling startup
  // to other checkouts' cache size. This flag retains its in-process Map and
  // reaches descendant tooling before their loaders initialize.
  process.env.TSX_DISABLE_CACHE = "1";
  await import(resolveTsxImport(SHIM_CHECKOUT_ROOT));
}

function signalExitCode(signal) {
  const signalNumber = osConstants.signals[signal];
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

/**
 * Write the fixed-shape terminal marker for a shimmed run, then the human
 * failure line. A detached gate log is judged by this marker: a killed run
 * leaves none, so a pass must not be silent and a wrapper without a curated
 * `failureTool` must not be silent either. Keep both lines on stderr — several
 * shimmed implementations emit machine-parsed stdout, and detached runs
 * redirect `2>&1` anyway.
 *
 * The text mirrors `scripts/lib/failed-trailer.mts` deliberately rather than
 * importing it: this shim's dependency set is mirrored in packaging manifests
 * and test fixtures, so it stays free of repo-internal imports.
 *
 * `exitTool` names the marker for a wrapper whose implementation already owns
 * the human failure line, so both lines read as one tool. Without either name
 * the implementation's file name still identifies the run.
 * @param {{ exitTool?: string, failureTool?: string, implementation?: string }} options
 * @param {number} exitCode
 */
function writeExitTrailer(options, exitCode) {
  const tool =
    options.exitTool ?? options.failureTool ?? path.basename(options.implementation ?? "cli");
  console.error(`[${tool}] EXIT ${exitCode}`);
  // Only a curated tool name gets the human line, and it stays last so the
  // existing "final line names the failure" contracts keep holding.
  if (options.failureTool && exitCode !== 0) {
    console.error(`[${options.failureTool}] FAILED (exit ${exitCode})`);
  }
}

function signalChild(child, signal, detached) {
  if (!child?.pid) {
    return;
  }
  try {
    if (detached && process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
      console.error(error);
    }
  }
}

async function runCliShimInner(moduleUrl, options, nodeArgs) {
  const detached = options.detached ?? (process.platform !== "win32" && !process.stdin.isTTY);
  const forceKillDelayMs = options.forceKillDelayMs ?? DEFAULT_FORCE_KILL_DELAY_MS;
  let child = null;
  let forceKillTimer = null;
  const signalHandlers = new Map();
  const cleanup = () => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    process.off("exit", exitHandler);
  };
  const exitHandler = () => signalChild(child, "SIGTERM", detached);

  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      signalChild(child, signal, detached);
      // A lifecycle-owning implementation must finish killing its own child groups.
      // A competing shim deadline can kill that owner and orphan those children.
      if (options.terminationOwner !== "implementation") {
        forceKillTimer ??= setTimeout(
          () => signalChild(child, "SIGKILL", detached),
          forceKillDelayMs,
        );
        forceKillTimer.unref();
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  process.on("exit", exitHandler);

  try {
    const implementationUrl = new URL(options.implementation, moduleUrl);
    const implementationPath = fileURLToPath(implementationUrl);
    const nodeExecutable = process.versions.bun ? "node" : process.execPath;
    child = spawn(nodeExecutable, [...nodeArgs, implementationPath, ...process.argv.slice(2)], {
      cwd: process.cwd(),
      detached,
      // This shim writes the terminal marker for the whole invocation, so the
      // implementation's own trailer skips its EXIT line instead of doubling it.
      env: { ...process.env, [EXIT_TRAILER_DEFER_ENV]: implementationPath },
      stdio: "inherit",
    });
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    cleanup();

    if (result.signal) {
      writeExitTrailer(options, signalExitCode(result.signal));
      process.kill(process.pid, result.signal);
      return;
    }
    const exitCode = result.code ?? 1;
    writeExitTrailer(options, exitCode);
    process.exitCode = exitCode;
  } catch (error) {
    cleanup();
    console.error(error);
    writeExitTrailer(options, 1);
    process.exitCode = 1;
  }
}

async function runCliShim(moduleUrl, options, nodeArgs) {
  try {
    await runCliShimInner(moduleUrl, options, nodeArgs);
  } catch (error) {
    console.error(error);
    writeExitTrailer(options, 1);
    process.exitCode = 1;
  }
}

export function runNodeCliShim(moduleUrl, options = {}) {
  return runCliShim(moduleUrl, options, []);
}

export function runTsxCliShim(moduleUrl, options = {}) {
  return runCliShim(moduleUrl, options, ["--import", new URL("../tsx.mjs", import.meta.url).href]);
}
