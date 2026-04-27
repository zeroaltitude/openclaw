import type { PluginHookAgentContext } from "../../plugins/hook-types.js";

export type AgentHarnessHookContext = {
  runId: string;
  jobId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
  /** Original message platform (e.g. "slack", "discord"). Distinct from
   *  messageProvider, which may reflect routing/delivery channel. Plugins
   *  use this for security classification (e.g. provenance taint origin). */
  sourceProvider?: string;
  /** Sender's platform-specific ID (e.g. Discord user ID, Slack user ID). */
  senderId?: string | null;
  /** Sender's display name. */
  senderName?: string | null;
  /** Whether the sender is a configured owner (from ownerNumbers). */
  senderIsOwner?: boolean;
  /** Group/channel ID if this is a group chat (null for DMs and non-group sessions). */
  groupId?: string | null;
  /** Parent session key if this is a sub-agent session. */
  spawnedBy?: string | null;
};

export function buildAgentHookContext(params: AgentHarnessHookContext): PluginHookAgentContext {
  return {
    runId: params.runId,
    ...(params.jobId ? { jobId: params.jobId } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.modelProviderId ? { modelProviderId: params.modelProviderId } : {}),
    ...(params.modelId ? { modelId: params.modelId } : {}),
    ...(params.messageProvider ? { messageProvider: params.messageProvider } : {}),
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(params.channelId ? { channelId: params.channelId } : {}),
    // Identity context. `senderIsOwner` is a boolean so we must explicitly
    // forward `false` (the legacy `?` truthy-spread would drop it).
    // `senderId`, `senderName`, `groupId`, `spawnedBy` are nullable strings;
    // forward them whenever they are non-undefined so plugins can distinguish
    // "explicitly null" (no sender / not a sub-agent) from "unset".
    ...(params.sourceProvider ? { sourceProvider: params.sourceProvider } : {}),
    ...(params.senderId !== undefined ? { senderId: params.senderId } : {}),
    ...(params.senderName !== undefined ? { senderName: params.senderName } : {}),
    ...(params.senderIsOwner !== undefined ? { senderIsOwner: params.senderIsOwner } : {}),
    ...(params.groupId !== undefined ? { groupId: params.groupId } : {}),
    ...(params.spawnedBy !== undefined ? { spawnedBy: params.spawnedBy } : {}),
  };
}
