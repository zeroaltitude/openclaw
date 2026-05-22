import { beforeEach, describe, expect, it, vi } from "vitest";

const normalizeProviderModelIdWithPluginMock = vi.fn();
const emptyPluginMetadataSnapshot = vi.hoisted(() => ({
  configFingerprint: "model-selection-plugin-runtime-test-empty-plugin-metadata",
  plugins: [
    {
      modelIdNormalization: {
        providers: {
          google: {
            aliases: {
              "gemini-3.1-pro": "gemini-3.1-pro-preview",
            },
          },
        },
      },
    },
  ],
}));

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithPluginMock(params),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));

describe("model-selection plugin runtime normalization", () => {
  beforeEach(() => {
    vi.resetModules();
    normalizeProviderModelIdWithPluginMock.mockReset();
  });

  it("delegates provider-owned model id normalization to plugin runtime hooks", async () => {
    normalizeProviderModelIdWithPluginMock.mockImplementation(({ provider, context }) => {
      if (
        provider === "custom-provider" &&
        (context as { modelId?: string }).modelId === "custom-legacy-model"
      ) {
        return "custom-modern-model";
      }
      return undefined;
    });

    const { parseModelRef } = await import("./model-selection.js");

    expect(parseModelRef("custom-legacy-model", "custom-provider")).toEqual({
      provider: "custom-provider",
      model: "custom-modern-model",
    });
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledWith({
      provider: "custom-provider",
      context: {
        provider: "custom-provider",
        modelId: "custom-legacy-model",
      },
    });
  });

  it("keeps static normalization while skipping plugin runtime hooks when disabled", async () => {
    const { parseModelRef } = await import("./model-selection.js");

    expect(
      parseModelRef("gemini-3.1-pro", "google", {
        allowPluginNormalization: false,
      }),
    ).toEqual({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    expect(normalizeProviderModelIdWithPluginMock).not.toHaveBeenCalled();
  });

  it("forwards manifestPlugins to the runtime normalization call so it can skip the slot-or-load disk walk", async () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue(undefined);
    const preparedPlugins = [
      {
        modelIdNormalization: {
          providers: {
            custom: { prefixWhenBare: "prepared" },
          },
        },
      },
    ];
    const { normalizeModelRef } = await import("./model-selection-normalize.js");
    normalizeModelRef("custom", "my-model", { manifestPlugins: preparedPlugins });
    expect(normalizeProviderModelIdWithPluginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "custom",
        plugins: preparedPlugins,
      }),
    );
  });

  it("omits plugins from the runtime call when no manifestPlugins are prepared (preserves current behavior)", async () => {
    normalizeProviderModelIdWithPluginMock.mockReturnValue(undefined);
    const { normalizeModelRef } = await import("./model-selection-normalize.js");
    normalizeModelRef("custom", "my-model");
    const callArgs = normalizeProviderModelIdWithPluginMock.mock.calls[0]?.[0] as
      | { plugins?: unknown }
      | undefined;
    expect(callArgs).toBeDefined();
    expect(callArgs?.plugins).toBeUndefined();
  });
});
