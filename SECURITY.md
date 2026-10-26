# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/athrvk/vayu/security/advisories/new)
rather than opening a public issue. We aim to acknowledge reports within a few
days.

## What Vayu defends and what it does not

Vayu runs a local C++ engine daemon and an Electron UI on `127.0.0.1`. It is a
desktop tool, not a multi-tenant service: a host shared with other logged-in
users is out of scope. The loopback ports (`9876` for the engine, `9877` for MCP)
and any mock server or inbox you start belong to the machine, not to one user,
and the owner-only file modes under "Data at rest" protect files, not ports.

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
anything. A request the engine itself sends - a Send, a run, a script's
`pm.sendRequest`, a redirect it follows - never reaches the engine's own port
or the MCP port, whatever spelling, redirect or DNS name leads there.

Which files a request body may send from disk (the folders you allow and the
files you pick) changes only through the app: those writes need a secret the
app hands the engine at start and keeps from its UI window, so another local
caller of the API, the CLI or an MCP agent included, cannot widen them. The
app's main process makes the writes, and only for a folder you chose in the
system folder picker or a file that reached the window through a file dialog
or a drop; the UI window cannot name either.

Scripts in a collection someone shared with you, or in a file you import, run
with your own cookies and secrets (the Postman model), and `pm.sendRequest` from
one reaches any host you can, your LAN included, except the two ports above.
Read them before you press Send. Importing scripts is a choice: "Import
pre-request & test scripts" in the import dialog is ticked by default and the
dialog does not warn, so untick it for a file you do not trust.

`pm.cookies.jar()` is held to the request's own site for reads and writes alike:
the request host, its parents and subdomains, and hosts the script called
through `pm.sendRequest`. A read outside it answers `undefined` or an empty
list, a write outside it stores nothing, and each leaves a console warning. The
`Domain` of a `set` is checked on its own: a single-label one such as `com` is
refused unless it is the request host. Vayu vendors no public-suffix list, so a
script can still set a cookie for a multi-label suffix such as `co.uk` or
`github.io` (accepted, #2731).

A mock server or webhook inbox you start is different: it exists to be called
from pages, so every page in the browser can reach it and, by default, read
what it answers (CORS `*`, never with your cookies). Starting one with
`allowedOrigins` restricts reading to the origins you list, but those replies
carry `Access-Control-Allow-Credentials`, so "never with your cookies" holds only
for the default, and the listener still answers every request: the list decides
who may read the reply, not who may send. A mock binds to loopback only. An
inbox can bind past loopback only through an explicit `bind` plus
`confirmNonLoopback` from the engine API, never from an MCP agent, and once
it does, anyone on that network can post to it. Since a mock replays saved
examples verbatim, do not save examples from production responses into a
collection you mock.

## Renderer posture

The UI window runs with `nodeIntegration` off, `contextIsolation` and the
sandbox on, and a preload that exposes named methods only. Behind that: a
Content-Security-Policy on the app document (scripts only from the app's own
origin plus a hash of one inline script, so neither `unsafe-eval` nor
`unsafe-inline` for script, though styles may be inline; no form submission; the
renderer may connect only to itself and to the engine on `127.0.0.1`, on the
port the app picked from a fixed list (9876, or 9880-9889 if 9876 is taken); the
MCP port and every other local port are outside it), all device permissions
denied for the app and for OAuth sign-in windows, a chart tooltip built from
text rather than markup, an HTML response preview in a `sandbox=""` frame that
runs no script and loads nothing from the network, and Electron fuses that
disable `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` on packaged
builds. The app document is served from an origin of its own, `vayu-app://app`,
rather than from a local file, so the policy's `self` means that origin and no
file on disk. The one exception is the first launch after upgrading from a
version that served it from a file: saved settings are read from the old
local-file origin once, by a hidden page that runs no script of its own, has no
preload and may load nothing, and copied into the new one. The channels that
read a file by a path the window names read only files you picked, dropped or
opened through the app, and the one that reports a file's size answers only for
those or for files under a folder you allowed. The engine does not take the
renderer's word for file access either: a binary body or a form file part is
sent only if the file is under a folder you allowed or is one you picked.

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
The app's own log files (`app_*.log`, and `mcp_*.log` from the standalone MCP
server) are created `0600`, in that same `logs` folder.
On Windows the data directory gets a protected ACL for your account, SYSTEM and
Administrators, which files created afterwards inherit; files that already
existed keep their old ACL. A user who can act as you, or read your disk
offline, still reads everything.

## Agents (MCP)

Tools an MCP client calls receive the same data the UI shows, except your
secrets: unless you turn on **Reveal secrets to agents** in Settings > MCP (off
by default), an agent reads no secret through any tool. The values of variables
marked secret, the credentials in auth blocks, the values of credential-bearing
headers (`Authorization`, `Cookie`, `X-Api-Key` and the like), the password and
credential query values in a saved request's URL and its credential parameter
rows (`api_key`, `token` and the like), cookie values and the password in a
proxy URL are withheld wherever an agent reads what you
stored, and what a write tool echoes back is withheld the same way. What a run
recorded - a trace, a report, a sample, a run row, an inbox capture, a smoke
run's rows, a load run's confirmation preview - reads `<redacted>` wherever a
secret variable's value, a credential typed into a saved auth block, a
credential header's value, the token or key Vayu itself placed in the URL's
query or a header, or the value of a credential query parameter (`api_key`,
`token` and the like) in a request's URL appears, whatever encoding it went
out in. If Vayu cannot read the values it masks against, the agent gets an
error in place of the record, never a partly masked one. Requests an agent sends
still use the real values; the engine fills them in. Clearing a variable's
secret flag, the one write that would hand the value back on the next read, is
refused while reveal is off.

An agent can also ask which tab and environment you have open (`get_app_focus`).
The answer is names and ids only - a tab's type, id and saved name, and the
environment's id and name - never a variable value, and never text derived from a
URL, which could hold one.

While reveal is off, an agent also cannot send a script of its own with
`run_request` or `start_load_run` (a pre-request, post-request or `tests`
script, or a script element): a script reads every variable, secret ones
included, so the call is refused before anything is sent. A script stored on a
request or collection, which the write tools can create, is not covered and
still runs with your secrets (`run_request` sends a saved request, scripts
included, when given its `requestId` and no `url`), so leave write access off
unless you want an agent to author them.

While write access is off, nothing a `run_request` sets is saved: an extractor
the agent attaches, or its own script once reveal is on, still runs and reports,
but the variables it sets stay within that one request and never reach an
environment, a collection or the globals. A collection replay
(`run_collection_smoke`, `run_collection`) runs the scripts and extractors
stored on your requests and saves what they set, as the app's Send does.

An agent backed by a hosted model forwards what it reads to that model's
provider. Treat connecting an agent as granting it read access to the rest of
your workspace. The server is on by default and listens on loopback only; switch
it off in Settings > MCP if you do not want the endpoint open. If another
program already holds the port, Settings > MCP says so and disables the connect
actions, so an agent is never pointed at an endpoint Vayu is not serving.

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
- **DNS-rebinding protection.** The `Host` header must name a loopback host,
  and an `Origin` header, when a browser sends one, a loopback origin (the SDK's
  `localhostHostValidation` / `localhostOriginValidation`, checked in front of
  the MCP handler), so a malicious web page cannot drive the endpoint through a
  forged `Host` or post to it from another site.
- **Target allowlist (empty by default).** The traffic-sending tools
  (`run_request`, `run_collection_smoke`, `run_collection`, `start_load_run`)
  refuse any host that is not explicitly allowlisted. The check runs against the
  **resolved** host (after `{{variable}}` substitution), so a variable-built URL
  cannot slip past it. A fresh install cannot be used to send traffic anywhere
  until the user opts in per host. The allowlist and the caps bind the runs an
  MCP agent starts (the engine's `targetPolicy`), not the app's own Send. The
  engine re-applies the same allowlist to the URL a pre-request script rewrites
  and to OAuth token endpoints (#2521), and refuses `pm.sendRequest` in a run an
  agent started; where a request redirects is the remaining gap (see
  [Network behaviour](#network-behaviour)). A run's `monitor.url` is a second
  host with its own check: a loopback or private-network endpoint needs no
  entry, but link-local (`169.254.0.0/16`, `fe80::/10`) and cloud-metadata
  addresses (`169.254.169.254`, `fd00:ec2::254`) do, like any public host. So an
  agent can make Vayu fetch any private-network address and read the metric text
  back; matching is textual, so a name that resolves to a private address needs
  an entry too.
- **Hard load caps (enforcement).** `start_load_run` rejects requests whose RPS,
  concurrency, or duration exceed configured ceilings. Together with the
  allowlist, these are the real limits on what load an agent can generate. An
  agent can read the caps, the allowlisted hosts and the on/off state of the
  gates (`get_safety_config`); it never receives a secret value through it.
- **Confirmation gate (anti-accident, not anti-adversary).** `start_load_run`
  and the destructive deletes start or remove nothing on a first call. Where the
  client and transport let Vayu ask (a 2026-07-28 client, or stdio), the
  question goes to the person through MCP elicitation; otherwise the call
  returns a preview and proceeds only when called again with `confirmed: true`,
  which is agent-side: the same model can send the second call. Neither is a
  substitute for the caps/allowlist, which are the enforcement. Which clients
  are asked: `docs/engine/mcp.md`, "What is live on each transport".
- **Data writes off by default.** The data-mutating tools (`create_request`,
  `update_environment`, `update_engine_config`) are refused unless the user
  enables write access in Settings. Traffic-sending tools (`run_request`,
  `run_collection_smoke`, `run_collection`) and load runs are not refused by
  this toggle - they are governed by the allowlist and caps. The one thing it
  changes for them: with writes off, `run_request` keeps every variable its
  extractors and scripts set within the send rather than saving it. The
  collection replays still save what the stored scripts and extractors set,
  and a load run saves no variable either way.
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
- **Server disable.** The MCP server is on by default and can be turned off
  entirely from Settings; while off the endpoint does not accept connections.
  When the port is taken the server does not start, Settings > MCP shows why and
  offers no endpoint to copy, and one-click connect refuses.

**Why there is no auth token on the endpoint.** Any local process could already
reach the engine's REST API on `127.0.0.1:9876`; the MCP endpoint on `:9877`
proxies the same capability behind *more* guards (allowlist, caps, confirmation,
per-tool control) and adds DNS-rebinding protection so a browser tab cannot reach
it. It grants no capability a local process did not already have. On a host
shared with other users that includes their processes, which is why such a host
is out of scope (see the first section).

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
telemetry, and apart from the update check below nothing leaves your computer
unless you send it: a request to a host you chose, an export you saved, or a
reply to an MCP agent you connected.

The update check: a packaged app asks GitHub Releases for a newer version about
a minute after launch and every 6 hours after, on every platform. Windows and
the Linux AppImage then download it in the background; macOS and the Linux
`.deb` only tell you. There is no setting to turn the check off.

On a cross-host redirect the engine drops `Authorization` and `Cookie`, as curl
does; every other header you set, including API-key headers, follows the
redirect, and a configured client certificate stays attached. The API Key editor
says so; turn off follow-redirects on a request whose key must stay on one host.
The MCP host allowlist is checked against the URL you send, not against where it
redirects.

**What an imported file can do.** Import never sends a request itself, but the
file can make the engine fetch. A multi-file OpenAPI document may name `http(s)`
URLs in an external `$ref`, and one you picked from disk may name sibling files;
Vayu reads both while it builds the preview, before you confirm. A fetched
`$ref` follows no redirect and refuses loopback and link-local targets other than
the host and port the document itself came from, but it does not refuse
private-network or public hosts, so import only specs you trust. A sibling file
must sit under the folder of the file you picked. A Postman or Insomnia file can
carry scripts, auth, variables and environments of its own (see the scripts note
under "What Vayu defends").

After a download on Windows or the Linux AppImage, the in-app updater contacts
`api.github.com` for the installer's attestation and `tuf-repo-cdn.sigstore.dev`
to refresh the Sigstore trusted root it checks that attestation against. Both go
through Electron's `net.fetch`, so both follow the system proxy.

## Releases

Releases are built in public on GitHub Actions from tagged source and ship with
checksums and a build-provenance attestation per asset (from the first release
after #1779). Check a download with
`gh attestation verify <asset> --repo athrvk/vayu`; `install.sh` does it for
you when an authenticated `gh` is present, pinned to the tag it downloads so
an older release's asset cannot stand in, and refuses an asset whose checksum
is missing or wrong. Every third-party action in the release workflow is pinned
to a commit SHA, and only the final publish job can write to the release. They
are not code-signed, so macOS and Windows will warn on first
launch, and `install.sh` strips the macOS quarantine attribute for that reason.

The install command fetches `install.sh` from `athrvk.github.io/vayu/install.sh`,
which GitHub Pages builds from `master`. The `gh attestation verify` inside it is
therefore only as trustworthy as that script, and it runs only when an
authenticated `gh` is present.

**The in-app updater checks the attestation too.** On Windows and the Linux
AppImage the updater downloads in the background and installs nothing until the
installer's build-provenance attestation verifies against Sigstore's public-good
trusted root and names `release.yml` in `athrvk/vayu` at the exact tag of the
release being installed. Otherwise it refuses, tells you why, and offers the
release page. Pinning the tag, not just the workflow, is what refuses an older
genuine installer re-uploaded under a newer release. The `latest*.yml` update
feeds are attested like every other asset, so
`gh attestation verify latest.yml --repo athrvk/vayu` covers them as well, but
the updater verifies the installer's attestation, not the feed's. On
macOS and the Linux `.deb` the app downloads nothing and only points to the
release page.

**What this does not stop.** An attestation proves a file came out of that
workflow run, not that the run was honest. An attacker who can run code inside
the publish job, through a compromised pinned action for instance, can have it
attest a malicious file. What the check removes is the cheaper attacks:
replacing assets on a release with a stolen `contents: write` token, a
hand-edited release, and a re-uploaded older build.

The check fails closed: it never installs because it could not look. The
trusted-root refresh follows the system proxy like the attestation lookup does,
so a network that reaches the internet only through one is not refused for that
reason.

If you find a way to break any statement in this document, report it privately
through GitHub Security Advisories.

## Supported versions

Vayu is pre-1.0 (`0.x`); security fixes land on the latest release.
