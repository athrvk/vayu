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
- **Hard load caps.** `start_load_run` rejects requests whose RPS, concurrency,
  or duration exceed configured ceilings.
- **Confirmation gate.** `start_load_run` returns a preview and starts nothing
  unless called again with `confirmed: true`.
- **Read-only by default.** Collection/environment write tools are not exposed
  unless the user enables writes.
- **Server disable.** The MCP server can be turned off entirely from Settings;
  while off the endpoint does not accept connections.

**Residual risk the user accepts by allowlisting a host:** once a host is on the
allowlist, an agent may send it single requests and (within caps, after
confirmation) load. Only allowlist hosts you own or are authorized to test.

**"Allow all hosts" removes the allowlist guard.** Enabling it (off by default)
lets an agent target any resolvable host, so the per-host safety check no longer
applies — the load caps and confirmation gate still do. Turn it on only when you
trust the connected agent and understand it can reach arbitrary endpoints.

## Supported versions

Vayu is pre-1.0 (`0.x`); security fixes land on the latest release.
