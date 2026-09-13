const SLOW_PLUGIN_LOAD_WARN_MS = 1_000;
const SLOW_PLUGIN_CANDIDATE_WARN_MS = 50;
const MAX_SLOW_PLUGIN_CANDIDATES = 10;

export type PluginLoadTiming = readonly [id: string, elapsedMs: number];

export function formatSlowPluginDiscoveryWarning(params: {
  elapsedMs: number;
  candidateCount: number;
}): string | undefined {
  if (params.elapsedMs <= SLOW_PLUGIN_LOAD_WARN_MS) {
    return undefined;
  }
  return `[plugins] slow discovery: total=${params.elapsedMs.toFixed(0)}ms candidates=${params.candidateCount}`;
}

export function formatSlowPluginRegistryWarning(params: {
  elapsedMs: number;
  pluginCount: number;
  attemptedCount: number;
  runtimeSubagentMode: string;
  timings: readonly PluginLoadTiming[];
}): string | undefined {
  if (params.elapsedMs <= SLOW_PLUGIN_LOAD_WARN_MS) {
    return undefined;
  }
  const slowest = params.timings
    .filter(([, elapsedMs]) => elapsedMs >= SLOW_PLUGIN_CANDIDATE_WARN_MS)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, MAX_SLOW_PLUGIN_CANDIDATES)
    .map(([id, elapsedMs]) => `${id}=${elapsedMs.toFixed(0)}ms`)
    .join(" ");
  return (
    `[plugins] slow registry load: total=${params.elapsedMs.toFixed(0)}ms ` +
    `plugins=${params.pluginCount} attempted=${params.attemptedCount} ` +
    `subagentMode=${params.runtimeSubagentMode} ` +
    `slowest=${slowest || "none-above-50ms"}`
  );
}
