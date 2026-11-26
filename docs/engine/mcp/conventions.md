---
description: >-
  How every Vayu MCP tool is shaped - categories, annotations, schemas, argument names and result format - and how a failed call is reported.
---

# MCP tool conventions

Every tool carries a `category` (surfaced in Settings for enable/disable), MCP **annotations** (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` + a display title), and a strict **Zod** input schema (arguments are validated by the SDK, and an undeclared one is refused; see [Error results](#error-results)).
Every **read** tool declares an `outputSchema` and returns validated `structuredContent` alongside the text rendering, except the three whose answer is not an object: `list_environments` and `list_client_certificates` answer a bare JSON array, and `export_run_report` answers the document's own text.
An `outputSchema` is object-rooted, and reshaping those answers would break every agent that reads them.
The read schemas are loose and name only the stable keys, so a field the engine adds still arrives; a non-object engine answer is wrapped as `{ "raw": ... }` rather than refused, because the SDK reports a rejected result as a broken tool and hides the body.
`output-schema.conformance.test.ts` fails a read tool that is on neither side of that line, and an exception that stops being true.
`run_request`, an execute tool, declares one too (#3749): loose and every member optional, one schema for the buffered exchange and a streamed read alike.

**Result text is compact JSON** (#3560): `JSON.stringify` with no indent in every tool result, resource and prompt that embeds JSON, because the reader is a model's context window and indentation is cost with no reader (about 50% more bytes on a nested answer).
A result with `structuredContent` sends the same document in both places.
`tools.output-schema.test.ts` ("result text is compact JSON") fails when a pretty printer returns to `jsonResult`, `structuredResult` or a tool built on them; the resource and prompt sites are not pinned by a test.

**Argument names are uniform** (#2446), held by `schema-naming.conformance.test.ts` over every tool's top-level inputs: an id is named for what it identifies (`requestId`, `runId`, `entryId`, `itemId`), never a bare `id` (no exceptions), and a `limit` comes with an `offset`.
The one exception is listed in the test with its reason: `get_live_metrics`, which answers the tail of a ring buffer and so has nothing to page from.

The four categories partition tools by what they can do - and thus which gate applies:
**read** (inspection; returns workspace data, with secrets withheld unless the user enables reveal - see [Secret values](secrets.md#secret-values), which also covers what a **write** tool answers and what a run output reads as),
**execute** (has an effect outside this process without touching saved data - allowlist when it sends real traffic to a target, none when the effect is a loopback service the engine hosts, as for the mock issuer), **write** (mutates saved data or engine config - write toggle), **load** (starts/stops load tests - allowlist + caps + confirmation).

### Error results

A tool that fails answers an MCP error result (`isError: true`) whose text says what went wrong and what to do, and whose `structuredContent` is the same failure for a machine (#2776):

```json
{ "error": { "class": "policy", "retryable": false, "advice": "Host \"x.example.com\" is not on the MCP allowlist. ..." } }
```

`advice` is the result's text.
A tool's `outputSchema` describes its success, and the SDK holds only a success to it, so the error shape is the same on every tool.
That includes the errors the SDK answers before any tool runs: an argument its schema check refuses (`Input validation error: ...`) is classed `input`, and anything else it catches (an answer its output check refuses) `transient`, by the wrapper `server.ts` puts in front of its `tools/call` handler.

**An argument a tool does not declare is refused, never dropped** (#3556).
Every tool's arguments object is strict (`argumentsSchema` in `app/electron/mcp/tools/kit.ts`, which `server.ts` registers each tool and prompt through), and so is every nested input object:
a request's header line, a stored header row, an element, a binary body's `file`, a variable entry, `start_load_run`'s `scenario`, `monitor` and `elements`, `run_collection`'s `elements`, a mock issuer's `clients` and an inbox's `response`.
The answer names the key, with its path when it is nested:

```text
Input validation error: Invalid arguments for tool start_load_run: scenario: Unrecognized key: "iterations"
```

So a misspelt `collection_id` on `list_runs` is an error rather than a list of every run, and nothing reaches the engine.
A prompt refuses an undeclared argument the same way, as a protocol error.
`tools/list` advertises it as `additionalProperties: false` on each of those objects.
Four shapes stay open on purpose: an `auth` block (each mode's members are the engine's), an OAuth 2.0 `config`, `thresholds` (a `custom.<name>.<stat>` budget is a key no schema can name) and every name-keyed map (`headers` as a map, `variables`, `data` rows, an element's `config`).
A row a read returns can be written back as read: a stored header row declares `valueWithheld`, `description`, `source` and `type`; a variable entry declares `valueWithheld` and `createdAt` (kept as stored) and `description` (written); a `file` declares `unresolved`, which is ignored.

`class` is one of five, set where the error is built (`errorResult` in `app/electron/mcp/tools/kit.ts`, which requires one) and mapped in `app/electron/mcp/tools/failure.ts`:

| `class` | `retryable` | What it means | Raised by |
|---------|-------------|---------------|-----------|
| `policy` | false | A rule the user or the endpoint sets refused it; the advice names who can lift it | The allowlist, the load and sample caps, write access off, a tool switched off in Settings, Reveal secrets to agents off (agent scripts, clearing a secret flag), Network settings off, an inline file body, `verifySSL: false` on a one-off send, the `authorization_code` grant, the engine's target-policy refusal, an engine 403, an endpoint that disallows introspection, no Vayu window to ask (`get_app_focus`, which the stdio CLI never has) |
| `input` | false | The arguments, or the request they name, are wrong; change them | A missing or malformed argument (including one the SDK's schema check refuses), an unknown tool, a URL whose host cannot be determined, a duration or iteration count that is not one, an argument that does not apply to the run, an engine 400, 409 (the id exists, the spec is still bound, the restore needs its parent) or 413, and every other engine 4xx |
| `not_found` | false | An id the call named does not exist | An engine 404, and the lookups that find no such run, collection, request, environment, example, inbox or trash entry; worded as below |
| `transient` | true | The engine was reached and the call did not complete; it may already have taken effect, so the advice says what to check first (per tool, below) | A client-budget timeout, a cancelled call, an engine 5xx including 507 (disk full) and the busy-database 503, a merge another client's write beat twice (`update_environment`, `update_collection`, `update_globals`: two `412`s, nothing written), an engine answer the server could not use, a secret-masking lookup that failed (when its cause is no engine failure, else it is worded as that failure, below), a 5xx from an endpoint `get_graphql_schema` introspects, and any error nothing above names (`Unexpected error: ...`) |
| `unreachable` | true | A host the call needs did not answer; retry once it is up | An engine that refused the connection, the 503 an engine answers while shutting down, an endpoint `get_graphql_schema` could not reach |

**An id that names nothing** (#2778) is answered with the missing object and the tool that lists them, on one line, with no HTTP path and no engine JSON:

```text
No run with id "run_x" (it may have been deleted or the id is mistyped). List runs with list_runs.
```

A tool declares what its id arguments are as `notFound` (`NotFoundDeclaration` in `app/electron/mcp/tools/contract.ts`): the object's `noun`, the `list_*` tool, and the argument (`idArg`) holding the id, with the kinds shared in `ID_KINDS` (`failure.ts`).
`describeFailure` words an engine 404 from it and the call's own arguments.
A tool taking several kinds (`update_request_example` takes a request and an example) declares one entry each, and the entry used is the one whose noun the engine's sentence contains ("Example not found"); an `idArg` that is a list (`compare_runs`' two run ids) names an id only when the engine's sentence carries it, since nothing else says which was missing.
A kind with no list tool (a spec, whose id comes from a collection's binding) ends at the cause.
A tool can also word a 404 by the engine's `code` (`notFoundByCode`, read from the flat `{"error", "code", "hint"}` body or the nested `{"error": {"code", "message"}}` one by `engineCode` in `failure.ts`), for a 404 that is not an unknown id.
`get_live_metrics` is the one that does: the engine answers `live_expired` for a run that is stored but whose live buffer has aged out, and the text is `The live buffer for this run expired (kept 60 s after it ends); the run still exists - read get_run_report(runId).`, in the `not_found` class, without the engine's `Use /runs/<id>/report` hint (the 60 s is the engine's `liveRetentionMs` default).
Its `run_not_found` keeps the unknown-id sentence above.
A 404 with no code (an older engine), a 404 the declaration does not describe, and a tool that declares nothing answer the engine's body instead.
A lookup a tool makes itself before it calls the engine (a delete that reads the row to name it in the prompt, a variable scope) words a miss with the same sentence (`unknownIdText`), so the text does not depend on which step noticed.
Every tool with a `<kind>Id` argument declares `notFound` or is on the named exemption list in `tools.dispatch.test.ts` with its reason.

Every other engine error is `Engine error (<status>): <body>` with the body on one line - JSON re-serialized without indentation, anything else with its whitespace collapsed - so the text of a 4xx or 5xx does not depend on how the engine happened to format the answer.
A 507 and a busy database keep their retry sentence after it.

**What a timed-out or cancelled call is told to check** (#2777) is a fact about the tool, so each tool declares it as `retry` (`RetryAdvice` in `app/electron/mcp/tools/contract.ts`) and `describeFailure` writes it.
The failure carries only the lead ("The engine did not answer within this client's 130s budget.") and the tail; the advice between them comes from the tool:

| `retry` | Tells the agent | Declared on |
|---------|-----------------|-------------|
| `{ check, noun }` | The call may have completed: call `check`, find the `noun`, and do not retry blindly - a retry creates a second one | Creates and imports: `create_collection`, `create_request`, `create_request_example`, `create_environment`, `import_document`, `start_mock_server`, `start_mock_issuer`, `start_webhook_inbox` |
| `"never-blind"` | It may still have completed: check run history (`list_runs`) before retrying | Sends and run starts: `run_request`, `run_collection`, `run_collection_smoke`, `start_load_run` |
| `"safe"` | Repeating the call is safe | Reads and re-applicable writes that do not carry `idempotentHint: true`: `list_request_examples`, `get_live_metrics`, `get_mock_activity`, `get_inbox_captures`, `update_environment`, `update_globals`, `sync_spec`, `bind_spec`, `fetch_oauth2_token` |

A tool annotated `idempotentHint: true` needs no declaration and is told `safe`.
Any other tool must declare one (`tools.failure-classes.test.ts` scans the registry), because a tool that declares none falls back to the `never-blind` wording, which sends an agent to run history for a call that never wrote a run.
