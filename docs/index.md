---
title: Vayu
description: >-
  Free, open source API client for REST and GraphQL with a native load tester and an MCP server your coding agent can drive. Runs offline, no account.
hide:
  - navigation
  - toc
---

# Build the request. Load test it. Let your agent drive.

**Vayu** is a free, open source **API client for REST and GraphQL** with a
**native C++ load tester** built in - and an **MCP server** that hands the whole
engine to Claude Code, Cursor, VS Code, or Codex. One app instead of three, all
of it on your machine: no account, no cloud sync, no telemetry.

[Download Vayu](#install){ .md-button .md-button--primary }
[Use it from your agent](#drive-vayu-from-your-coding-agent){ .md-button }
[See what it does](#what-you-can-do){ .md-button }

![The load-test dashboard: throughput, latency percentiles and error counters streaming live from the C++ engine while the UI stays responsive.](images/vayu-loadtest.png){ .shot }

## Install

Windows (x64), macOS (universal), and Linux (AppImage). No account, no sign-in.

<!-- Keep these in step with the Download section of README.md, which is the
     canonical copy - both point at the same release assets and install.sh. -->

=== "macOS"

    ```sh
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/athrvk/vayu/master/install.sh)"
    ```

    Installs the latest release to `/Applications`, and asks for your password
    once. Vayu ships unsigned, so the script ad-hoc signs the app and clears the
    quarantine flag - without that, macOS reports it as damaged.

    Pin a version with `VAYU_VERSION=0.2.1` in front of the command, or
    uninstall by re-running it with `-- --uninstall`.

=== "Windows"

    1. Download [**Vayu-x64.exe**](https://github.com/athrvk/vayu/releases/latest/download/Vayu-x64.exe).
    2. Run the installer and follow the wizard.
    3. Launch **Vayu** from the Start menu.

=== "Linux"

    ```sh
    chmod +x Vayu-x86_64.AppImage
    ./Vayu-x86_64.AppImage
    ```

    Download [**Vayu-x86_64.AppImage**](https://github.com/athrvk/vayu/releases/latest/download/Vayu-x86_64.AppImage)
    first. It is self-contained: no wizard, no root.

[All releases](https://github.com/athrvk/vayu/releases){ .md-button }
[Build from source instead](building.md){ .md-button }

## What you can do

<div class="grid cards" markdown>

- :material-swap-horizontal: **Send REST and GraphQL requests**

    Every method, and JSON, form-data, URL-encoded, raw, or GraphQL bodies.
    Collections nest, with their own variables, auth, and scripts.

- :material-speedometer: **Load test without a second tool**

    A multi-worker C++ event loop drives the load and streams throughput,
    latency percentiles, and error counts live. See the
    [benchmarks](engine/benchmarks.md) against wrk and vegeta.

- :material-import: **Bring what you already have**

    Import Postman v2.0/v2.1, Insomnia v4, OpenAPI 3.0, and Swagger 2.0 -
    [what maps to what](app/import-collections/README.md).

- :material-code-braces: **Keep your Postman tests**

    A QuickJS runtime implements `pm.test()`, `pm.expect()`,
    `pm.environment.set()` and `pm.response.*`, so most scripts run unmodified.

- :material-key-variant: **Auth that inherits**

    Bearer, Basic, API key, and OAuth 2.0 (client credentials, password,
    authorization code + PKCE) - resolved engine-side, inherited down the tree.

- :material-robot-outline: **Hand it to your coding agent**

    A built-in MCP server exposes the engine to Claude Code, Cursor, VS Code,
    Codex and Zed - behind a host allowlist and load caps you set.
    [Drive Vayu from your agent](#drive-vayu-from-your-coding-agent).

- :material-shield-lock-outline: **Private by default**

    100% offline execution. No telemetry, no account, no cloud sync - your
    requests and secrets never leave the machine.

</div>

## How it fits together

Vayu is a **sidecar**: the Electron + React UI talks to a C++20 daemon over HTTP
on `127.0.0.1:9876`. That split is why the interface stays responsive while the
engine saturates a target - and why the engine can be driven on its own, from the
[command line](engine/cli.md) or by a coding agent over
[MCP](engine/mcp.md).

[How it works in full](architecture.md){ .md-button }

## Drive Vayu from your coding agent

Vayu ships an **MCP server**, so an agent can use the same engine the UI does -
send a request, start a load run, read the report, compare two runs. It runs
inside the app on `127.0.0.1:9877`, proxying the engine's REST API; there is no
second process to manage, and nothing leaves the machine.

=== "Claude Code"

    ```bash
    claude mcp add --transport http vayu http://127.0.0.1:9877/mcp
    ```

    Or click **Connect** in **Settings → MCP**, which shells out to the CLI for
    you.

=== "Cursor"

    ```json
    // .cursor/mcp.json
    {
      "mcpServers": {
        "vayu": { "type": "http", "url": "http://127.0.0.1:9877/mcp" }
      }
    }
    ```

=== "VS Code"

    ```json
    // .vscode/mcp.json - note the "servers" key, not "mcpServers"
    {
      "servers": { "vayu": { "type": "http", "url": "http://127.0.0.1:9877/mcp" } }
    }
    ```

=== "Codex"

    ```toml
    # ~/.codex/config.toml
    [mcp_servers.vayu]
    url = "http://127.0.0.1:9877/mcp"
    ```

**16 tools, 5 resources, 4 prompts.** Inspection (`list_collections`,
`get_run_report`, `compare_runs`), execution (`run_request`,
`run_collection_smoke`), load (`start_load_run`, `stop_run`), and writes
(`create_request`, `update_environment`) - each with a typed schema, so the agent
gets validation rather than guesswork.

**An agent pointed at your engine is a real capability, so it is gated.** Tools
that touch the network refuse any host outside an **allowlist that starts empty**
(deny all). Load runs are additionally capped on RPS, concurrency and duration,
and require confirmation. The tools that mutate saved data sit behind a **write
toggle that is off by default**. All of it lives in **Settings → MCP** and
persists.

[MCP reference](engine/mcp.md){ .md-button }

## Reference

**Engine** - the C++20 daemon: execution, load generation, persistence, scripting.

| Document | Covers |
|---|---|
| [Overview](engine/architecture.md) | Core structure, thread pool, engine-side auth resolution |
| [HTTP API](engine/api-reference.md) | Every endpoint, payload shape, and status code |
| [Test Scripting](engine/scripting.md) | The QuickJS sandbox, script globals, hooks, limits |
| [Local Database](engine/db-schema.md) | SQLite tables and the JSON shapes stored in them |
| [Command Line](engine/cli.md) | Flags and subcommands for running the engine standalone |
| [MCP Server](engine/mcp.md) | The tool surface exposed to coding agents |
| [Benchmarks](engine/benchmarks.md) | RPS head-to-head against wrk and vegeta, with methodology |

**Desktop app** - the Electron + React renderer.

| Document | Covers |
|---|---|
| [Overview](app/architecture.md) | Renderer-side structural decisions |
| [UI Components](app/COMPONENTS.md) | The `modules/` + `components/` layout |
| [Design System](design-system.md) | Tokens, elevation, typography, component patterns |
| [State Management](app/state-management.md) | Zustand stores, TanStack Query keys, cache policy |
| [Talking to the Engine](app/api-integration.md) | What the renderer sends the engine, and when |
| [Variables](app/variable-resolution.md) | How `{{variables}}` resolve, and scope precedence |
| [Postman Script Support](app/pm-api-compatibility.md) | Which `pm.*` APIs the runtime supports |
| [File Naming](app/file-name-conventions.md) | Naming rules across the renderer |
| [Importing Collections](app/import-collections/README.md) | The import pipeline, plus per-format mapping |

**Design notes** - rationale that is easy to misread from the code alone:
[Request Storage](request-storage-design.md),
[Lock Files](lock-file-handling.md),
[Deferred Work](plans/pending-backlog.md).

## Questions people ask

??? question "Is Vayu free?"

    Yes - fully free and open source, with no paid tier, no subscription, and no
    feature gating. The engine is AGPL-3.0 and the app is Apache-2.0.

??? question "How is it different from Postman, Bruno, or Insomnia?"

    Those are good API clients, but none of them load test - for that you reach
    for k6 or JMeter as a second tool. Vayu does both in one app: build the
    request, then load test that same endpoint with a native C++ engine.

??? question "Can I import my Postman collections?"

    Yes. Postman Collection v2.0 and v2.1 exports, including folders,
    environments, variables, auth settings, and pre/post-request scripts. Also
    Insomnia v4, OpenAPI 3.0, and Swagger 2.0 - see
    [how import works](app/import-collections/README.md).

??? question "Will my Postman test scripts still run?"

    Most run unmodified. A QuickJS runtime implements the `pm.*` API -
    `pm.test()`, `pm.expect()`, `pm.environment.get/set()`, `pm.response.*` -
    and [Postman Script Support](app/pm-api-compatibility.md) lists exactly
    what is covered.

??? question "Can my coding agent use it?"

    Yes - Vayu hosts an MCP server on `127.0.0.1:9877` and one command registers
    it with Claude Code, Cursor, VS Code, Codex or Zed. The agent gets 16 tools
    across inspection, execution, load runs and writes, behind a host allowlist,
    load caps, and a write toggle that ships off. See the
    [MCP reference](engine/mcp.md).

??? question "Does it work offline, and does it need an account?"

    Offline, and no account. All execution is local; Vayu contacts no external
    server during normal use - no telemetry, no license check, no cloud sync.

??? question "How fast is the load testing, really?"

    The engine reaches roughly 93% of [wrk](https://github.com/wg/wrk) and holds
    par with [vegeta](https://github.com/tsenart/vegeta), converging on the same
    system throughput ceiling. Full method, concurrency sweep, and a
    one-command reproduction are in the [benchmarks](engine/benchmarks.md).

??? question "Which platforms are supported?"

    Windows (x64), macOS (Apple Silicon and Intel, universal), and Linux
    (x86_64 AppImage).

## Contribute

Bug reports, feature ideas, docs, and code are all welcome. The
[Contributing Guide](https://github.com/athrvk/vayu/blob/master/CONTRIBUTING.md)
covers dev setup, code style, testing, and the release process;
[Build from Source](building.md) gets the engine and app compiling locally.

!!! note "Licensing"

    The engine is AGPL-3.0 and the app is Apache-2.0. See
    [LICENSE](https://github.com/athrvk/vayu/blob/master/LICENSE) for both texts,
    and the [Security Policy](https://github.com/athrvk/vayu/blob/master/SECURITY.md)
    for the threat model and how to report an issue.
