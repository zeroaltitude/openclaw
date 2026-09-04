// Discord tests cover successful typing feedback observation.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { RequestClient } from "../internal/discord.js";
import { createDiscordReplyTypingFeedback } from "./reply-typing-feedback.js";

function createFeedback(params: {
  post: ReturnType<typeof vi.fn>;
  onStartSuccess: () => void;
  log: (message: string) => void;
}) {
  const rest = new RequestClient("test-token");
  vi.spyOn(rest, "post").mockImplementation(params.post);
  return createDiscordReplyTypingFeedback({
    cfg: {} as OpenClawConfig,
    token: "test-token",
    accountId: "default",
    channelId: "12345",
    rest,
    log: params.log,
    onStartSuccess: params.onStartSuccess,
    keepaliveIntervalMs: 0,
  });
}

describe("createDiscordReplyTypingFeedback", () => {
  it("observes a typing start only after Discord accepts it", async () => {
    const onStartSuccess = vi.fn();
    const feedback = createFeedback({
      post: vi.fn().mockResolvedValue(undefined),
      onStartSuccess,
      log: vi.fn(),
    });

    await feedback.onReplyStart();

    await vi.waitFor(() => expect(onStartSuccess).toHaveBeenCalledTimes(1));
    feedback.onCleanup?.();
  });

  it("does not report success when Discord rejects the typing start", async () => {
    const onStartSuccess = vi.fn();
    const log = vi.fn();
    const feedback = createFeedback({
      post: vi.fn().mockRejectedValue(new Error("typing denied")),
      onStartSuccess,
      log,
    });

    await feedback.onReplyStart();

    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(onStartSuccess).not.toHaveBeenCalled();
    feedback.onCleanup?.();
  });
});
