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
what a page can reach is in scope, and reports about it are welcome. The engine
sends no CORS header and refuses every request that carries a browser `Origin`
and every `Host` that is not a loopback name for its own port, so a page can
neither read anything from it nor change anything in it: a cross-origin `fetch`
or a form post carries an `Origin`, and a DNS-rebinding page names a host the
engine does not answer to. What a page can still do is a scriptless `GET` - an
`<img>`, `<script>` or `<link>`, a `no-cors` `fetch`, a top-level navigation -
which carries a loopback `Host` and no `Origin` and so reaches a `GET` route.
The page gets an opaque response it cannot read, and no `GET` route changes
anything.

## Renderer posture

The UI window runs with `nodeIntegration` off, `contextIsolation` and the
sandbox on, and a preload that exposes named methods only. Behind that: a
Content-Security-Policy on the app document (no `unsafe-eval`; the renderer may
connect only to itself and the engine on `127.0.0.1:9876`), all device
permissions denied for the app and for OAuth sign-in windows, a chart tooltip
built from text rather than markup, an HTML response preview in a `sandbox=""`
frame that runs no script and loads nothing from the network, and Electron
fuses that disable `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` on
packaged builds.

## Data at rest

Secrets, including variables you mark secret, are stored in plaintext in the
SQLite database in your profile directory, protected by your operating-system
account and nothing else. Vayu does not encrypt them at rest; anyone who can
read that file can read every value in it.

On Linux and macOS the engine makes the data directory and the `db`, `logs` and
`backups` folders inside it owner-only (`0700`) and everything it writes there
(the database and its `-wal` and `-shm` files, backups, logs) `0600`. Each start
tightens what an older version left readable, files as well as folders: the lock
file, the regular files directly in `db`, `db/backups` and `logs`, and nothing
else (symlinks are skipped). The data directory is `chmod`ed `0700` whatever
`--data-dir` names, so point it at a folder of its own, not at one you share.
The `umask` of `077` the engine sets covers the whole process, so a file it
creates anywhere else, including a path you chose, is `0600` too.
On Windows the data directory gets a protected ACL for your account, SYSTEM and
Administrators, which files created afterwards inherit; files that already
existed keep their old ACL. A user who can act as you, or read your disk
offline, still reads everything.

## Agents (MCP)

Tools an MCP client calls receive the same data the UI shows, except your
secrets: unless you turn on **Reveal secrets to agents** in Settings → MCP (off
by default), an agent reads no secret through any tool. The values of variables
marked secret, the credentials in auth blocks, the values of credential-bearing
headers (`Authorization`, `Cookie`, `X-Api-Key` and the like), the password and
credential query values in a saved request's URL and its credential parameter
rows (`api_key`, `token` and the like), cookie values and the password in a
proxy URL are withheld wherever an agent reads what you
stored, and what a write tool echoes back is withheld the same way. What a run
recorded - a trace, a report, a sample, a run row, an inbox capture, a smoke
run's rows, a load run's confirmation preview - reads `<redacted>` wherever a
secret variable's value, a credential typed into a saved auth block or a
credential header's value appears, whatever encoding it went out in. If Vayu
cannot read the values it masks against, the agent gets an error in place of
the record, never a partly masked one. Requests an agent sends still use the
real values; the engine fills them in. Clearing a variable's secret flag, the
one write that would hand the value back on the next read, is refused while
reveal is off.

This is not a sandbox, and two paths remain open with reveal off. A
pre-request script the agent sends with `run_request` runs with your
environment's secrets and can copy one into a variable not marked secret, or
into its own output (tracked in #1834). A credential the engine writes itself,
such as an OAuth 2.0 token it placed in the URL's query, or an API key sent
inline with one request and read back later, is not recognised as a secret in
a trace (#1835).

An agent backed by a hosted model forwards what it reads to that model's
provider. Treat connecting an agent as granting it read access to the rest of
your workspace, and keep the server off until you want that.

The run history in Vayu's own screens is not masked: a request that references a
secret sends it, so the stored trace and inbox captures keep what went over the
wire, and your own screens show it. Only the agent's view of them is masked.

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
- **Network settings gated separately.** Even with writes on,
  `update_engine_config` refuses the proxy keys (`proxy*`) and
  `customCaCertificates` unless the user also enables network settings in
  Settings. The allowlist checks the host a request names, not the proxy it
  passes through, so an agent that could repoint the proxy or add a trusted CA
  could route and read every request.
- **Secrets withheld by default.** With reveal off, an agent reads no secret
  through any tool or resource. Read tools and resources return secret
  variables as `valueWithheld: true`, auth credentials as
  `<member>Withheld: true`, the values of credential-bearing headers on saved
  requests and examples as `valueWithheld: true`, a saved request's URL with its
  password dropped and its credential query values emptied, credential
  `params` rows as `valueWithheld: true`, cookie values as
  `valueWithheld: true` and proxy URL credentials stripped; write tools answer
  with the same projection of the row they changed; run output (reports,
  samples, run rows, inbox captures, the run resources and prompts) reads
  `<redacted>` in place of a secret variable's value and a credential header's
  value; and `secret: false` over a stored secret is refused. Reveal in Settings
  lifts all of it.
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
