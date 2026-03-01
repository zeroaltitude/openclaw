import {
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveStorePath,
} from "../../../config/sessions.js";
import {
  getThreadBindingManager,
  type ThreadBindingRecord,
} from "../../../discord/monitor/thread-bindings.js";
import {
  sendMessageDiscord,
  sendPollDiscord,
  sendWebhookMessageDiscord,
} from "../../../discord/send.js";
import { parseDiscordTarget } from "../../../discord/targets.js";
import type { OutboundIdentity } from "../../../infra/outbound/identity.js";
import { deliveryContextFromSession } from "../../../utils/delivery-context.js";
import type { ChannelOutboundAdapter } from "../types.js";

/**
 * Try to resolve a Discord delivery target from the main session's last
 * delivery context. This handles the case where a cron job or announce flow
 * specifies a bare user ID but the session already knows the DM channel.
 */
function resolveDiscordTargetFromSession(
  cfg: import("../../../config/config.js").OpenClawConfig | undefined,
): string | undefined {
  if (!cfg) {
    return undefined;
  }
  try {
    const mainKey = resolveAgentMainSessionKey({ cfg, agentId: "main" });
    const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
    const store = loadSessionStore(storePath);
    const entry = store[mainKey];
    const ctx = deliveryContextFromSession(entry);
    if (ctx?.to && ctx.channel === "discord") {
      return ctx.to;
    }
  } catch {
    // Session lookup failed — no fallback available
  }
  return undefined;
}

function resolveDiscordOutboundTarget(params: {
  to: string;
  threadId?: string | number | null;
}): string {
  if (params.threadId == null) {
    return params.to;
  }
  const threadId = String(params.threadId).trim();
  if (!threadId) {
    return params.to;
  }
  return `channel:${threadId}`;
}

function resolveDiscordWebhookIdentity(params: {
  identity?: OutboundIdentity;
  binding: ThreadBindingRecord;
}): { username?: string; avatarUrl?: string } {
  const usernameRaw = params.identity?.name?.trim();
  const fallbackUsername = params.binding.label?.trim() || params.binding.agentId;
  const username = (usernameRaw || fallbackUsername || "").slice(0, 80) || undefined;
  const avatarUrl = params.identity?.avatarUrl?.trim() || undefined;
  return { username, avatarUrl };
}

async function maybeSendDiscordWebhookText(params: {
  text: string;
  threadId?: string | number | null;
  accountId?: string | null;
  identity?: OutboundIdentity;
  replyToId?: string | null;
}): Promise<{ messageId: string; channelId: string } | null> {
  if (params.threadId == null) {
    return null;
  }
  const threadId = String(params.threadId).trim();
  if (!threadId) {
    return null;
  }
  const manager = getThreadBindingManager(params.accountId ?? undefined);
  if (!manager) {
    return null;
  }
  const binding = manager.getByThreadId(threadId);
  if (!binding?.webhookId || !binding?.webhookToken) {
    return null;
  }
  const persona = resolveDiscordWebhookIdentity({
    identity: params.identity,
    binding,
  });
  const result = await sendWebhookMessageDiscord(params.text, {
    webhookId: binding.webhookId,
    webhookToken: binding.webhookToken,
    accountId: binding.accountId,
    threadId: binding.threadId,
    replyTo: params.replyToId ?? undefined,
    username: persona.username,
    avatarUrl: persona.avatarUrl,
  });
  return result;
}

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,
  pollMaxOptions: 10,
  resolveTarget: ({ cfg, to, allowFrom: _allowFrom, mode }) => {
    const trimmed = to?.trim() ?? "";
    if (!trimmed) {
      // Implicit mode: try to resolve from session's last delivery context
      if (mode === "implicit" || mode === "heartbeat") {
        const fallback = resolveDiscordTargetFromSession(cfg);
        if (fallback) {
          return { ok: true, to: fallback };
        }
      }
      return {
        ok: false,
        error: new Error(
          'Discord target is required. Use "user:<id>" for DMs or "channel:<id>" for channel messages.',
        ),
      };
    }
    // Validate the target by parsing it — this catches ambiguous bare numeric IDs early
    // instead of failing silently at send time.
    try {
      const parsed = parseDiscordTarget(trimmed);
      if (parsed) {
        // Re-format with the proper prefix so downstream send never sees ambiguous IDs
        return { ok: true, to: `${parsed.kind}:${parsed.id}` };
      }
      // parseDiscordTarget returns undefined only for empty input (handled above)
      return { ok: true, to: trimmed };
    } catch (err) {
      // Only fall back to session context for genuinely ambiguous bare numeric IDs.
      // Other parse errors (e.g. @invalidUser) should surface immediately.
      const isAmbiguousNumeric = /^\d+$/.test(trimmed);
      if (isAmbiguousNumeric) {
        const fallback = resolveDiscordTargetFromSession(cfg);
        if (fallback) {
          return { ok: true, to: fallback };
        }
      }
      return {
        ok: false,
        error:
          err instanceof Error
            ? err
            : new Error(
                `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`,
              ),
      };
    }
  },
  sendText: async ({ to, text, accountId, deps, replyToId, threadId, identity, silent }) => {
    if (!silent) {
      const webhookResult = await maybeSendDiscordWebhookText({
        text,
        threadId,
        accountId,
        identity,
        replyToId,
      }).catch(() => null);
      if (webhookResult) {
        return { channel: "discord", ...webhookResult };
      }
    }
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const target = resolveDiscordOutboundTarget({ to, threadId });
    const result = await send(target, text, {
      verbose: false,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendMedia: async ({
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
    silent,
  }) => {
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const target = resolveDiscordOutboundTarget({ to, threadId });
    const result = await send(target, text, {
      verbose: false,
      mediaUrl,
      mediaLocalRoots,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendPoll: async ({ to, poll, accountId, threadId, silent }) => {
    const target = resolveDiscordOutboundTarget({ to, threadId });
    return await sendPollDiscord(target, poll, {
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
    });
  },
};
