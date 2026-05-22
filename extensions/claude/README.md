# @openclaw/claude

OpenClaw harness plugin that delegates Anthropic-provider turns to a local
`@zeroaltitude/openclaw-claude-bridge` process via the codex-shaped JSON-RPC
protocol.

## Architecture

This package is the **in-tree client bridge** to an external JSON-RPC server.
Three pieces, two repos:

| Component                                    | Repo                        | Package                                  |
| -------------------------------------------- | --------------------------- | ---------------------------------------- |
| Client bridge (this package)                 | `openclaw/openclaw`         | `@openclaw/claude` (bundled extension)   |
| Plugin manifest + harness wiring             | `openclaw/openclaw-plugins` | `@openclaw/claude` (plugin distribution) |
| **JSON-RPC server** (spawned by this bridge) | `openclaw/openclaw-plugins` | `@zeroaltitude/openclaw-claude-bridge`   |

The directory name `src/app-server/` mirrors `extensions/codex/src/app-server/`
for visual symmetry with the codex extension. In both cases the directory
holds the **client side** of the codex-app-server protocol; the actual
server is an external binary spawned over stdio. Codex's server is
`@openai/codex` (third-party); ours is `@zeroaltitude/openclaw-claude-bridge`
(fork-preview publish path; will migrate to `@zeroaltitude/openclaw-claude-bridge`
once the upstream PR lands and maintainers republish).

## Runtime dependency on the server

This bridge spawns `openclaw-claude-bridge` (the binary published by
[`@zeroaltitude/openclaw-claude-bridge`](https://www.npmjs.com/package/@zeroaltitude/openclaw-claude-bridge))
at turn-start. The server package is declared as a regular dependency in
`extensions/claude/package.json`, so installing `@openclaw/claude` pulls
the binary into `node_modules/.bin/openclaw-claude-bridge`
automatically — no separate install step needed.

The `@zeroaltitude` scope is a fork-preview publish path. Once the
upstream OpenClaw PR lands and maintainers republish under
`@zeroaltitude/openclaw-claude-bridge`, this dependency will switch to the
`@openclaw` scope in a future patch.

If a turn fails with `claude-bridge is not initialized` or
`spawn openclaw-claude-bridge ENOENT`, the most likely cause is a
broken install — confirm `which openclaw-claude-bridge` (or
`ls node_modules/.bin/openclaw-claude-bridge` from the OpenClaw
checkout root) returns a path before debugging further.

## Slash commands

This extension registers `/claude` with subcommands:

- `/claude status` — shared-client liveness + last server stderr
- `/claude version` — bridge + installed server package versions
- `/claude threads` — the active session's `.claude-binding.json` sidecar
- `/claude resume <thread_id>` — rotate the session's binding to a specific thread
- `/claude help` — subcommand listing (default when no args)

## Hot-path features

- **Rate-limit surfacing** (server-side): Anthropic 429 metadata is parsed
  and folded into the user-visible error message (server's `rate-limits.ts`).
- **Image payload sanitizer** (server-side): pre-flight validates image
  content blocks against Anthropic's 5 MB / 100-images-per-request limits
  before they hit the API (server's `image-payload-sanitizer.ts`).
- **Plugin inventory + thread config** (server-side): captures plugin tool
  inventories per thread so resume can detect catalog drift (server's
  `plugin-inventory.ts` + `plugin-thread-config.ts`).
- **Vision tools filter** (bridge-side): when the model has native vision
  AND the turn carries inbound images, the redundant `image` tool is
  filtered out (`src/app-server/vision-tools.ts`).
- **Doctor contract** (bridge-side): legacy-config rules and session-route
  ownership consumed by `openclaw doctor` (`doctor-contract-api.ts`).
