import { readSessionLaneAvailability } from "../../embedded-agent-runner/session-lane-availability.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

/** Parks a durable announcement before dispatch when its requester lane is occupied. */
export function resolveRequesterLaneBusyDeferral(params: {
  enabled?: boolean;
  requesterSessionKey: string;
  runId: string;
  log: (message: string) => void;
}): SubagentAnnounceDeliveryResult | undefined {
  if (!params.enabled) {
    return undefined;
  }
  const requesterLane = readSessionLaneAvailability(params.requesterSessionKey);
  if (!requesterLane.busy) {
    return undefined;
  }
  params.log(
    `Subagent announce deferred (requester lane busy) run=${params.runId} ` +
      `lane=${requesterLane.lane} activeCount=${requesterLane.activeCount} ` +
      `queuedCount=${requesterLane.queuedCount} blockedBy=${requesterLane.blockedBy ?? "lane"}`,
  );
  return {
    delivered: false,
    path: "none",
    reason: "requester_lane_busy",
    disposition: "deferred_requester_busy",
  };
}
