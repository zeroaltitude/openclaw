// Core engine tests for the background-activity indicator: pure diffing
// logic against faked sources/channel target (the real production sources
// are proven separately in background-activity-sources.test.ts against the
// real registries), plus a coexistence proof against the real turn-bound
// `TypingController` to pin that the two never share state or cross-invoke.
import { describe, expect, it, vi } from "vitest";
import { createTypingController } from "../auto-reply/reply/typing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createBackgroundActivityIndicator,
  type BackgroundActivitySources,
} from "./background-activity-indicator.js";

function createMutableSources() {
  let running: string[] = [];
  let subagent: string[] = [];
  let cron: string[] = [];
  const sources: BackgroundActivitySources = {
    listRunningTaskFlowSessionKeys: () => running,
    listArmedSubagentWaitSessionKeys: () => subagent,
    listArmedCronWakeSessionKeys: () => cron,
  };
  return {
    sources,
    setRunning: (keys: string[]) => {
      running = keys;
    },
    setSubagent: (keys: string[]) => {
      subagent = keys;
    },
    setCron: (keys: string[]) => {
      cron = keys;
    },
  };
}

function createFakePlugin() {
  const sendTyping = vi.fn(async () => undefined);
  const clearTyping = vi.fn(async () => undefined);
  return { plugin: { heartbeat: { sendTyping, clearTyping } }, sendTyping, clearTyping };
}

describe("createBackgroundActivityIndicator", () => {
  it("activates a session's channel indicator once its running TaskFlow is discovered", async () => {
    const { sources, setRunning } = createMutableSources();
    setRunning(["agent:main:s1"]);
    const { plugin, sendTyping } = createFakePlugin();
    const indicator = createBackgroundActivityIndicator({
      isAvailable: () => true,
      sources,
      target: {
        getConfig: () => ({}) as OpenClawConfig,
        resolveDelivery: (sessionKey) =>
          sessionKey === "agent:main:s1" ? { channel: "discord", to: "chan-1" } : undefined,
        resolveChannelPlugin: () => plugin,
      },
    });
    await indicator.tick();
    expect(indicator.isActiveForSession("agent:main:s1")).toBe(true);
    expect(sendTyping).toHaveBeenCalledTimes(1);
    indicator.stop();
  });

  it("activates a session's channel indicator once an armed subagent wait is discovered", async () => {
    const { sources, setSubagent } = createMutableSources();
    setSubagent(["agent:main:s2"]);
    const { plugin, sendTyping } = createFakePlugin();
    const indicator = createBackgroundActivityIndicator({
      isAvailable: () => true,
      sources,
      target: {
        getConfig: () => ({}) as OpenClawConfig,
        resolveDelivery: (sessionKey) =>
          sessionKey === "agent:main:s2" ? { channel: "discord", to: "chan-2" } : undefined,
        resolveChannelPlugin: () => plugin,
      },
    });
    await indicator.tick();
    expect(indicator.isActiveForSession("agent:main:s2")).toBe(true);
    expect(sendTyping).toHaveBeenCalledTimes(1);
    indicator.stop();
  });

  it("activates a session's channel indicator once an armed cron wake is discovered", async () => {
    const { sources, setCron } = createMutableSources();
    setCron(["agent:main:s3"]);
    const { plugin, sendTyping } = createFakePlugin();
    const indicator = createBackgroundActivityIndicator({
      isAvailable: () => true,
      sources,
      target: {
        getConfig: () => ({}) as OpenClawConfig,
        resolveDelivery: (sessionKey) =>
          sessionKey === "agent:main:s3" ? { channel: "discord", to: "chan-3" } : undefined,
        resolveChannelPlugin: () => plugin,
      },
    });
    await indicator.tick();
    expect(indicator.isActiveForSession("agent:main:s3")).toBe(true);
    expect(sendTyping).toHaveBeenCalledTimes(1);
    indicator.stop();
  });

  it("deactivates a session once none of the three sources report it armed anymore", async () => {
    const { sources, setRunning } = createMutableSources();
    setRunning(["agent:main:s4"]);
    const { plugin, sendTyping, clearTyping } = createFakePlugin();
    const indicator = createBackgroundActivityIndicator({
      isAvailable: () => true,
      sources,
      target: {
        getConfig: () => ({}) as OpenClawConfig,
        resolveDelivery: (sessionKey) =>
          sessionKey === "agent:main:s4" ? { channel: "discord", to: "chan-4" } : undefined,
        resolveChannelPlugin: () => plugin,
      },
    });

    await indicator.tick();
    expect(indicator.isActiveForSession("agent:main:s4")).toBe(true);
    expect(sendTyping).toHaveBeenCalledTimes(1);

    setRunning([]);
    await indicator.tick();
    expect(indicator.isActiveForSession("agent:main:s4")).toBe(false);
    expect(clearTyping).toHaveBeenCalledTimes(1);
    indicator.stop();
  });

  it("stops every active session when the gateway instance becomes unavailable", async () => {
    const { sources, setRunning } = createMutableSources();
    setRunning(["agent:main:s5"]);
    const { plugin, clearTyping } = createFakePlugin();
    let available = true;
    const indicator = createBackgroundActivityIndicator({
      isAvailable: () => available,
      sources,
      target: {
        getConfig: () => ({}) as OpenClawConfig,
        resolveDelivery: () => ({ channel: "discord", to: "chan-5" }),
        resolveChannelPlugin: () => plugin,
      },
    });
    await indicator.tick();
    expect(indicator.isActiveForSession("agent:main:s5")).toBe(true);

    available = false;
    await indicator.tick();
    expect(indicator.isActiveForSession("agent:main:s5")).toBe(false);
    expect(clearTyping).toHaveBeenCalledTimes(1);
  });

  it("never activates or interferes with the turn-bound TypingController's seal-after-completion guarantee", async () => {
    // The turn-bound controller: start it, finish its turn, and let it seal --
    // exactly the "late/stray event after completion" guarantee it exists for.
    const turnOnReplyStart = vi.fn(async () => undefined);
    const turnOnCleanup = vi.fn(() => undefined);
    const turnBound = createTypingController({
      onReplyStart: turnOnReplyStart,
      onCleanup: turnOnCleanup,
      typingIntervalSeconds: 0,
    });
    await turnBound.startTypingLoop();
    expect(turnOnReplyStart).toHaveBeenCalledTimes(1);
    turnBound.markRunComplete();
    turnBound.markDispatchIdle();
    expect(turnOnCleanup).toHaveBeenCalledTimes(1);
    expect(turnBound.isActive()).toBe(false);

    // A late/stray event after completion must still never restart it.
    await turnBound.startTypingOnText("late stray text");
    expect(turnOnReplyStart).toHaveBeenCalledTimes(1);
    expect(turnBound.isActive()).toBe(false);

    // Independently, the background indicator activates and deactivates its
    // own instance for the same conceptual destination -- proving the two
    // mechanisms share no state and never call into one another.
    const { sources, setRunning } = createMutableSources();
    setRunning(["agent:main:s6"]);
    const { plugin, sendTyping, clearTyping } = createFakePlugin();
    const indicator = createBackgroundActivityIndicator({
      isAvailable: () => true,
      sources,
      target: {
        getConfig: () => ({}) as OpenClawConfig,
        resolveDelivery: () => ({ channel: "discord", to: "chan-6" }),
        resolveChannelPlugin: () => plugin,
      },
    });
    await indicator.tick();
    expect(sendTyping).toHaveBeenCalledTimes(1);
    setRunning([]);
    await indicator.tick();
    expect(clearTyping).toHaveBeenCalledTimes(1);

    // The turn-bound controller's sealed state is untouched by any of that.
    expect(turnOnReplyStart).toHaveBeenCalledTimes(1);
    expect(turnOnCleanup).toHaveBeenCalledTimes(1);
    expect(turnBound.isActive()).toBe(false);
  });
});
