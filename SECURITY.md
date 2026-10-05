# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/athrvk/vayu/security/advisories/new)
rather than opening a public issue. We aim to acknowledge reports within a few
days.

## What Vayu defends and what it does not

Vayu runs a local C++ engine daemon and an Electron UI on `127.0.0.1`. It is a
desktop tool, not a multi-tenant service.

Vayu does not defend the engine against other programs running under your
account: they can already read the database. A web page open in your browser is
different - it has your network position and none of your file rights - so
what a page can reach is in scope, and reports about it are welcome.

## Renderer posture

The UI window runs with `nodeIntegration` off, `contextIsolation` and the
sandbox on, and a preload that exposes named methods only. Behind that: a
Content-Security-Policy on the app document (no `unsafe-eval`; the renderer may
connect only to itself and the engine on `127.0.0.1:9876`), all device
permissions denied for the app and for OAuth sign-in windows, a chart tooltip
built from text rather than markup, and Electron fuses that disable
`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` on packaged builds.

## Data at rest

Secrets, including variables you mark secret, are stored in plaintext in the
SQLite database in your profile directory, protected by your operating-system
account and nothing else. Vayu does not encrypt them at rest; anyone who can
read that file can read every value in it.

## Agents (MCP)

Tools an MCP client calls receive the same data the UI shows, including the
values of variables marked secret and the auth blocks of saved requests. An
agent backed by a hosted model forwards what it reads to that model's provider.
Treat connecting an agent as granting it read access to your workspace, and
keep the server off until you want that.

### MCP server threat model

Vayu can expose its capabilities to AI agents (Claude Code, Codex, Cursor, …)
via a Model Context Protocol (MCP) server hosted in the Electron main process
over Streamable HTTP at `http://127.0.0.1:9877/mcp`. Because an agent driving a
load-test tool can generate real traffic against real targets, the MCP layer
ships with safe-by-default guardrails. See `docs/engine/mcp.md` for the design.

**Controls enforced by the MCP layer:**

- **Loopback only.** The server binds to `127.0.0.1`; it is not reachable off the
  machine.
- **DNS-rebinding protection.** `Host` headers are validated (SDK
  `enableDnsRebindingProtection` + `allowedHosts`), so a malicious web page
  cannot drive the endpoint through a forged `Host`.
- **Target allowlist (empty by default).** The traffic-sending tools
  (`run_request`, `run_collection_smoke`, `run_collection`, `start_load_run`)
  refuse any host that is not explicitly allowlisted. The check runs against the
  **resolved** host (after `{{variable}}` substitution), so a variable-built URL
  cannot slip past it. A fresh install cannot be used to send traffic anywhere until the user opts
  in per host.
- **Hard load caps (enforcement).** `start_load_run` rejects requests whose RPS,
  concurrency, or duration exceed configured ceilings. Together with the
  allowlist, these are the real limits on what load an agent can generate.
- **Confirmation gate (anti-accident, not anti-adversary).** `start_load_run`
  returns a preview and starts nothing unless called again with
  `confirmed: true`. This prevents a load run from starting on a stray tool call,
  but it is agent-side: the same model can send the second call. It is not a
  substitute for the caps/allowlist, which are the enforcement. (A future,
  stronger version would route confirmation to the human via MCP elicitation.)
- **Data writes off by default.** The data-mutating tools (`create_request`,
  `update_environment`, `update_engine_config`) are refused unless the user
  enables write access in Settings. Traffic-sending tools (`run_request`,
  `run_collection_smoke`, `run_collection`) and load runs are not affected by
  this toggle - they are governed by the allowlist and caps.
- **Per-tool control.** Any tool (or a whole read/execute/write/load category) can
  be switched off; a disabled tool is removed from `tools/list` and rejected by
  `tools/call`.
- **Server disable.** The MCP server can be turned off entirely from Settings;
  while off the endpoint does not accept connections.

**Why there is no auth token on the endpoint.** Any local process could already
reach the engine's REST API on `127.0.0.1:9876`; the MCP endpoint on `:9877`
proxies the same capability behind *more* guards (allowlist, caps, confirmation,
per-tool control) and adds DNS-rebinding protection so a browser tab cannot reach
it. It grants no capability a local process did not already have.

**Residual risk the user accepts by allowlisting a host:** once a host is on the
allowlist, an agent may send it single requests and (within caps, after the
accidental-start gate) load. Only allowlist hosts you own or are authorized to
test.

**"Allow all hosts" removes the allowlist guard.** Enabling it (off by default)
lets an agent target any resolvable host, so the per-host safety check no longer
applies - the load caps and confirmation gate still do. Turn it on only when you
trust the connected agent and understand it can reach arbitrary endpoints.

## Network behaviour

Vayu runs entirely on your machine. There is no account, no cloud and no
telemetry, and nothing leaves your computer unless you send it: a request to a
host you chose, an export you saved, or a reply to an MCP agent you connected.

On a cross-host redirect the engine drops `Authorization` and `Cookie`, as curl
does; every other header you set, including API-key headers, follows the
redirect, and a configured client certificate stays attached. The MCP host
allowlist is checked against the URL you send, not against where it redirects.

## Releases

Releases are built in public on GitHub Actions from tagged source and ship with
checksums and a build-provenance attestation per asset (from the first release
after #1779). Check a download with
`gh attestation verify <asset> --repo athrvk/vayu`; `install.sh` does it for
you when an authenticated `gh` is present and refuses an asset whose checksum
is missing or wrong. Every third-party action in the release workflow is pinned
to a commit SHA, and only the final publish job can write to the release. They
are not yet code-signed, so macOS and Windows will warn on first
launch, and `install.sh` strips the macOS quarantine attribute for that reason.
If you find a way to break any statement in this document, report it privately
through GitHub Security Advisories.

## Supported versions

Vayu is pre-1.0 (`0.x`); security fixes land on the latest release.
