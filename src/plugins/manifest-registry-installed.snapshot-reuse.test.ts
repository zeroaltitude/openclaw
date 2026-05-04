/**
 * Caller-owned snapshot reuse for loadPluginManifestRegistryForInstalledIndex.
 *
 * Asserts that when the Gateway has published a `PluginMetadataSnapshot`
 * via the single-slot `current-plugin-metadata-snapshot` handoff, repeated
 * `loadPluginManifestRegistryForInstalledIndex` calls reuse the snapshot's
 * pre-built `manifestRegistry` instead of rebuilding from disk. This is the
 * caller-owned freshness boundary that `src/plugins/AGENTS.md` mandates.
 *
 * Reuse gates (validated by individual cases):
 *   - caller must thread both `config` and `workspaceDir`
 *   - snapshot must be the gateway's (carries a `workspaceDir`, has
 *     `manifestRegistry` populated, `policyHash` matches caller's config)
 *   - snapshot's `index` fingerprint must match caller's `index` fingerprint
 *   - bypass when a stateful `bundledChannelConfigCollector` is supplied
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

beforeEach(() => {
  clearCurrentPluginMetadataSnapshot();
});

afterEach(() => {
  // Always clear, even if the test failed mid-flight.
  clearCurrentPluginMetadataSnapshot();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-snapshot-reuse-test", tempDirs);
}

function writePlugin(rootDir: string, pluginId: string, modelPrefix: string): void {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object" },
      providers: [pluginId],
      modelSupport: { modelPrefixes: [modelPrefix] },
    }),
    "utf8",
  );
}

const TEST_CONFIG: OpenClawConfig = {} as OpenClawConfig;
const TEST_POLICY_HASH = resolveInstalledPluginIndexPolicyHash(TEST_CONFIG);
const TEST_WORKSPACE_DIR = "/snapshot-reuse-test-workspace";
const BASE_ENV = { OPENCLAW_VERSION: "2026.4.25", VITEST: "true" };

function createIndex(
  rootDir: string,
  overrides: Partial<InstalledPluginIndex> = {},
): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: TEST_POLICY_HASH,
    generatedAtMs: 1777118400000,
    installRecords: {},
    plugins: [
      {
        pluginId: "test-plugin",
        manifestPath: path.join(rootDir, "openclaw.plugin.json"),
        manifestHash: "manifest-hash",
        source: path.join(rootDir, "index.ts"),
        rootDir,
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          deferConfiguredChannelFullLoadUntilAfterListen: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

function createSnapshot(params: {
  index: InstalledPluginIndex;
  manifestRegistry: PluginManifestRegistry;
}): PluginMetadataSnapshot {
  return {
    policyHash: params.index.policyHash,
    workspaceDir: TEST_WORKSPACE_DIR,
    index: params.index,
    registryDiagnostics: [],
    manifestRegistry: params.manifestRegistry,
    plugins: params.manifestRegistry.plugins,
    diagnostics: params.manifestRegistry.diagnostics,
    byPluginId: new Map(params.manifestRegistry.plugins.map((p) => [p.id, p])),
    normalizePluginId: (id: string) => id,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: params.index.plugins.length,
      manifestPluginCount: params.manifestRegistry.plugins.length,
    },
  };
}

function load(
  index: InstalledPluginIndex,
  extra: Partial<Parameters<typeof loadPluginManifestRegistryForInstalledIndex>[0]> = {},
): PluginManifestRegistry {
  return loadPluginManifestRegistryForInstalledIndex({
    index,
    config: TEST_CONFIG,
    workspaceDir: TEST_WORKSPACE_DIR,
    env: BASE_ENV,
    includeDisabled: true,
    ...extra,
  });
}

describe("loadPluginManifestRegistryForInstalledIndex \u2014 current snapshot reuse", () => {
  it("reuses the published snapshot's manifestRegistry when index fingerprints match", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "test-plugin", "test-");
    const index = createIndex(rootDir);

    const built = load(index);
    setCurrentPluginMetadataSnapshot(createSnapshot({ index, manifestRegistry: built }), {
      config: TEST_CONFIG,
    });

    const reused = load(index);
    expect(reused.plugins[0]).toBe(built.plugins[0]);
  });

  it("falls through and rebuilds when the snapshot's index fingerprint differs", () => {
    const rootDirA = makeTempDir();
    const rootDirB = makeTempDir();
    writePlugin(rootDirA, "test-plugin", "a-");
    writePlugin(rootDirB, "test-plugin", "b-");
    const indexA = createIndex(rootDirA);
    const indexB = createIndex(rootDirB);

    const builtA = load(indexA);
    setCurrentPluginMetadataSnapshot(createSnapshot({ index: indexA, manifestRegistry: builtA }), {
      config: TEST_CONFIG,
    });

    const resultB = load(indexB);
    expect(resultB.plugins[0]).not.toBe(builtA.plugins[0]);
    expect(resultB.plugins[0]?.modelSupport).toEqual({ modelPrefixes: ["b-"] });
  });

  it("does not reuse when caller omits config or workspaceDir", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "test-plugin", "test-");
    const index = createIndex(rootDir);

    const built = load(index);
    setCurrentPluginMetadataSnapshot(createSnapshot({ index, manifestRegistry: built }), {
      config: TEST_CONFIG,
    });

    // Without config or workspaceDir, the strict gate forces a rebuild even
    // though a snapshot is published. Different reference proves no reuse.
    const noConfig = loadPluginManifestRegistryForInstalledIndex({
      index,
      env: BASE_ENV,
      includeDisabled: true,
    });
    expect(noConfig.plugins[0]).not.toBe(built.plugins[0]);
  });

  it("filters snapshot plugins by includeDisabled and pluginIds", () => {
    const rootDirA = makeTempDir();
    const rootDirB = makeTempDir();
    writePlugin(rootDirA, "plugin-a", "a-");
    writePlugin(rootDirB, "plugin-b", "b-");

    const index: InstalledPluginIndex = {
      version: 1,
      hostContractVersion: "2026.4.25",
      compatRegistryVersion: "compat-v1",
      migrationVersion: 1,
      policyHash: TEST_POLICY_HASH,
      generatedAtMs: 1777118400000,
      installRecords: {},
      plugins: [
        {
          pluginId: "plugin-a",
          manifestPath: path.join(rootDirA, "openclaw.plugin.json"),
          manifestHash: "ha",
          source: path.join(rootDirA, "index.ts"),
          rootDir: rootDirA,
          origin: "global",
          enabled: true,
          startup: {
            sidecar: false,
            memory: false,
            deferConfiguredChannelFullLoadUntilAfterListen: false,
            agentHarnesses: [],
          },
          compat: [],
        },
        {
          pluginId: "plugin-b",
          manifestPath: path.join(rootDirB, "openclaw.plugin.json"),
          manifestHash: "hb",
          source: path.join(rootDirB, "index.ts"),
          rootDir: rootDirB,
          origin: "global",
          enabled: false,
          startup: {
            sidecar: false,
            memory: false,
            deferConfiguredChannelFullLoadUntilAfterListen: false,
            agentHarnesses: [],
          },
          compat: [],
        },
      ],
      diagnostics: [],
    };

    const fullRegistry = load(index);
    expect(fullRegistry.plugins.map((p) => p.id).sort()).toEqual(["plugin-a", "plugin-b"]);
    setCurrentPluginMetadataSnapshot(createSnapshot({ index, manifestRegistry: fullRegistry }), {
      config: TEST_CONFIG,
    });

    const enabledOnly = load(index, { includeDisabled: false });
    expect(enabledOnly.plugins.map((p) => p.id)).toEqual(["plugin-a"]);

    const subset = load(index, { pluginIds: ["plugin-b"] });
    expect(subset.plugins.map((p) => p.id)).toEqual(["plugin-b"]);
  });

  it("bypasses snapshot reuse when a bundledChannelConfigCollector is provided", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "test-plugin", "test-");
    const index = createIndex(rootDir);

    const built = load(index);

    // Publish a snapshot whose manifestRegistry has a sentinel marker we can
    // distinguish from a freshly-built one. The collector path must NOT
    // observe this sentinel because it forces a real build.
    const sentinelPlugin = { ...built.plugins[0], description: "snapshot-sentinel" };
    setCurrentPluginMetadataSnapshot(
      createSnapshot({
        index,
        manifestRegistry: { plugins: [sentinelPlugin], diagnostics: [] },
      }),
      { config: TEST_CONFIG },
    );

    const reused = load(index);
    expect(reused.plugins[0]?.description).toBe("snapshot-sentinel");

    const fresh = load(index, { bundledChannelConfigCollector: () => undefined });
    expect(fresh.plugins[0]?.description).not.toBe("snapshot-sentinel");
    expect(fresh.plugins[0]?.id).toBe("test-plugin");
  });
});
