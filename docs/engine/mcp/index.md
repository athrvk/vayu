---
description: >-
  Vayu's built-in MCP server: the tools, resources and prompts it exposes to coding agents, how to register it, and the safety gates.
---

# Vayu MCP Server

**Endpoint:** `http://127.0.0.1:9877/mcp` by default (Streamable HTTP) · **Also:** stdio CLI

Vayu exposes its engine to AI agents (Claude Code, Cursor, VS Code, Codex, Zed) through a [Model Context Protocol](https://modelcontextprotocol.io) server.
The server is TypeScript, hosted in the Electron main process, built on the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (v2: `@modelcontextprotocol/server`), and proxies the engine's REST API on `:9876` (or the fallback port the app chose when 9876 was held; see `VAYU_ENGINE_URL` in [Configuration](configuration.md#configuration)).
The MCP layer lives entirely in the app and is Apache-2.0 like the rest of it; the C++ engine's one part is refusing to send a request to the MCP port (its `--mcp-port`, 9877 by default; see [the daemon flags](../cli.md#prerequisites)).

Once Vayu is running, any agent opts in with one command; with MCP switched off or Vayu closed, nothing listens, the connection is refused and the agent's client shows its own connection error.
Threat model and posture: [`SECURITY.md`](https://github.com/athrvk/vayu/blob/master/SECURITY.md).

## Overview

- **Hosted in the app.**
  MCP is a capability the running app exposes, not a separate process to manage.
  It is started and stopped alongside the engine sidecar by `app/electron/main.ts`, best-effort (a bind failure logs, the app continues without it, and `mcp:status` reports why so Settings can show it: another program holding the port is named, and no endpoint is offered while nothing is listening).
  Until the first start has bound or failed, the status carries `starting: true` and no error, and Settings says "Starting" with no port and no Retry, re-reading the status until it settles (#3579).
  Only the port is bound at launch (`listener.ts`, which imports no SDK); the SDK, the tool registry and the service are loaded by the first `POST /mcp` that arrives, so a launch no agent connects to never evaluates them - 5-7 MB of the main process at idle, measured on the packaged Windows app.
- **Proxy, not a second source of truth.**
  Every tool maps to an existing engine endpoint via a thin `fetch` client (`engine-client.ts`).
  The main process cannot import the renderer's `@/services`, so this client is standalone.
- **Local-only.**
  Binds `127.0.0.1`, with Host- and Origin-header (DNS-rebinding) validation on `/mcp`.
- **Configurable from Settings.**
  Server on/off, the port, the allowlist, caps, the write toggle, and per-tool switches live in **Settings → MCP** and persist across restarts.
  A new port takes effect after an engine restart, which the panel offers, and changes the endpoint URL: an agent registered with the old one has to be connected again.

## Connecting

Ensure Vayu is running, then register the endpoint once per machine.
In the app, **Settings → MCP** offers a one-click **Connect** for Claude Code and VS Code (shells out to their CLIs) and copyable snippets for the rest.

Connect resolves the client CLI before running it, because a GUI-launched app often has a stripped PATH.
On macOS and Linux that means the login shell (`$SHELL -lc`, falling back to `/bin/sh -lc` for a shell that does not accept `-lc`); on Windows it means `where`, preferring an `.exe` and then a `.cmd` shim over the extensionless POSIX script VS Code also installs.
A `.cmd`/`.bat` shim is run through `cmd.exe`, which Node has required since 20.12.
If the CLI is not installed, or the run fails for any reason, Connect says so and the snippet below it is the manual path.

Connect is safe to click again.
For Claude Code it first runs `claude mcp get vayu` and reads only whether the exact endpoint URL appears in the output: if it does, nothing is run and the panel says Vayu is already connected.
The URL alone decides this, not the scope: a project- or local-scoped entry with the same URL counts.
If `vayu` is registered with a different URL (the engine moved ports), the old entry is removed at user scope and the new one added.
That replace is remove then add, not atomic: should the add fail, the old entry is already gone and the error names the earlier registration as gone.
If `get` fails, Connect adds as usual.
VS Code has no lookup command, so its Connect always runs `--add-mcp`.

The snippets below use the default port, 9877.
If the port was changed, use the endpoint **Settings → MCP** shows; Connect and the panel's own snippets already do.

```bash
# Claude Code (or click Connect in Settings → MCP)
claude mcp add --transport http --scope user vayu http://127.0.0.1:9877/mcp
```

```json
// Claude Code (.mcp.json) / Cursor (.cursor/mcp.json)
{
  "mcpServers": {
    "vayu": { "type": "http", "url": "http://127.0.0.1:9877/mcp" }
  }
}
```

```json
// VS Code (.vscode/mcp.json) - note the "servers" key
{
  "servers": { "vayu": { "type": "http", "url": "http://127.0.0.1:9877/mcp" } }
}
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.vayu]
url = "http://127.0.0.1:9877/mcp"
```

### Client compatibility

MCP defines three transports: **stdio**, **Streamable HTTP**, and the legacy **HTTP+SSE** (deprecated; not built for).
The Streamable HTTP endpoint covers most clients with a single URL; Zed (stdio-only) uses [the CLI](transports.md#stdio-cli-zed--headless--ci).

| Client           | Streamable HTTP    | stdio | Config location                                 |
| ---------------- | ------------------ | ----- | ----------------------------------------------- |
| **Claude Code**  | ✅ (`http`)        | ✅    | `.mcp.json`, `~/.claude.json`, `claude mcp add` |
| **Cursor**       | ✅                 | ✅    | `.cursor/mcp.json`, `~/.cursor/mcp.json`        |
| **VS Code**      | ✅ (`servers` key) | ✅    | `.vscode/mcp.json`                              |
| **OpenAI Codex** | ✅                 | ✅    | `~/.codex/config.toml`                          |
| **Zed**          | ❌ not yet         | ✅    | `context_servers` (stdio CLI)                   |

## Where the rest is

- [Transports](transports.md): Streamable HTTP, the stdio CLI, and what is live on each.
- [Tools](tools.md): every tool, generated from the registry, with the count.
- [Tool conventions](conventions.md): categories, schemas, result format and error results.
- Notes on the tools by family: [load runs and specs](load-and-specs.md), [runs and reports](runs-and-reports.md), [writes to saved data](saved-data.md), [collection runs, OAuth and local services](collection-runs-and-mocks.md) and [request composition](request-composition.md).
- [Resources and prompts](resources-and-prompts.md).
- [Safety model](safety.md) and [secret values](secrets.md).
- [Configuration](configuration.md) of the stdio CLI.
- [Internals](internals.md): architecture and design notes, for contributors.
