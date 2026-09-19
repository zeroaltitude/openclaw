import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  // The implementation owns the human failure line under the same name, so the
  // terminal marker this wrapper writes reads as the same tool.
  exitTool: "check:changed",
  implementation: "./check-changed.mts",
});
