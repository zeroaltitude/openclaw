# @openclaw/claude

OpenClaw harness plugin that delegates Anthropic-provider turns to a local
`@openclaw/claude-app-server` process via the codex-shaped JSON-RPC protocol.

## Architecture

This package is the **in-tree client bridge** to an external JSON-RPC server.
Three pieces, two repos:

| Component                                    | Repo                        | Package                                  |
| -------------------------------------------- | --------------------------- | ---------------------------------------- |
| Client bridge (this package)                 | `openclaw/openclaw`         | `@openclaw/claude` (bundled extension)   |
| Plugin manifest + harness wiring             | `openclaw/openclaw-plugins` | `@openclaw/claude` (plugin distribution) |
| **JSON-RPC server** (spawned by this bridge) | `openclaw/openclaw-plugins` | `@openclaw/claude-app-server`            |

The directory name `src/app-server/` mirrors `extensions/codex/src/app-server/`
for visual symmetry with the codex extension. In both cases the directory
holds the **client side** of the codex-app-server protocol; the actual
server is an external binary spawned over stdio. Codex's server is
`@openai/codex` (third-party); ours is `@openclaw/claude-app-server`
(ours).

## Runtime dependency on `@openclaw/claude-app-server`

This bridge spawns `openclaw-claude-app-server` (the binary published by
`@openclaw/claude-app-server`) at turn-start. Without that binary on PATH
or in `node_modules/.bin`, the harness cannot run.

**Pre-release status**: `@openclaw/claude-app-server` is not yet on the
npm registry. Until 0.1.0 publishes, install it from
`openclaw/openclaw-plugins/openclaw-claude/server/` (path or git install)
and ensure `openclaw-claude-app-server` resolves on PATH. After publish,
this package will declare `"@openclaw/claude-app-server": "0.1.0"` as a
regular dependency and `npm install @openclaw/claude` will pull the
binary in automatically. Tracked separately from the bundled-extension
release cadence.

If a turn fails with `claude-app-server is not initialized` or
`spawn openclaw-claude-app-server ENOENT`, the most likely cause is a
missing server binary — confirm `which openclaw-claude-app-server`
returns a path before debugging further.

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
