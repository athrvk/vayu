# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/athrvk/vayu/security/advisories/new)
rather than opening a public issue. We aim to acknowledge reports within a few
days.

## Scope notes

Vayu runs a local C++ engine daemon and an Electron UI on `127.0.0.1`. It stores
data (including variables that may hold secrets) in a local SQLite database. It
is a desktop tool, not a multi-tenant service; the threat model is primarily
about local processes and, for the MCP server, other local applications.

## MCP server threat model

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
- **Target allowlist (empty by default).** `run_request` and `start_load_run`
  refuse any host that is not explicitly allowlisted. A fresh install cannot be
  used to send traffic anywhere until the user opts in per host.
- **Hard load caps (enforcement).** `start_load_run` rejects requests whose RPS,
  concurrency, or duration exceed configured ceilings. Together with the
  allowlist, these are the real limits on what load an agent can generate.
- **Confirmation gate (anti-accident, not anti-adversary).** `start_load_run`
  returns a preview and starts nothing unless called again with
  `confirmed: true`. This prevents a load run from starting on a stray tool call,
  but it is agent-side: the same model can send the second call. It is not a
  substitute for the caps/allowlist, which are the enforcement. (A future,
  stronger version would route confirmation to the human via MCP elicitation.)
- **Config writes off by default.** `update_engine_config` is refused unless the
  user enables config writes in Settings. `run_request` and load runs are not
  affected by this toggle — they are governed by the allowlist and caps.
- **Per-tool control.** Any tool (or a whole read/write/load category) can be
  switched off; a disabled tool is removed from `tools/list` and rejected by
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
applies — the load caps and confirmation gate still do. Turn it on only when you
trust the connected agent and understand it can reach arbitrary endpoints.

## Supported versions

Vayu is pre-1.0 (`0.x`); security fixes land on the latest release.
