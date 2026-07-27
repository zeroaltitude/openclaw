// Source-route verification tests: an explicit-route `message` send that lands in
// the current source conversation must be recognized as a source reply, because
// loopback-MCP harnesses never receive the gateway's trusted current-source route
// tag and would otherwise trip stranded-reply recovery after a successful send.
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { messagingSendResolvesToCurrentSource } from "./embedded-agent-subscribe.tools.js";

const CURRENT_CHANNEL = "1466848931131559958";
const OTHER_CHANNEL = "937068502190293083";

const options = {
  currentChannelId: CURRENT_CHANNEL,
  currentMessagingTarget: CURRENT_CHANNEL,
} as const;

describe("messagingSendResolvesToCurrentSource", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          plugin: {
            ...createChannelTestPluginBase({ id: "discord" }),
            messaging: { normalizeTarget: (raw: string) => raw.trim().toLowerCase() },
          },
          source: "test",
        },
      ]),
    );
  });

  it("accepts an explicit-route send aimed at the current source", () => {
    expect(
      messagingSendResolvesToCurrentSource(
        "message",
        { action: "send", target: CURRENT_CHANNEL, message: "hi" },
        options,
      ),
    ).toBe(true);
  });

  it("rejects an explicit-route send aimed at another conversation", () => {
    expect(
      messagingSendResolvesToCurrentSource(
        "message",
        { action: "send", target: OTHER_CHANNEL, message: "hi" },
        options,
      ),
    ).toBe(false);
  });

  it("accepts an explicit-route send that also names its transport", () => {
    // A named `channel` hint must not defeat the comparison: the routeless
    // baseline would otherwise resolve provider "message" and mismatch.
    expect(
      messagingSendResolvesToCurrentSource(
        "message",
        { action: "send", channel: "discord", target: CURRENT_CHANNEL, message: "hi" },
        options,
      ),
    ).toBe(true);
  });

  it("rejects an explicitly cross-account send to the same target", () => {
    expect(
      messagingSendResolvesToCurrentSource(
        "message",
        { action: "send", target: CURRENT_CHANNEL, accountId: "secondary", message: "hi" },
        options,
      ),
    ).toBe(false);
  });

  it("accepts a routeless send", () => {
    expect(
      messagingSendResolvesToCurrentSource("message", { action: "send", message: "hi" }, options),
    ).toBe(true);
  });

  it("rejects when the session has no resolvable current source", () => {
    expect(
      messagingSendResolvesToCurrentSource("message", {
        action: "send",
        target: CURRENT_CHANNEL,
        message: "hi",
      }),
    ).toBe(false);
  });

  it("rejects non-message tools", () => {
    expect(
      messagingSendResolvesToCurrentSource(
        "conversations_send",
        { conversationRef: "conv_0123456789abcdef0123456789abcdef", message: "hi" },
        options,
      ),
    ).toBe(false);
  });

  it("does not consume a single-use reply-to while probing the route", () => {
    // The probe resolves targets twice. Carrying `hasRepliedRef` into the
    // auto-thread resolver could flip it, burning the turn's one reply-to.
    const hasRepliedRef = { value: false };
    expect(
      messagingSendResolvesToCurrentSource(
        "message",
        { action: "send", channel: "discord", target: CURRENT_CHANNEL, message: "hi" },
        { ...options, replyToMode: "first", currentMessageId: "42", hasRepliedRef },
      ),
    ).toBe(true);
    expect(hasRepliedRef.value).toBe(false);
  });
});
