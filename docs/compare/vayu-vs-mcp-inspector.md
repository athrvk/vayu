---
title: "MCP Inspector alternative: Vayu vs MCP Inspector"
description: >-
  The MCP Inspector is the reference tool for exploring an MCP server. Vayu is
  stateful regression and load testing for MCP servers, saved as requests in
  collections next to your plain HTTP ones.
---

# Vayu vs MCP Inspector - stateful, mixed-protocol regression and load testing for MCP servers

Both tools send real calls to a running MCP server - `tools/call`, `resources/read`,
`prompts/get` - show you what came back, and can repeat a call many times at once to
see how the server copes. The MCP Inspector is the first-party reference developer tool
for **exploring and debugging** a server, in a browser, a terminal or a script. Vayu is
an API client with a load engine inside it, and an MCP call is one **request body mode**
of an ordinary saved request, so it is built to **keep** a server's behaviour: saved
requests, ordered scenarios that carry data between steps, assertions, run history and
comparison between runs. They overlap on load testing and diverge on what
happens around it.

!!! note "Two different MCP pages"

    This page is about testing an MCP server with Vayu. For Vayu's own MCP server that
    lets coding agents drive Vayu, see [MCP Server](../engine/mcp/index.md).

| | Vayu | MCP Inspector |
|---|---|---|
| **What it is** | An API client and load engine; an MCP call is a request body mode | A developer tool with Web, CLI and TUI clients\* |
| **Transports** | Streamable HTTP, protocol revision `2026-07-28` only | stdio, SSE and HTTP servers, legacy and modern eras\* |
| **Interactive use** | The request builder's `mcp` mode: a JSON call editor, the tool and its schemas set by hand or filled in by an import, the tool result drawn above the raw reply | The tool's input schema rendered as a form, results rendered, Protocol and Network tabs\*\* |
| **Saved suites** | Requests in collections, run in order, with data-driven rows | Load scenarios as a JSON file of independent weighted calls\*\*\* |
| **Data between steps** | `extract.json` and `extract.header` feed later steps; state is per virtual user under load | The documented scenario step keys have no extraction field\*\*\* |
| **Assertions** | JSONPath, JSON Schema (draft-07) and a `tools/list`-style snapshot, on the run itself | The documented scenario step keys have no assertion field\*\*\* |
| **Load shapes** | Constant rate, constant users, a ramp-up, a fixed iteration count, a capacity search | Concurrency, rate, duration or count, warm-up, open loop, stepped stairs\*\*\* |
| **CI gate on a run** | A thresholds block judges the run; the command line starts a run and does not exit on a verdict | Thresholds and baseline regression exit `10`\*\*\* |
| **Per-call output** | Aggregates plus a bounded set of kept traces (failures, status exemplars, slowest, a sample); no record of every call | One NDJSON line per call from the CLI\*\*\* |
| **Failure classes in reports** | `tool`, `protocol` and `transport` counts per run, compared run to run, each with its own budget | `isError` results counted apart from thrown errors\*\*\* |
| **Authorization** | Request auth, plus a sign-in discovered from an MCP server URL and a Re-authorize offer in the request builder; a run never re-authorizes | Full OAuth flow, re-authorization and step-up\*\*\*\* |
| **Scale-out** | One process on one machine | `--load-workers` child processes\*\*\* |

\* **Source:** the Inspector's [overview](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector):
the `@modelcontextprotocol/inspector` package with web, `--cli` and `--tui` clients, "the
reference developer tool for testing and debugging MCP servers", stdio servers in its
quickstart, and negotiation between the legacy and the modern 2026-07-28 era. Checked on
2026-11-26.

\*\* **Source:** the Inspector's [web client page](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/web):
the tool's input schema "rendered as a form", a result rendered with structured content,
embedded resources and images, a Protocol tab with the JSON-RPC exchange, and a Network
tab for HTTP and SSE servers, with entries that can be cleared or exported. Checked on
2026-11-26.

\*\*\* **Source:** the Inspector's [load testing page](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/load-testing).
It documents `--load-concurrency`, `--load-duration`, `--load-requests`, `--load-rate`,
`--load-warmup`, `--load-open-loop`, `--load-steps` and `--load-ramp` (stairs, "rather than
a continuous ramp"), the thresholds `--load-max-error-rate`, `--load-max-p50`/`p95`/`p99`
and `--load-min-throughput` (a breach exits `10`), `--load-baseline` with
`--load-max-regression`, NDJSON per call through `--output`, and `--load-workers` as child
processes in the CLI only. A scenario step takes `method`, `tool`, `uri` or `prompt`,
`args`, `meta`, `weight` and `name`, and "any other key is an error", so the documented
keys include no extraction or assertion field. Its summary counts `isError` results
(`toolErrors`) apart from calls that never produced a result (`errors`). Checked on
2026-11-26.

\*\*\*\* **Source:** the Inspector's [authorization page](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/authorization):
the full authorization flow in all three clients with tokens shared between them, and
re-authorization on a `401` or step-up on a `403 insufficient_scope`. Checked on
2026-11-26.

## What the `mcp` mode sends, and what a failed reply is

An `mcp` body is one call to an MCP server over the Streamable HTTP transport, modern era,
revision `2026-07-28`. The engine writes the `_meta` block and the headers the revision
mirrors out of the body (`Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`), for Send, a collection
run, a load run, the command line and Vayu's own MCP `run_request`, so nobody keeps them in
step by hand. Detail: [The `mcp` body](../engine/api-reference/request-body.md#the-mcp-body).

A reply is read once, where each driver hands it on, and a failed one carries one of three
classes: `transport` (no reply, a bad status, a stream cut short), `protocol` (a JSON-RPC
`error`) and `tool` (`result.isError`). **A failed reply fails the step the way a failed
assertion does**, so a regression run goes red on a tool that reports an error instead of
turning green on a `200`. Detail:
[The `mcp` reply](../engine/api-reference/request-body.md#the-mcp-reply).

Vayu speaks only the modern era. A legacy-era server, the kind that opens with `initialize`
and a session id, can be approached with hand-built steps (an explicit `initialize` request, then
`extract.header` on `Mcp-Session-Id` feeding the later calls), which this page does not
promise works against every server. There is no automatic fallback
and no hidden session state, and a refusal names the era mismatch instead of retrying
([the reply reader](../engine/api-reference/request-body.md#the-mcp-reply)). If most of
your servers are legacy-era, or speak stdio, that alone decides it.

## Stateful scenarios and assertions are the dividing line

The Inspector's scenario is a weighted mix of independent calls, which is the right model
for "what does this server do under realistic traffic". A Vayu scenario is a collection run
in order: each step is an ordinary request, so a step can use any body mode, and `mcp` is
one of them. A reply can feed the next step through `extract.json` or `extract.header`, a
data file binds one row per iteration, and under load each virtual user keeps its own
extracted state rather than writing into a shared one. Detail: the element
[Kinds](../engine/elements.md#kinds) and [Load paths](../engine/elements.md#load-paths).

The assertions run on the reply the server meant, not on the raw event stream.
`assert.jsonpath` addresses `$.result.content[0].text` whether the reply came as one JSON
object or as a stream of notifications ending in the response. `assert.jsonschema` holds
`$.result.structuredContent` to a schema, and `assert.snapshot` holds the answer to
`tools/list`, `resources/list` or `prompts/list` to a recorded baseline, matched by name, so
a renamed or dropped tool fails the step. One limit to know before you rely on the schema
assertion: the validator is **draft-07**, and a keyword from MCP's default 2020-12 dialect
that it does not evaluate (`unevaluatedProperties`, `prefixItems`) fails the assertion
loudly rather than passing unchecked. The request builder prefills a new schema assertion
from a stored `outputSchema`; the engine itself never reads that field. A request made by
[importing a server](#importing-a-server) stores no `outputSchema`, so nothing is prefilled
there until the schema is pasted into the request's Output schema field. Detail:
[Kinds](../engine/elements.md#kinds).

## Reports that name the failure

A run summary and the history report carry `errorClasses`, the `tool`, `protocol` and
`transport` counts, with the JSON-RPC codes behind the `protocol` ones. Comparing two runs
diffs those counts, so "the same load, with more tool errors than last week" is a figure
rather than a read of two logs. In a scenario load run, an `mcp` step is labelled with its
call (`tools/call search`), so the latency row says which tool it measured. Detail:
[the run report](../engine/api-reference/runs.md#get-runsrunidreport),
[the run export](../engine/api-reference/export.md#post-exportrun-report) and
[scenario load runs](../engine/api-reference/scenario-load.md#scenario-load-runs).

The verdict is the [thresholds block](../engine/api-reference/load-runs.md#the-thresholds-block-passfail-budgets).
Beside the latency, error-rate and throughput budgets it holds six on the MCP failure classes:
`maxToolErrors`, `maxProtocolErrors` and `maxTransportErrors`, and the same three as a
percentage of the run's requests (`maxToolErrorRatePct` and its two kin). `0` is a legal
ceiling, so "no tool call may fail" is a budget, and the load test dialog offers all six. A failed
MCP reply also counts toward `maxErrorRatePct` like any other error. The command line does not
turn a verdict into an exit code ([CLI](../engine/cli.md#error-handling)).

## Importing a server

The Import dialog's **MCP server** tab takes a server's URL, headers and an optional bearer token,
asks the live server what it offers (`tools/list`, optionally `resources/list` and
`prompts/list`, following pagination) and previews a collection: one folder per primitive and
one `mcp` request per listed entry. Nothing is stored until Import applies it, as on the other
tabs. A tool's request carries its `mcpTool` (the name and `inputSchema`, so the `Mcp-Param-*`
headers are derived), arguments drawn from the schema (the required properties only, each from
its `const`, `default`, `example` or first `enum` member, else a typed stub) and an
`assert.status` on `200`. The reply's own failures, a JSON-RPC error or a tool's `isError`,
fail a step without an assertion. Two limits: imported tools carry no `outputSchema`, so a new
`assert.jsonschema` is not prefilled, and the dialog sends a static bearer token with no OAuth
sign-in ([#3983](https://github.com/athrvk/vayu/issues/3983)). Detail:
[MCP server import](../app/import-collections/mcp-server.md) and
[`POST /import/mcp`](../engine/api-reference/import.md#post-importmcp), the engine route
behind it.

## Other tools in this space

- **Postman** has MCP requests to "experiment, test, and evaluate" MCP servers, with scripts
  and tests that run in the Collection Runner. Source: Postman's
  [MCP requests overview](https://learning.postman.com/docs/postman-ai-agent-builder/mcp-requests/overview/).
  Checked on 2026-11-26.
- **MCPJam** describes itself as an open-source testing and evaluations platform for MCP
  servers, with a Playground, an OAuth debugger and servers over HTTP or STDIO. Source: the
  [MCPJam docs](https://docs.mcpjam.com). Checked on 2026-11-26.

## When to choose the MCP Inspector

For exploring and debugging a server, and for a long list of load features, the Inspector is
the better tool, and several of these are not close:

- **You are building or debugging a server.** It is the reference developer tool, the input
  schema becomes a form, and the Protocol and Network tabs show the exchange. Vayu's
  request builder has the JSON editor and a rendered tool result, but a request you build by
  hand has its tool and schemas typed in (an import fills them), and there is no MCP-specific
  browser for tools, resources and prompts.
- **Your server uses stdio, or the legacy era.** Vayu has no stdio transport and speaks
  the modern Streamable HTTP era only.
- **You need MCP's authorization flow across a whole session.** The Inspector runs the OAuth
  flow in all three clients and steps up on `insufficient_scope`. Vayu's request builder
  discovers a server's OAuth endpoints (protected-resource and authorization-server
  metadata, PKCE, dynamic registration) and offers a Re-authorize after a `403
  insufficient_scope`, but that is a button, not an automatic flow. A run reports the `403`
  as a `transport` failure naming the missing scope, never re-authorizes, and a load run
  cannot sign in. Detail:
  [discovery from an MCP server URL](../engine/api-reference/authentication.md#discovered-from-an-mcp-server-url).
- **You want its load features.** Stepped and ramped stairs, a warm-up, a weighted mix with
  an exact ratio, baselines with a regression budget, a `--load-max-p99`-style exit code
  for CI, an NDJSON line per call, session churn and `--load-workers` are documented on
  its page. Vayu has no user-declared stepped stairs (its capacity search steps adaptively),
  no step weights (a `control.throughput` element runs a step for a share of occurrences, which
  is not a mix of independent calls), no baseline-regression budget that fails a run, no
  per-call NDJSON and no multi-process generator.
- **You test notifications or the other MCP surfaces.** Subscriptions, `listen` and
  notification fan-out load, and the Apps, Skills and Tasks surfaces are outside Vayu. It is
  not an LLM playground or an evals tool; MCPJam describes itself as one.

## When to choose Vayu

- **The server is Streamable HTTP and you want a regression suite for it**: saved requests
  in a collection, an ordered scenario that passes a value from one reply to the next, data
  files, and assertions on the reply, where a failed tool call fails the step.
- **MCP calls sit beside plain HTTP in the same scenario.** `mcp` is a body mode of an
  ordinary request, so one collection holds the login call, the MCP calls and the REST
  check that confirms them.
- **You want runs you can compare.** History keeps your recent runs (200 by default, and a run
  pinned as a baseline is never pruned), `errorClasses` separates tool errors from protocol and
  transport ones, each class can carry a budget, and one run is compared against another.
- **You already use Vayu for the HTTP side.** The load engine, the live dashboard and the
  exports are the same ones, pointed at an MCP request.

The honest summary: for one server on one machine, the Inspector explores it better and
load tests it with more shapes; Vayu keeps the multi-step, asserted version of the same
calls and the history around it.

## Try it

Windows:

```powershell
winget install athrvk.Vayu
```

macOS and Linux:

```sh
bash -c "$(curl --proto '=https' --tlsv1.2 -fsSL https://athrvk.github.io/vayu/install.sh)"
```

[Full install detail](../index.md#install){ .md-button .md-button--primary }
[Compare with k6](vayu-vs-k6.md){ .md-button }
