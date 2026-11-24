---
description: >-
  The gates between an agent and the network and saved data: the allowlist, load caps, the write toggle and confirmation.
---

# MCP safety model

## Safety model

Enforced in the MCP layer (`safety.ts`, `config.ts`), with two exceptions noted below: the engine applies the allowlist again to the URL a send is about to dial, to OAuth 2.0 token endpoints and to a load run's `monitor.url` (`targetPolicy`, #2521, #3121), and script-issued requests are refused engine-side, because this layer cannot see them.
Nothing here changes engine *behaviour* for other clients: a payload without a `targetPolicy` is unrestricted.
All configurable in **Settings → MCP** and persisted (in the stdio CLI, through the `VAYU_MCP_*` variables, and a refusal there names the variable - see [Configuration](configuration.md#configuration)).

- **Target allowlist** (default empty ⇒ deny all).
  Network-touching tools refuse off-list hosts with an actionable error.
  An **"Allow all hosts"** opt-in bypasses the list (still rejects unresolved `{{variables}}`); off by default.
  Entries are hostnames, matched exactly: what you type in Settings is reduced to a host (`https://api.example.com:8080/v1` and `api.example.com` are the same entry), and the request URL is matched by its host whether or not it carries a scheme (`localhost:3000/api` matches the entry `localhost`).
  An IPv6 target is stored and shown in its canonical bracketed form - typing `::1` stores `[::1]`, which is what a URL parses to.
  A run's **`monitor.url` is a second host** and gets its own check, with one deliberate exemption: a **loopback or private-network** monitor endpoint (`localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `::1`, `fc00::/7`) needs no allowlist entry, while a public one is checked exactly as the target URL is.
  **Link-local and cloud-metadata addresses are not exempt** (#2370): `169.254.0.0/16` (which holds `169.254.169.254`, the metadata service on AWS, GCP and Azure), `fe80::/10` and AWS's IPv6 `fd00:ec2::254` need an allowlist entry like a public host, because a scrape of one reads credentials rather than the user's exporter.
  The rest of `fc00::/7` stays exempt.
  The allowlist exists to stop an agent generating traffic against third parties it was never pointed at, and a private address, link-local aside, is the user's own network - which is also the feature's own case, since the endpoint a load run wants beside it is the target's own `localhost:9100`.
  The test is textual, like the allowlist itself: a DNS name that *resolves* to a private address still needs an entry, because resolving it here would make the answer depend on the network it was asked on.
  The engine holds `monitor.url` to the run's `targetPolicy` with no exemption of its own (#3121), so the exempt host is added to the run's `allowedHosts` (see [Request composition](request-composition.md#request-composition)).
  The renderer's load-test dialog uses the same classification to tell a local target from a remote one (`isLocalHost` in `src/lib/host-locality.ts`, a mirror of `isPrivateHost` that the main process cannot share); `host-locality.conformance.test.ts` fails on any divergence.
  Because the check happens here, before the engine is called, the URL a pre-request script rewrites is not seen by it - the engine applies the same list to it (`targetPolicy`, see [Request composition](request-composition.md#request-composition)) - and a request sent from inside a script could not be checked at all, so `pm.sendRequest` is refused outright for runs this server starts.
  See [The script sandbox surface](resources-and-prompts.md#pmsendrequest-is-refused-for-mcp-started-runs).
- **Hard caps** - max RPS / virtual users (`concurrency`) / duration / iterations / response samples (`maxResponseSamples`) on `start_load_run`; over-cap requests are rejected.
  With the allowlist, these are the real limits on load, and they cover **every** field the tool forwards:
    - `concurrency` **and** `startConcurrency` are both held to the virtual-user cap (**Max virtual users** in Settings).
      A ramp is seeded with `startConcurrency` before its first duration check, so capping only the target would bound where a run ends and not where it starts.
    - An **iterations** run stops on a request count and never reads `duration`, so no duration cap can bound it.
      **Max iterations** is its own setting for that reason (10000 by default).
      An omitted `iterations` is sent and compared as the engine's own default of 1000.
      The schema refuses an unrecognised `mode`, and the guard still reads one carrying an `iterations` field as an iterations run, because the engine runs it as one.
    - `maxResponseSamples` is held to its own cap (**Max response samples**, 10000 by default) because each response kept for the sampled script and schema replay is a full body in engine memory until the replay has run.
      An omitted one is judged as the engine's default of 1000, so a cap under 1000 refuses a run that states no count and the refusal says so.
    - An **omitted** field is judged as the default the tool sends for it ([Load defaults](#load-defaults)), not as "unbounded": an omitted `concurrency` on a constant run is 100 virtual users, so a **Max virtual users** under 100 refuses it with the same message a stated 100 gets, and so does an omitted `concurrency` on a `capacity` run, whose search climbs to 100 (#2493).
      An omitted `duration` is the mode's default (60s, or 300s for `capacity`) unless `maxDurationSeconds` is shorter, in which case the cap is sent in its place and the run is bounded by it.
      `concurrency`, `startConcurrency`, `iterations` and `maxInFlight` are additionally constrained to positive integers by the tool's own schema,
      because "unlimited" is an obvious guess to spell `-1` or `0` and the engine reads them as an eager per-worker pre-allocation count, a ramp seed, a request budget, and an in-flight ceiling (see the accepted ranges under [POST /runs](../api-reference/load-runs.md#post-runs)).
      `maxInFlight` is the one that bounds work *downward*, so there is no separate cap setting for it - the enormous value is the one that removes the backpressure the caller asked for; its schema additionally carries the engine's own ceiling of `1000000`, so a value this tool accepts is one `POST /runs` accepts.
      `duration` / `rampUpDuration` are also rejected when they are not durations at all (`ms`/`s`/`m`/`h`, or a bare number of seconds - the same grammar the engine parses), since the engine refuses such a run with a `400` rather than quietly substituting 60s; a zero `duration` is rejected here for the same reason the engine `400`s it, while a zero `rampUpDuration` stays legal (an instant ramp).
- **Confirmation** - anti-accident, not anti-adversary: it stops a stray tool call from starting load or destroying saved work, but where the client cannot be asked it is agent-side (the caps/allowlist are the enforcement).
  A question to the person upgrades it to a human decision where the client can be asked.
  The question is an `input_required` result: the call does nothing, the client asks, and the call is made again carrying the answer, so a gated tool reads and nothing more before its gate.
  Eight tools carry it - `start_load_run`, `delete_collection`, `delete_request`, `delete_request_example`, `delete_run`, `delete_environment`, `delete_webhook_inbox` and `purge_trash_entry` - through one implementation (`confirmDestructive`), so the question cannot drift between them.
  A preview is a *successful* result that deliberately did nothing, so it emits no `mcp:data-changed` event either.
  `restore_trash_entry` deliberately does **not** carry it: it puts data back rather than destroying it, so the write toggle alone is its gate (below).
- **Write toggle** (`allowWrites`, default off) - gates every tool in the **write** category, and while it is off they are **not registered at all**: they are absent from `tools/list`, not merely refused by `tools/call`.
  A call on one of their names anyway - guessed, or held over from a list fetched while the toggle was on - is answered with the handlers' own refusal, which names the setting to turn on; the SDK would otherwise reject the unregistered name as invalid params (`-32602`, `Tool <name> not found`), which tells an agent nothing it can act on.
  The SDK has no hook in front of its own dispatch, so `server.ts` captures the `tools/call` handler it installs and puts the refusal in front of it; the protocol test that calls a withheld name is what holds that to the SDK across an upgrade.
  The server instructions say the same thing up front, in the sessions where the toggle is off, and name the task families that need write access (saving or deleting collections and requests, environments and globals, an import or a spec bind, clearing cookies, changing engine config) so an agent that sees no write tool does not conclude the MCP cannot save (#2442).
  They name families, never tools, and `protocol.integration.test.ts` classifies every write tool into one, so a new write tool fails until its family is in the sentence.
  Withholding the schema rather than only the call is what makes the toggle free: those tools are over a third of the `tools/list` an agent is sent (#2441), and on a default install none of them could have succeeded.
  Write access is a separate grant from reveal: a script stored by a write tool (`create_request` / `update_request` / `create_collection` / `update_collection`, or an import) is not refused while reveal is off, and runs with the secrets under `run_collection_smoke`, `run_collection` and `start_load_run`.
  That is a residual of write access, not a gate.
  A send writes saved data too, through the variables it sets: an extractor in `run_request`'s `elements` does (its default scope is the collection), and so does an agent's own script once reveal is on.
  With the toggle off, `run_request` sends `persistVariables: false` on both its buffered and its streaming path (#1904): every script and extractor still runs and reports, a value one sets is visible for the rest of that send, and nothing reaches the environment, the collection or the globals.
  With the toggle on the key is absent and the engine persists as it does for the app's Send.
  `run_collection_smoke` and `run_collection` are not covered: they replay the scripts and extractors *stored* on the requests and save back what those set, which is the write-access residual above.
  `start_load_run` never persists a variable at all.
  Because the tool set is recomputed per built server (a fresh one per HTTP request), flipping the toggle takes effect on the client's next `tools/list` - the same timing the per-tool switch below already has.
  The category is every tool declared `category: "write"` in `tools/*.tools.ts` - 28 write tools:
  `create_collection`, `update_collection`, `delete_collection`, `create_request`, `update_request`, `delete_request`, `create_request_example`, `update_request_example`, `delete_request_example`, `move_item`, `create_environment`, `update_environment`, `activate_environment`,
  `delete_environment`, `update_globals`, `clear_cookies`, `update_engine_config`, `set_run_baseline`, `delete_run`, `delete_webhook_inbox`, `clear_inbox_captures`, `restore_trash_entry`, `purge_trash_entry`, `sync_spec`, `import_document`, `bind_spec`, `unbind_spec`, `clear_oauth2_token`.
  Does not gate `run_request` / `run_collection_smoke` / load runs (allowlist + caps).
  Seven of those need the toggle **and** confirmation - the six deletes plus `purge_trash_entry`: the toggle is a single session-wide switch a user flips once to let an agent save a request, which is not consent to destroy a subtree, a run's stored history, or a trashed row for good.
  `clear_cookies` and `restore_trash_entry` take the toggle without a confirmation, for opposite reasons: one ends a session rather than anything saved, the other puts a row back rather than destroying one.
- **Network gate** (`allowNetworkSettings`, default off) - the second key `update_engine_config` needs for the entries that decide where every request goes and whom it trusts: every `proxy*` key (`proxyMode`, `proxyUrl`, `proxySystemUrl`, `proxyBypass`, matched by prefix and case-insensitively, so a proxy key added later is gated the day it ships) and `customCaCertificates` (#1805).
  A batch naming any of them without the gate is refused whole, before the engine sees it.
  The allowlist cannot stand in for it: it checks the host a request names, never the proxy the request leaves through, and a trusted CA is what lets that proxy read TLS.
  On its own it grants nothing; the write toggle still decides whether `update_engine_config` is offered at all.
- **Reveal secrets** (`revealSecretsToAgents`, default off) - while it is off, an agent reads no secret through any tool:
  reads withhold secret variables, auth credentials, credential header values, cookie values and proxy URL credentials, write tools answer through the same projection and refuse to clear a secret flag, and run output reads `<redacted>` for a secret variable's value and a credential header's value.
  The server instructions say so; see [Secret values](secrets.md#secret-values).
- **Loopback services carry no gate of their own** - `start_mock_issuer`, `stop_mock_issuer`, `update_mock_issuer`, `start_mock_server`, `stop_mock_server`, `start_webhook_inbox`, `stop_webhook_inbox` and `update_inbox_response` are `execute` tools that neither the allowlist nor the write toggle governs.
  (The two that destroy recorded data, `delete_webhook_inbox` and `clear_inbox_captures`, are `write` tools and do take the toggle - what they end is not the listener but the captures.)
  The allowlist exists to stop an agent generating traffic against third parties it was never pointed at, and a mock issuer is bound to `127.0.0.1` by the engine with no host to configure - as is a mock server, and as is an inbox, whose `bind` these tools never send; the write toggle gates saved data, which an ephemeral listener is not (a mock server only *reads* the examples it serves).
  Nor would a gate here withhold anything: an agent with `localhost` allowlisted can already reach `POST /mock-issuer/start` through `run_request`, for the same reason the endpoint needs no auth token.
  The bounds that do apply are the engine's own - at most 8 issuers at once - and the per-tool switch below.
- **Per-tool control** - any tool or whole read/execute/write/load category can be switched off; a disabled tool is omitted from `tools/list`, and calling its name is rejected as invalid params (`-32602`, `Tool <name> not found`) - it is unregistered, so the SDK rejects the name before any Vayu code runs.
  (The write toggle's refusal above is the deliberate exception, and it does not claim a tool the user switched off: that tool would still be off after enabling writes. The rejection in `dispatchTool` is what any other caller of it gets.)
  Settings lists every tool whatever the write toggle says, so the switches for write tools stay visible and settable while writes are off - the toggle governs what the *agent* is offered, not what the user can configure.
  This and the write toggle are **independent**, and a write tool needs both: switching the write category on here does nothing while `allowWrites` is off, and turning `allowWrites` on re-enables no tool that is in `disabledTools`.
  Settings states this on both cards, because a user who flips one switch and sees no change has nothing else to go on.
- **Server on/off** - the whole server can be disabled; while off the endpoint does not accept connections.
  Persists across restarts.
  Off holds even when it lands mid-start: the bind in flight is closed rather than published (`lifecycle.ts`).
- **Transport hardening** - loopback bind, Host- and Origin-header (DNS-rebinding) validation, `POST`-only, 4 MB body cap.

**Why no auth token on the endpoint:** any local process could already reach the engine's REST API on `:9876` (or its fallback); the MCP endpoint proxies the same capability behind _more_ guards and adds DNS-rebinding protection.
It grants no capability a local process did not already have.

### Load defaults

`start_load_run` resolves every load-shape field the agent leaves out to the value the engine would otherwise use, and sends it explicitly, so the caps, the confirmation preview, the stored run (`list_runs` rows, `get_run_report`'s `metadata.configuration`) and `compare_runs` all read the same numbers (#2437).
A stated value is never replaced.
A single-target run takes the strategies' defaults, named in `run_config` and `capacity` in `engine/include/vayu/core/constants.hpp`:

| Mode | `concurrency` | `startConcurrency` | `duration` | `rampUpDuration` | `iterations` |
|------|---------------|--------------------|------------|------------------|--------------|
| `constant_concurrency` | 100 | - | 60s | - | - |
| `constant_rps` | 100, none when `targetRps` paces the run | - | 60s | - | - |
| `ramp_up` | 100 | 1 | 60s | 10s | - |
| `iterations` | 10 | - | none (never read) | - | 1000 |
| `capacity` | 100, the search ceiling | the engine's own | 300s | - | - |

A scenario run (`scenario`) takes its executor's own defaults (`execute_scenario_load`, `engine/src/core/scenario_load.cpp`): 10 virtual users in each of its three modes, with the same duration, ramp, start and iteration defaults as the table.
In every mode an omitted `duration` is the cap instead when **Max duration** is shorter.
A `constant_concurrency` run is closed loop at its virtual users.
A `constant_rps` run with a `targetRps` is open loop and no `concurrency` is sent; a `mode`-less call with a positive `targetRps` resolves to `constant_rps`.
A `targetRps` beside an explicit `constant_concurrency` (or any other mode but `constant_rps`) is not resolved away: it is forwarded and the engine answers `400 invalid_run_config` (#2396), so the one rule stays in the engine.
`capacity`'s `sloMs` and `stepDuration` stay engine-side.
`safety.test.ts` reads both engine files, so a changed default fails the app suite until the table above and the tool's follow it.

### Safety config

`McpSafetyConfig` (defaults in parentheses):

| Field                | Default | Ceiling     | Meaning                                                    |
| -------------------- | ------- | ----------- | ---------------------------------------------------------- |
| `allowlist`          | `[]`    | -           | Permitted hostnames (empty = deny all).                    |
| `allowAll`           | `false` | -           | Bypass the allowlist for any resolvable host.              |
| `maxRps`             | `1000`  | `1000000`   | Cap on `targetRps`, which only `constant_rps` carries.     |
| `maxConcurrency`     | `200`   | `10000`     | Cap on virtual users: `concurrency` and `startConcurrency` (closed-loop). |
| `maxDurationSeconds` | `300`   | `86400`     | Cap on load-run duration.                                  |
| `maxIterations`      | `10000` | `100000000` | Cap on `iterations` (iterations mode).                     |
| `maxResponseSamples` | `10000` | `1000000`   | Cap on `maxResponseSamples`, the responses a run keeps for the sampled script and schema replay; an omitted one is judged as the engine's `1000`. |
| `allowWrites`        | `false` | -           | Enable the data-mutating tools.                            |
| `allowNetworkSettings` | `false` | -         | Let `update_engine_config` change the proxy and trust-anchor keys. |
| `revealSecretsToAgents` | `false` | -        | Lift every withholding in [Secret values](secrets.md#secret-values): reads, write answers and run output. |
| `disabledTools`      | `[]`    | -           | Tool names to hide/reject.                                 |

**An agent reads these through `get_safety_config`** (#2444), in one call, so it sizes a profile or picks a target inside the limits instead of meeting each cap as a separate refusal.
The allowlist is listed in full: it is user configuration, not a secret, and `checkAllowlist` already prints the whole list on any refusal.
The three gates (`allowWrites`, `allowNetworkSettings`, `revealSecretsToAgents`) are on/off only, and `disabledTools` is reported as a count, because the server instructions name no tool and `tools/list` is already the authority on which exist.
`maxResponseSamples` is not in the answer; the other four caps are.
The server instructions name all four load caps (RPS, virtual users, duration, iterations) without their values.

The renderer never sets these directly: `main.ts` sanitizes every change (`sanitizeSafetyInput` - normalizes/de-dupes hosts, holds each cap to a whole number between 1 and its ceiling, trims and de-dupes `disabledTools`) before applying it live and writing it to disk.
The same sanitizer runs over the persisted file on load and over the CLI's `VAYU_MCP_*` variables, so no path reaches the guards with a cap outside that range.

A `mcp-config.json` that does not parse (or parses to something other than an object) loads as the locked-down defaults rather than failing the start.
The first write over it renames it to `mcp-config.json.corrupt-<epoch-ms>` in the same folder, so the allowlist and caps in it can be copied back by hand.
One copy is kept: corrupting the file again replaces the earlier copy (issue #2433).

The file also holds the server's `port` (#3580), 9877 when it has none.
A port is a whole number from 1024 to 65535 that is not one of the engine's own ports (9876 and 9880 to 9889), checked when Settings saves it and again on every read, since the file is hand-editable: a stored value outside that loads as 9877, and `mcp:status` carries `storedPortError` saying so.
There is no fallback when the configured port is taken; the status names the conflict, as it does for 9877.
Every engine spawn reads the port afresh and passes it as `--mcp-port`, which is what the engine's own-port refusal compares against, and the listener binds the port the engine was given rather than the saved one.
A spawn that will guard another port than the listener holds stops the listener first (`releaseForSpawn` in `lifecycle.ts`, awaited by the sidecar before it spawns), so no engine the app started runs while the server holds a port that engine does not guard.
A saved port therefore takes effect on the next engine restart: `mcp:setPort` only persists, the status reports `restartRequired` until then, and once the restart settles, either way, `restartEngine` binds the listener on the port the last spawn guards (`followEndpoint`).
The server is down for the length of that restart; a server switched off stays off.

The **ceilings** are `MCP_CAP_CEILINGS`, mirroring the renderer's `LOAD_TEST_CEILING_BOUNDS` maxima - the engine's own guards where it has one (`concurrency` at 10x `event_loop::MAX_CONCURRENT`, `durationSeconds` at the per-transfer timeout guard); `maxResponseSamples` is the engine's `run_config::MAX_RESPONSE_SAMPLES` itself, since the load dialog sends no sample count.
A cap set above its ceiling is held there rather than stored: the value it would admit is one the engine refuses or one no Vayu surface will compose, so storing it shows a guardrail that does not exist.
The copy is tied to the renderer constant by `config.test.ts`, the way `MAX_IN_FLIGHT_BOUND` is - `electron/` may not import `src/`.

`maxRps` and `maxConcurrency` bound **different runs**, which is why neither is a general "load cap":
`targetRps` exists only in `constant_rps` (the engine refuses it on every other mode, #2396), so `maxRps` is inert against a closed-loop run -
though the cap is read from any positive `targetRps` before the engine's refusal, so an over-cap rate on another mode is refused for its size first, and `maxConcurrency` bounds the virtual users a closed-loop run holds (or a ramp starts from, or a capacity search climbs to) - not the in-flight requests of a rate-paced run, which `maxInFlight` governs.
