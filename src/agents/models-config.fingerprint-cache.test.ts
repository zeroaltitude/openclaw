import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import { writePersistedAuthProfileStoreRaw } from "./auth-profiles/sqlite.js";
import {
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
} from "./models-config.e2e-harness.js";

vi.mock("../plugins/manifest-registry.js", () => ({
  clearPluginManifestRegistryCache: () => undefined,
  loadPluginManifestRegistry: () => ({ plugins: [] }),
}));

vi.mock("./model-auth-env-vars.js", () => ({
  listKnownProviderEnvApiKeyNames: () => ["OPENAI_API_KEY"],
  PROVIDER_ENV_API_KEY_CANDIDATES: { openai: ["OPENAI_API_KEY"] },
  resolveProviderEnvApiKeyCandidates: () => ({ openai: ["OPENAI_API_KEY"] }),
  resolveProviderEnvAuthEvidence: () => ({}),
  listProviderEnvAuthLookupKeys: () => ["openai"],
  resolveProviderEnvAuthLookupKeys: () => ["openai"],
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: { openai: ["OPENAI_API_KEY"] },
    authEvidenceMap: {},
  }),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  applyProviderConfigDefaultsWithPlugin: (config: OpenClawConfig) => config,
  applyProviderNativeStreamingUsageCompatWithPlugin: () => undefined,
  normalizeProviderConfigWithPlugin: () => undefined,
  resetProviderRuntimeHookCacheForTest: () => undefined,
  resolveProviderConfigApiKeyWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
}));

/**
 * We track how many times the implicit-provider discovery pipeline runs so we
 * can verify that the in-memory cache keyed by the models.json target path
 * short-circuits subsequent calls when inputs have not meaningfully changed.
 */
let resolveImplicitProvidersCallCount = 0;
vi.mock("./models-config.providers.js", async () => {
  const actual = await vi.importActual<typeof import("./models-config.providers.js")>(
    "./models-config.providers.js",
  );
  return {
    ...actual,
    resolveImplicitProviders: async () => {
      resolveImplicitProvidersCallCount += 1;
      return {};
    },
  };
});

installModelsConfigTestHooks();

let clearConfigCache: typeof import("../config/io.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/io.js").clearRuntimeConfigSnapshot;
let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let resetModelsJsonReadyCacheForTest: typeof import("./models-config.js").resetModelsJsonReadyCacheForTest;

const fixtureSuite = createFixtureSuite("openclaw-models-fingerprint-");

function createOpenAiConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test-static-value", // pragma: allowlist secret
          api: "openai-completions" as const,
          models: [],
        },
      },
    },
  };
}

// Seed the canonical SQLite auth-profile store (the `auth_profile_store`
// row) that `ensureOpenClawModelsJson` now fingerprints — NOT the legacy
// `auth-profiles.json` file.  Synchronous upsert mirroring a real save.
function writeAuthProfiles(agentDir: string, profiles: unknown): void {
  writePersistedAuthProfileStoreRaw(profiles, agentDir);
}

beforeAll(async () => {
  await fixtureSuite.setup();
  ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/io.js"));
  ({ ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } =
    await import("./models-config.js"));
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  resetModelsJsonReadyCacheForTest();
  resolveImplicitProvidersCallCount = 0;
  unsetEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS]);
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

describe("ensureOpenClawModelsJson fingerprint cache", () => {
  it("reuses the cached result when inputs do not change", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    await ensureOpenClawModelsJson(cfg, agentDir);
    const firstCount = resolveImplicitProvidersCallCount;
    expect(firstCount).toBe(1);

    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(firstCount);
  });

  it("does not invalidate the cache when OAuth session fields rotate", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token-v1",
          refresh: "refresh-token-v1",
          expires: 1_700_000_000_000,
          accountId: "account-xyz",
        },
      },
    });

    await ensureOpenClawModelsJson(cfg, agentDir);
    const firstCount = resolveImplicitProvidersCallCount;
    expect(firstCount).toBe(1);

    // Simulate an OAuth token refresh: access/refresh/expires fields
    // rotate, but the set of providers the user can use does not change.
    // These fields stay in AUTH_PROFILE_VOLATILE_FIELDS.
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token-v2-ROTATED",
          refresh: "refresh-token-v2-ROTATED",
          expires: 1_700_000_999_000,
          accountId: "account-xyz",
        },
      },
    });

    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(firstCount);
  });

  it("DOES invalidate the cache when a static type:token credential rotates (Codex/Greptile P2)", async () => {
    // Counterpart to the OAuth-rotation test above. Profiles with
    // `type: "token"` use the literal `token` key as a long-lived static
    // credential. The user rotating this credential must invalidate the
    // cache so the implicit-provider-discovery pipeline re-runs against
    // the new value (Codex/Greptile P2 on PR #72869: "token" used to be
    // in the volatile fields set, masking real auth-state changes).
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "sk-ant-first-token-value", // pragma: allowlist secret
        },
      },
    });

    await ensureOpenClawModelsJson(cfg, agentDir);
    const firstCount = resolveImplicitProvidersCallCount;
    expect(firstCount).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 10));
    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "sk-ant-rotated-token-value", // pragma: allowlist secret
        },
      },
    });

    await ensureOpenClawModelsJson(cfg, agentDir);
    // Static-credential rotation must trigger a re-plan.
    expect(resolveImplicitProvidersCallCount).toBe(firstCount + 1);
  });

  it("invalidates the cache when an auth profile is added or removed", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "sk-ant-first-token-value", // pragma: allowlist secret
        },
      },
    });

    await ensureOpenClawModelsJson(cfg, agentDir);
    const firstCount = resolveImplicitProvidersCallCount;
    expect(firstCount).toBe(1);

    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "sk-ant-first-token-value", // pragma: allowlist secret
        },
        "google:default": {
          type: "token",
          provider: "google",
          token: "google-api-key-added", // pragma: allowlist secret
        },
      },
    });

    await ensureOpenClawModelsJson(cfg, agentDir);
    // Structural change (new profile) must invalidate the cache.
    expect(resolveImplicitProvidersCallCount).toBe(firstCount + 1);
  });

  it("invalidates the cache when the config changes", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfgOne = createOpenAiConfig();
    const cfgTwo: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            ...cfgOne.models!.providers!.openai,
            baseUrl: "https://alt.example.com/v1",
          },
        },
      },
    };

    await ensureOpenClawModelsJson(cfgOne, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);

    await ensureOpenClawModelsJson(cfgTwo, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(2);
  });

  it("forces a re-plan on every call while the auth-profile store stays oversize (fail-closed cap)", async () => {
    // A store payload over MAX_AUTH_PROFILES_BYTES is `uncacheable`, so the
    // readyCache is bypassed entirely and EVERY call must re-plan — even
    // when the payload is byte-identical to the previous oversize call.
    // Guards against an oversize state collapsing onto a single fingerprint
    // contribution and letting credential edits ride a stale cache.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // Warm the cache with a small profile.
    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "***", // pragma: allowlist secret
        },
      },
    });
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Repeat call with the same small profile — cache hit, no re-plan.
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Grow the store payload past the cap.  First oversize call: cache miss
    // (different effective state) → re-plan.
    const padding = "x".repeat(10 * 1024 * 1024); // 10 MiB > MAX_AUTH_PROFILES_BYTES
    writeAuthProfiles(agentDir, {
      version: 1,
      padding,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "***", // pragma: allowlist secret
        },
      },
    });
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(2);

    // Repeat oversize call with byte-identical payload.  The store is
    // `uncacheable`, so the cache stays bypassed and we re-plan again.
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(3);

    // Same again — still bypassed.
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(4);

    // Restoring a small (different) profile re-enables caching, and
    // the next call after that should be a cache hit.
    writeAuthProfiles(agentDir, {
      version: 1,
      profiles: {
        "google:default": {
          type: "token",
          provider: "google",
          token: "google-restored", // pragma: allowlist secret
        },
      },
    });
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(5);
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(5);
  }, 30_000);

  it("invalidates the cache when models.json becomes unhashable (Codex P1 round-4 on #73260)", async () => {
    // Round-4 follow-up: the cache-hit predicate used to accept
    // `currentModelsJsonHash === settled.modelsJsonHash`, but
    // `readModelsJsonContentHash` returned null for several failure
    // modes (oversize, symlink, I/O error) in addition to the
    // legitimate "file absent" case.  An attacker who could put
    // models.json into any of those states could then mutate its
    // contents repeatedly while every read returned null, and the
    // cache would keep hitting.  The fix uses a discriminated outcome
    // where `uncacheable` never compares equal — not even to itself.
    const agentDir = await fixtureSuite.createCaseDir("agent");
    const cfg = createOpenAiConfig();

    // Warm cache: small models.json gets written, outcome captured as
    // `{ kind: "hashed", hash: <H> }`.
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(1);

    // Make models.json oversize externally.  Cache-hit predicate must
    // see `{ uncacheable }` for the current outcome and force a
    // re-plan even though the captured outcome was `{ hashed, H }`.
    const modelsPath = path.join(agentDir, "models.json");
    await fs.writeFile(modelsPath, "x".repeat(2 * 1024 * 1024)); // > MAX_MODELS_JSON_BYTES (1 MiB)
    await ensureOpenClawModelsJson(cfg, agentDir);
    expect(resolveImplicitProvidersCallCount).toBe(2);
  }, 30_000);
});
