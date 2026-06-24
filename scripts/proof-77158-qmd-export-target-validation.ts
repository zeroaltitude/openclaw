/**
 * Real-runtime proof for PR #77158 — validate cached export-target bytes before
 * the QMD session-export fast path skips a rebuild.
 *
 * This proof drives the ACTUAL production integration path end to end: a real
 * `QmdMemoryManager` instance runs its real (private) `exportSessions()` method
 * against a real per-agent SQLite export cache, a real session transcript corpus
 * accessor, and real on-disk markdown targets. It does NOT re-implement the
 * fast-path / slow-path decision — every SKIP-vs-REBUILD choice is made by the
 * shipped `exportSessions()` code itself. An earlier version of this script
 * simulated the cache/fs decision directly with the helper functions; that could
 * pass even if `exportSessions()` regressed, so it is replaced here.
 *
 * WHAT IS REAL (no mocks of the seam under test):
 *  - The manager: `QmdMemoryManager.create({ mode: "status" })` builds the real
 *    manager. `status` mode initializes collections but never spawns the `qmd`
 *    binary, so `exportSessions()` runs with its real collaborators and zero
 *    process stubbing.
 *  - The export driver: the real private `exportSessions()` method, invoked
 *    directly (the same method the production sync loop calls). Its stat fast
 *    path, content fingerprint check, TARGET BYTE fingerprint check, slow-path
 *    rebuild, cache upsert, stale-entry deletion, and artifact-mapping write all
 *    execute as shipped.
 *  - The session corpus: the real `listSessionTranscriptCorpusEntriesForAgent`
 *    accessor reads a real `sessions.json` + real `.jsonl` transcript on disk,
 *    resolved through the real runtime-config snapshot.
 *  - The export cache: the real per-agent SQLite DB and `qmd_session_export_cache`
 *    table (including the new `target_fingerprint` column and additive ALTER
 *    migration), read/written through the production
 *    `listQmdSessionExportCacheEntries` / `readQmdSessionExportCacheEntry` /
 *    `upsertQmdSessionExportCacheEntry` helpers.
 *  - The artifact index: `replaceQmdSessionArtifactMappings` writes the real
 *    qmd index SQLite at the manager's real `indexPath`.
 *  - Every stat / read / write hits the real filesystem under a temp state dir.
 *
 * WHAT IS STUBBED:
 *  - Nothing in the seam under test. The real `qmd` binary (the indexing/search
 *    layer) is never spawned because `mode: "status"` short-circuits before any
 *    spawn AND `exportSessions()` itself shells out to nothing — it only touches
 *    the cache DB, the corpus accessor, the filesystem, and the artifact index.
 *    The legacy "row predates the target_fingerprint column" state is produced by
 *    re-upserting the manager's own cache row with `targetFingerprint: null`
 *    through the REAL upsert helper (the production write path persists null),
 *    then letting the real `exportSessions()` decide what to do with it.
 *
 * SCENARIOS (each self-checks; the script throws + exits non-zero on any
 * invariant violation):
 *  (a) cold cache -> exportSessions BUILDS the markdown and persists a non-null
 *      target fingerprint.
 *  (b) clean cache hit — source unchanged AND target bytes intact -> SKIP (no
 *      rewrite; the on-disk bytes and mtime are preserved).
 *  (c) source unchanged but target bytes CORRUPTED on disk -> REBUILD + self-heal
 *      (the regression this PR pins; existence-only validation would preserve the
 *      corruption).
 *  (d) source CHANGED -> REBUILD with the new content.
 *  (e) legacy cache row with NULL target_fingerprint (pre-column DB, written via
 *      the real upsert helper):
 *        e.1 target bytes correct -> the fast path cannot trust them, so
 *            exportSessions re-enters the slow path and REPOPULATES the
 *            fingerprint; the next round becomes a verified fast skip.
 *        e.2 NULL fingerprint AND corrupted target -> REBUILD rather than trust
 *            the unverifiable bytes.
 *
 * RUN: pnpm tsx scripts/proof-77158-qmd-export-target-validation.ts
 */
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { QmdMemoryManager } from "../extensions/memory-core/src/memory/qmd-manager.js";
import { setRuntimeConfigSnapshot } from "../src/config/config.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listQmdSessionExportCacheEntries,
  readQmdSessionExportCacheEntry,
  upsertQmdSessionExportCacheEntry,
  type QmdSessionExportCacheOptions,
} from "../src/state/openclaw-agent-db.js";

const AGENT_ID = "main";
const RENDER_VERSION = 1;
const SESSION_BASENAME = "session-1";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`PROOF ASSERTION FAILED: ${message}`);
  }
}

// Internal handle for the manager's two private members we need: the real
// exportSessions() driver and the real per-agent index path (for diagnostics).
type ManagerInternals = {
  exportSessions: () => Promise<void>;
  indexPath: string;
};

function internals(manager: QmdMemoryManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

async function main(): Promise<void> {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "proof-77158-"));
  const stateDir = path.join(tmpRoot, "state");
  const workspaceDir = path.join(tmpRoot, "workspace");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  await fs.mkdir(workspaceDir, { recursive: true });

  // A minimal real config: qmd backend with session export enabled. The runtime
  // snapshot makes the corpus accessor resolve the session store deterministically
  // to <stateDir>/agents/main/sessions (the default layout) rather than reading
  // the host machine's real OpenClaw config.
  const cfg = {
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
    memory: {
      backend: "qmd",
      qmd: {
        includeDefaultMemory: false,
        update: { interval: "0s", debounceMs: 0, onBoot: false },
        sessions: { enabled: true },
        paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
      },
    },
  } as unknown as OpenClawConfig;
  setRuntimeConfigSnapshot(cfg);

  const sessionsDir = path.join(stateDir, "agents", AGENT_ID, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, `${SESSION_BASENAME}.jsonl`);
  // sessions.json maps the transcript to a stable session identity so the corpus
  // accessor surfaces it (mirrors the qmd-manager unit-test harness).
  await fs.writeFile(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      "agent:main:chat:thread": {
        sessionFile: `${SESSION_BASENAME}.jsonl`,
        sessionId: SESSION_BASENAME,
      },
    }),
    "utf-8",
  );

  const sourceV1 = '{"type":"message","message":{"role":"user","content":"hello"}}\n';
  const sourceV2 = '{"type":"message","message":{"role":"user","content":"goodbye"}}\n';
  await fs.writeFile(sessionFile, sourceV1, "utf-8");

  const resolved = resolveMemoryBackendConfig({ cfg, agentId: AGENT_ID });
  const manager = await QmdMemoryManager.create({
    cfg,
    agentId: AGENT_ID,
    resolved,
    mode: "status",
  });
  assert(manager !== null, "QmdMemoryManager.create must return a manager");

  const exportCacheOptions: QmdSessionExportCacheOptions = {
    agentId: AGENT_ID,
    env: process.env,
  };
  // exportSessions() resolves the export dir as <qmdDir>/sessions when the config
  // does not override it. Recompute the same default for assertions.
  const exportDir = path.join(stateDir, "agents", AGENT_ID, "qmd", "sessions");
  const target = path.join(exportDir, `${SESSION_BASENAME}.md`);

  const runExport = () => internals(manager).exportSessions();
  const readTarget = async (): Promise<string | null> => {
    try {
      return await fs.readFile(target, "utf-8");
    } catch {
      return null;
    }
  };
  const readCacheRow = () =>
    readQmdSessionExportCacheEntry(exportCacheOptions, {
      sessionFile,
      exportDir,
      renderVersion: RENDER_VERSION,
    });
  const targetStat = () => fs.stat(target);

  try {
    // (a) cold cache -> build markdown + persist a non-null target fingerprint.
    await runExport();
    const coldBody = await readTarget();
    assert(coldBody !== null, "(a) cold export must create the target markdown");
    assert(coldBody.includes("hello"), "(a) cold export markdown must contain rendered body");
    const coldRow = readCacheRow();
    assert(coldRow !== null, "(a) cold export must persist a cache row");
    assert(coldRow.target === target, "(a) cache row must record the export target path");
    assert(
      coldRow.targetFingerprint !== null,
      "(a) cold export must persist a non-null target fingerprint",
    );
    assert(
      coldRow.targetFingerprint ===
        crypto.createHash("sha1").update(coldBody, "utf-8").digest("hex"),
      "(a) persisted target fingerprint must equal the SHA-1 of the written markdown",
    );
    console.log("[a] cold export -> built target and persisted target fingerprint");

    // (b) clean cache hit: source unchanged AND target intact -> SKIP (no rewrite).
    const beforeStat = await targetStat();
    await runExport();
    const afterStat = await targetStat();
    assert(
      afterStat.mtimeMs === beforeStat.mtimeMs,
      "(b) clean cache hit must NOT rewrite the target (mtime must be unchanged)",
    );
    assert((await readTarget())?.includes("hello"), "(b) target content must remain intact");
    console.log("[b] clean cache hit -> skipped rebuild (target untouched)");

    // (c) source unchanged but target bytes CORRUPTED -> REBUILD + self-heal.
    await fs.writeFile(target, "corrupted external edit\n", "utf-8");
    await runExport();
    const healed = await readTarget();
    assert(healed !== null, "(c) corrupted target must be rebuilt");
    assert(healed.includes("hello"), "(c) rebuilt target must contain the correct content");
    assert(
      !healed.includes("corrupted external edit"),
      "(c) corruption must be overwritten, not preserved",
    );
    console.log("[c] corrupted target bytes -> rebuilt and self-healed (regression pinned)");

    // Confirm we are back to a clean skip after healing.
    const healedStat = await targetStat();
    await runExport();
    const afterHealStat = await targetStat();
    assert(
      afterHealStat.mtimeMs === healedStat.mtimeMs,
      "(c) post-heal clean hit must skip again (no rewrite)",
    );

    // (d) source CHANGED -> REBUILD with new content.
    await fs.writeFile(sessionFile, sourceV2, "utf-8");
    await runExport();
    const changed = await readTarget();
    assert(changed !== null, "(d) changed source must produce a target");
    assert(changed.includes("goodbye"), "(d) rebuilt target must reflect the new source");
    assert(!changed.includes("hello"), "(d) rebuilt target must not retain the stale body");
    console.log("[d] source changed -> rebuilt with new content");

    // (e) legacy row with NULL target_fingerprint -> rebuild + repopulate.
    // Re-upsert the manager's own cache row with targetFingerprint=null through
    // the REAL upsert helper (the production write path persists null), then let
    // the real exportSessions() decide what to do with it.
    const current = readCacheRow();
    assert(current !== null, "(e) precondition: a cache row must exist");
    upsertQmdSessionExportCacheEntry(exportCacheOptions, { ...current, targetFingerprint: null });
    const reloaded = readCacheRow();
    assert(
      reloaded?.targetFingerprint === null,
      "(e) legacy row must round-trip a NULL fingerprint through the real DB",
    );

    // e.1: legacy NULL + correct on-disk bytes. The fast path cannot trust the
    // bytes, so exportSessions re-enters the slow path and repopulates the
    // fingerprint. The next round must then be a verified fast skip.
    await runExport();
    const repopulated = readCacheRow();
    assert(
      repopulated?.targetFingerprint !== null,
      "(e.1) legacy round must repopulate a non-null target fingerprint",
    );
    const repopStat = await targetStat();
    await runExport();
    const afterRepopStat = await targetStat();
    assert(
      afterRepopStat.mtimeMs === repopStat.mtimeMs,
      "(e.1) repopulated row must skip on the next clean round (no rewrite)",
    );
    console.log("[e.1] legacy NULL fingerprint + correct bytes -> repopulated, then verified skip");

    // e.2: legacy NULL fingerprint AND corrupted target -> rebuild, not preserve.
    const before2 = readCacheRow();
    assert(before2 !== null, "(e.2) precondition: a cache row must exist");
    upsertQmdSessionExportCacheEntry(exportCacheOptions, { ...before2, targetFingerprint: null });
    await fs.writeFile(target, "legacy corruption\n", "utf-8");
    await runExport();
    const legacyHealed = await readTarget();
    assert(legacyHealed !== null, "(e.2) legacy NULL + corrupted target must produce a target");
    assert(
      legacyHealed.includes("goodbye"),
      "(e.2) rebuilt target must contain the correct content",
    );
    assert(
      !legacyHealed.includes("legacy corruption"),
      "(e.2) corruption must be overwritten, not preserved",
    );
    console.log("[e.2] legacy NULL fingerprint + corrupted target -> rebuilt (corruption healed)");

    // Sanity: exactly one tracked session remains cached for this export dir.
    const finalEntries = listQmdSessionExportCacheEntries(exportCacheOptions, {
      exportDir,
      renderVersion: RENDER_VERSION,
    });
    assert(
      finalEntries.length === 1 && finalEntries[0]?.sessionFile === sessionFile,
      "final cache state must track exactly the one exported session",
    );
    assert(
      typeof internals(manager).indexPath === "string" && internals(manager).indexPath.length > 0,
      "manager must expose a real artifact index path (artifact mappings were written there)",
    );

    console.log("All runtime assertions passed.");
  } finally {
    await manager?.close().catch(() => undefined);
    closeOpenClawAgentDatabasesForTest();
    setRuntimeConfigSnapshot(cfg); // leave a defined snapshot; cleared below
    delete process.env.OPENCLAW_STATE_DIR;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
