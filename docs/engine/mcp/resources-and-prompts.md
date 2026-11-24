---
description: >-
  The read-only resources and the prompts the Vayu MCP server offers an agent, including the script sandbox surface and the element catalogue.
---

# MCP resources and prompts

## Resources

Read-only Vayu data an agent can attach as context (`resources.ts`):

| URI                         | Contents                         |
| --------------------------- | -------------------------------- |
| `vayu://runs`               | The most recent 100 runs (first page), newest first; `pagination.total` / `hasMore` in the content carry the full count. A resource takes no arguments, so filtering and paging beyond this page is the `list_runs` tool's job. Masked as `list_runs` is. |
| `vayu://collections`        | All request collections as a bare array, unpaged, each shaped as a `list_collections` full row (a declared data-file contract as `dataSchema`, none as no key; a remembered file as `dataFile`; secrets withheld the same way). |
| `vayu://environments`       | All environments, secret values withheld as `list_environments` withholds them. |
| `vayu://variables/resolution` | The resolution rule set: tier order, disabled/non-string handling, reserved namespaces, and what a script's scoped and merged reads see. See [Variables](saved-data.md#variables). No tool serves it, since it is a fixed rule set rather than engine data: the server instructions state the tier order and the rules for a client that cannot read resources (#3559). |
| `vayu://config`             | Engine configuration entries, a URL entry's credentials withheld as `get_engine_config` withholds them. |
| `vayu://scripting/completions` | The script sandbox's full API surface (see below); `get_script_api` reads the same projection by tool. |
| `vayu://scripting/types`    | The same surface as TypeScript declarations - the `.d.ts` the app's editor loads, so a call's parameters and return type are the running engine's. |
| `vayu://elements/kinds`     | The element registry's catalogue (see below): every kind's category, phases, hot-path class and config JSON Schema; `list_element_kinds` reads the same projection by tool. |
| `vayu://run/{runId}/report` | A run's full report (templated), masked, bounded (the 32 KB body cap and the trace budget) and marked `partial` while the run is unfinished, all as `get_run_report` is (`readRunReportForAgent`, #3557). |

The templated report resource has a **list** callback (enumerates recent runs so each shows in `resources/list`) and a **completion** callback (autocompletes run IDs).
With the engine unreachable the list callback answers no runs, so the static resources above still list (#3577); any other failure still fails the list.
Every resource, prompt and completion callback words an unreachable engine the way a tool does (`server.ts`, `worded`): a read of `vayu://scripting/types` with the engine down fails with `Could not reach the Vayu engine ...` and the host's remedy, not a bare `fetch failed`.
Other failures keep their own text: an engine refusal's body is unmasked engine text, and the interrupted-call advice describes a tool call that may have completed, which a read never was.

### The script sandbox surface

`preRequestScript` and `postRequestScript` run in the engine's QuickJS sandbox, which is the same sandbox the app's editors target.
There is exactly one per-client capability gate inside the sandbox - `pm.sendRequest`, below - and, with reveal on, an agent can do anything else a script in the app can.
With reveal off the agent cannot supply a script to a send or a load run at all (see [*Scripts an agent supplies are refused*](request-composition.md#request-composition)), though it can still read this surface to understand the scripts stored in the app.
What an agent lacked was any way to *know* that: until issue #233 the entire script surface it could see was the two sentences in those fields' descriptions, so `pm.expect` chains, `pm.response.to.*`, the variable scopes and `pm.crypto` were invisible and simply never attempted.

Two resources, because a name and a signature are different questions.
`vayu://scripting/completions` re-serves `GET /scripting/completions` (Monaco's own fields projected away) and answers *what exists*; `vayu://scripting/types` re-serves `GET /scripting/types`, the `.d.ts` the engine generates from the same table, and answers *what it takes and returns* (issue #760).
Both throw rather than serve a partial surface - an agent reading a truncated API list concludes the sandbox cannot do what it can - and neither holds a copy of the surface here, which is the whole point: the app's own quick-reference panel had gone stale before #233 and this is what replaced it.

`get_script_api` reads the completions by tool (#3559), for a client whose model reads tools and not resources (Zed's documentation says it supports MCP's tools and prompts).
It runs the same `projectScriptingSurface` the resource does, so the two cannot disagree.
Unfiltered it answers each entry's `label` and `detail`, the name and its signature, because the documented surface is about 100 KB; `q` narrows to the entries whose label, detail or documentation contains it and adds their `documentation`.
The `.d.ts` stays a resource only: it is for editors, and the signatures a tools-only agent needs are the `detail` lines.

### The element catalogue

`vayu://elements/kinds` re-serves `GET /elements/kinds`, the element registry's catalogue (issue #1513): every kind's `category`, the `phases` it runs at, its `hotPathClass` and its `configSchema` - the same shape the app's generated element forms read (issue #1516).
`create_request` / `update_request` / `create_collection` / `update_collection`'s `elements` argument and `run_request`'s ad-hoc `elements` argument both name a `kind` as a bare string rather than an enumerated one, precisely so a kind the engine adds later needs no MCP change - read the catalogue rather than guessing a kind or its config shape.
`list_element_kinds` reads it by tool (#3559), through the resource's own `projectElementKinds`: a summary row per kind (`kind`, `category`, `phases`, `label`) by default, since the whole catalogue is about 21 KB and most of it is config schemas, and with `kind` that one kind's entry, `configSchema` included.
An unknown `kind` is an `input` error naming every registered kind, as the engine's own refusal of one in an `elements` list now does.
The `elements` argument's `kind` and `config` descriptions name the tool first and the resource second.
A property with a `default` in that schema is run with that value when its key is left out, so an agent omits the key rather than restating it (`assert.size` with no `op` compares `lte`, an `extract.*` with no `scope` writes the collection scope; issue #3045).
`element-kinds.conformance.test.ts` pins the resource, the tool's rows, the schema's own examples and every kind literal a tool description names to the engine's own fixture, so a kind renamed engine-side without a matching update here fails the build rather than telling an agent to write a kind that no longer exists.

#### `pm.sendRequest` is refused for MCP-started runs

The sandbox can send an auxiliary request (issue #302).
That would be a hole in the allowlist if it applied here, and the reason is structural rather than an oversight: **the allowlist is checked in this server, against the composed URL, before it calls the engine, and handed to the engine as `targetPolicy` for the URL a send is about to dial** (#2521).
A request issued from inside a script with `pm.sendRequest` goes through neither - it is not the send's URL - so it could never be checked: an agent that can write a script would otherwise reach any host, defeating a control the user set in Settings.

Three ways to close that were available, and this is which one and why:

- *Move the allowlist engine-side for script-issued requests.*
  Rejected when this was decided (#302): the allowlist lives in the app's config, and the engine had no channel to it, so it would have needed a second implementation of host matching alongside `safety.ts`'s -
  two copies of a security check, which drift. #2521 has since added that channel and a second matcher for the send's own URL and OAuth 2.0 token endpoints (`targetPolicy`), because a pre-request script can retarget those.
  It still does not reach a `pm.sendRequest`, and the choice below stays the control for those.
- *Gate the feature off by default behind a setting.*
  Rejected.
  It adds a knob whose safe position is the only correct one for MCP, and the hole reopens the moment anyone flips it for an unrelated reason.
- **Refuse script-issued requests unless the caller explicitly asks.**
  Chosen.
  The engine denies `pm.sendRequest` unless the execute/run payload carries `allowScriptRequests: true`.
  The app's own Send and load runs ask for it, each in the one service method that owns that call (`apiService.executeRequest` and `executeStreamRequest` - Send's two halves - plus `startLoadTest` / `startScenarioRun`); this server never does.
  The allowlist stays exactly where the user configured it, and the engine gains a capability bit rather than a policy copy.

Denying by **default** is the load-bearing half: a new tool here, or any future engine client, gets a script that cannot send rather than unchecked egress.
An agent cannot set the field either - every tool builds its request from named arguments, and no tool declares `allowScriptRequests`, so a call naming it is refused as an unrecognized key before any handler runs.

A script that calls `pm.sendRequest` under MCP throws a message saying why, so an agent is told rather than left with a silently missing global.
The completion entry states the same thing, so the surface an agent reads and the surface it gets agree.

`vayu://scripting/completions` closes that.
It re-serves the engine's own `GET /scripting/completions` - the single source of truth that also feeds Monaco, generated from one table in `engine/src/http/routes/scripting.cpp` and cross-checked against the runtime by `script_completions_test.cpp`.
Notably it carries `pm.crypto.sha256` / `.hmacSha256` and the `btoa` / `atob` globals, and their documentation states they are **synchronous** (the sandbox has no event loop, so nothing Promise-based would ever settle).

Each entry is trimmed to `label`, `detail` and `documentation`; Monaco's own `insertText`, `insertTextRules`, `sortText`, `filterText` and `kind` are dropped, since snippet placeholders and a `CompletionItemKind` enum mean nothing outside an editor.
The trim is the only transformation - **no list of `pm.*` names is maintained app-side**, which is the point: a name the engine adds reaches agents with no second edit, and `resources.test.ts` fails if the resource ever answers from a local literal instead of the engine.
The script fields' descriptions name `get_script_api` first and this resource second, for an agent that never lists resources.

## Prompts

Server-provided starting points a user picks in their client (`prompts.ts`):

| Prompt                 | Arguments                | Produces                                                    |
| ---------------------- | ------------------------ | ----------------------------------------------------------- |
| `summarize_run`        | `runId`                  | The run report (masked, bounded and marked `partial` as `get_run_report` is) + a "summarize p50/p95/p99, errors, health"; tells the model to read `partial` first and not to call an unfinished run healthy or concerning (#3557). |
| `compare_runs`         | `baseRunId?, targetRunId` | The computed delta, its `comparability` list (which the prompt tells the model to read first) + "did this regress?". Two runs of different types get the tool's refusal instead, with no delta embedded. An omitted `baseRunId` resolves the target's pinned baseline through the same `resolveBaseline` the tool uses - the prompt demanded an id Vayu already knew (#760). |
| `diagnose_errors`      | `runId`                  | The report (masked, bounded and marked `partial` as `get_run_report` is) + an error-focused diagnosis prompt, with the same read-`partial`-first instruction (#3557). |
| `suggest_load_profile` | `url, goal?`             | Guidance to design a `start_load_run` (no engine data); tells the model to read `get_safety_config` first, so a profile is sized to the session's caps and allowlist (#2444). |

`summarize_run`, `compare_runs` and `diagnose_errors` each state the engine's one error definition in their text, from `error-definition.ts`'s `RUN_ERROR_DEFINITION_SENTENCE` (issue #2124), and so does the `vayu://run/{runId}/report` resource.
Of the tool descriptions only `get_run_report` carries the whole sentence; `get_live_metrics`, `compare_runs`, `get_run_timeseries` and `export_run_report` carry `RUN_ERROR_DEFINITION_POINTER`, one line giving the two halves of the definition and naming `get_run_report` for the rest, because the sentence repeated in five descriptions was most of what `tools/list` spent on it (#2441).
An agent reading `errorRate` is told what counts: a status outside 2xx/3xx or no response, a 3xx being a success, with the `httpErrors` / `noResponse` split beside the count.
The fields themselves are the engine's, passed through unchanged (see [What counts as an error](../api-reference/metrics.md#what-counts-as-an-error)), including the separate `cancelled` / `cancelledRequests` count of requests a Stop cancelled, which is no error (issue #2136); the sentence says so in a clause of its own and names `cancelledRequests` as where it is reported.
