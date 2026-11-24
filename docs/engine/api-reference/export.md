---
description: >-
  The export routes: a Postman collection, a Postman environment and a run report.
---

# Export

## POST /export/postman

A collection and everything beneath it as a Postman Collection v2.1.0 document, written the way Postman's own "Export > Collection v2.1" writes one (`core/postman_export.hpp`).
It is the inverse of the Postman importer: a collection imported from a Postman export and exported again gives back the same document, `_postman_id` aside, and exporting, importing and exporting again is byte-identical.
Each `item[]` lists a collection's sub-folders and requests in its one [sibling order](resource-writes.md#ordering) (#2535), so a request that sits before or between folders is written there, which is where Postman runs it; the Postman importer reads that order back.

**Reads only.**
Nothing is stored.
The whole subtree is exported, with no stop at a collection bound to another OpenAPI document.

**Request:**
```json
{
  "collectionId": "col_9a1f...",   // Required, non-empty
  "includeSecrets": false          // Optional - default false
}
```

`includeSecrets: false` writes every credential as `""`: a bearer token, a basic or digest or NTLM password, an API-key value, an OAuth 2.0 client secret or password-grant password, an AWS key pair or session token, and the value of a variable marked secret.
The auth modes kept as a `config` bag (AWS, digest, NTLM, Hawk, OAuth 1.0, EdgeGrid, JWT, OAuth 2.0's own config) are blanked by an allowlist of the members known to describe the auth, not by credential name, so a member no list has heard of (Insomnia's IAM `secretAccessKey`) leaves blank.
The `jwt_bearer` grant's non-secret members are on it, its `privateKey` reference survives, and its `privateKeyFile` path is blanked and counted (the grant itself is not written as a Postman grant, see `oauth2_settings` below).
OAuth 2.0's extra request parameter rows and the `jwt_bearer` grant's `assertionClaims`, in its config and in a kept Postman block alike, keep their keys; a row's value is blanked when its key names a credential (`client_secret`, `client_assertion`, `password`, `Authorization`, `X-Api-Key`, the other names a header or query parameter is blanked by).
A credential outside an auth block is blanked too, by name, wherever the document writes a value as typed or as recorded:

- a request header whose name is sensitive (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`, `X-CSRF-Token`, the other names the logger redacts) or is the header an API-key auth in force for the request names, enabled or not; the row and its name stay.
  The auth in force is the request's own, or the nearest folder's when it inherits;
- a query parameter by the narrower name set of the Params table (the same names less the generic `code` and `key`, plus `secret`, `signature`, `x-amz-signature` and the like, plus an API-key auth's own parameter), in the Params rows and in the URL's `raw` query and fragment, and the password of the URL's `user:pass@` (the user name stays);
- on every saved example, the recorded request's headers and URL by the same rules, the response's `header[]` by the header names (a `Set-Cookie` row included, in full), and the value of every `cookie[]` entry whatever its name (the name, path, flags and expiry stay).
  An example written from the request's current state carries the request's own blanked rows.

A value that is exactly one `{{variable}}` reference names a secret without being one and is kept.
Each blanked value is counted in `secretsOmitted`; a credential the document writes twice with one source - a query parameter in the URL and in the Params table, an example's `originalRequest` copied from the request - is counted once, while a `Set-Cookie` row and the `cookie[]` value it sets, or a recorded `Authorization` header and the `auth` beside it, are two written values and count twice.
A **body** is never judged (a response example's body, a request body outside the form-data file rule) and cookie names are not either, so neither is blanked.
`true` writes everything as stored, which is what Postman's own export does, and is byte for byte what it was before these rules.

**Response:**
```json
{
  "text": "{\n\t\"info\": {\n\t\t\"_postman_id\": \"9a1f...\",\n ...",
  "fileName": "Pet Store.postman_collection.json",
  "notes": {
    "requestsExported": 12,
    "foldersExported": 3,
    "secretsOmitted": 2,
    "notCarried": [
      { "code": "vayu_elements", "count": 4,
        "message": "Assertions, extractors, timers, controllers, metrics and setup or teardown scripts have no Postman equivalent" }
    ]
  }
}
```

- `text` is `JSON.stringify(document, null, "\t")`: tab-indented, no trailing newline, keys in the order Postman writes them.
  `info.schema` is `https://schema.getpostman.com/json/collection/v2.1.0/collection.json`; `info._postman_id` is the collection id when that is a UUID, the UUID an engine id ends in (`col_<uuid>`), or else a version-8 UUID derived from the id.
  No `_exporter_id` or `_collection_link` is written.
- `fileName` is `<collection name>.postman_collection.json`, with every character a filesystem refuses (`<>:"/\|?*` and control characters) replaced by `_`.
- `foldersExported` counts the folders beneath the collection, not the collection itself.
- `notCarried` has one entry per kind of stored thing the format cannot carry, in a fixed code order, each with its count and a short phrase; an empty array means everything was carried.

| Code | Written when the collection holds |
|------|-----------------------------------|
| `vayu_elements` | An element other than a pre-request or post-response script (assertion, extractor, timer, controller, metric, setup or teardown script) |
| `script_settings` | A script with a name or the load-test `inline` setting |
| `jsonrpc_bodies` | A JSON-RPC body, written as a raw JSON body holding the completed frame (`jsonrpc` and `id` added as on send) |
| `mcp_bodies` | An MCP body (Postman has no such mode), written as a raw JSON body holding its content as stored; the `Mcp-*` headers and `params._meta` the engine derives on send, and its `mcpTool`, are not written (the phrase: "MCP bodies were written as raw JSON, without their Mcp-* headers, _meta or mcpTool") |
| `unsupported_bodies` | A body in a mode Postman has no equivalent for, left out |
| `unsupported_auth` | An auth mode Postman has no equivalent for, left out |
| `oauth2_settings` | An OAuth 2.0 turned-off automatic token fetch or refresh, a token query parameter name, an empty header prefix, or the `jwt_bearer` grant (Postman has no RFC 7523 grant: the block is written with its endpoints, client id and scope and no `grant_type`, and the subject, claims and key are not written) (an `audience`, `resource` and the extra request parameter lists are written as Postman's `tokenRequestParams`, `authRequestParams` and `refreshRequestParams`) |
| `form_file_names` | A form-data file part whose file name differs from its path's own |
| `body_file_details` | A binary body whose file states its own `contentType`, or a file name that differs from its path's own - Postman's `file` mode carries only `src` |
| `http_version` | A request's HTTP version other than `auto` |
| `event_stream` | A request consumed as an event stream, or one storing a `streamTextPath` or a `streamFirstContentMarker` |
| `request_timeout` | A request with a timeout of its own (Postman has only an app-wide one) |
| `mock_response_mode` | A mock response mode other than `first` |
| `truncated_examples` | An example saved from a cut-off response, written with the partial body |
| `example_content_types` | An example content type no Content-Type header row states |
| `variable_types` | A variable typed `json`, or a secret typed `number`, `boolean` or `json`, whose one `type` slot holds `secret` (`number` and `boolean` are otherwise written as Postman's own types); each row counted once |
| `data_contracts` | A collection or folder data-file contract |
| `spec_bindings` | A collection or folder bound to an OpenAPI document |
| `spec_operations` | A request stamped as an OpenAPI operation |
| `rows_without_key` | A header, param or form row with a value but no name, left out |
| `typed_auth_headers` | A request with an enabled header row named like the header its auth in force writes (`Authorization` for bearer, basic and an OAuth 2.0 token placed in the header; the key of an API key in a header), written with `noauth` - counted once per request |

An auth a Postman import kept its original block for (`auth.postman`, see `docs/engine/db-schema.md`) is written as that block, while it still maps to the stored auth; everything below describes the rest.

A header the user typed under the name the auth in force writes wins in Vayu (`apply_auth` skips a name the request already carries, case-insensitively and whatever its value), while postman-runtime lets the auth overwrite the header.
The request is therefore written with `auth: {"type": "noauth"}` (also over an imported `auth.postman` block) and counted as `typed_auth_headers`, so the header Postman sends is the one Vayu sends.
Nothing is written for an auth that writes no header (a blank bearer token, an API key with no name or placed in the query, an OAuth 2.0 token placed in the query) or for a disabled row; a folder's or collection's auth is left as it is.

What maps where: folders are item groups (a folder's sub-folders and requests are written as one list in sibling order, a folder first on a tie); a request's `inherit` auth is an absent `auth` and its `none` is `noauth`, while a collection's or folder's `none` is an absent `auth` and its `noauth` is `noauth`; `aws` auth is `awsv4`;
body modes `json` / `text` / `xml` are `raw` with that `options.raw.language` (or the language a Postman import kept as `rawLanguage`, none at all for `""`, while importing it again would still give its stored mode),
`graphql` is `graphql` with the variables as the pane's text, `x-www-form-urlencoded` is `urlencoded` and `form-data` is `formdata` with a file part's `src` and any part's `contentType`, `binary` is `file` with `file.src` (`file: {}` when no file is chosen);
`url.query[]` is every stored query row in stored order (a turned-off one `disabled: true`), then the pairs of the URL's own query that no enabled row states, in URL order,
so a request stored with its query only in `url` before the write kept the rows in step (see [`POST /requests`](requests.md#post-requests), issue #3551) keeps it - Postman and Newman read `query[]` over `raw`, and a row matches a pair by key and value (as the row is written into the URL), each row accounting for one pair so a repeated key is not doubled;
`script.pre` / `script.post` are the `prerequest` / `test` events, one event per element in element order, a turned-off one written `disabled: true` (Postman's runtime skips it, as Vayu does); saved examples are `response` entries with an `originalRequest` (see below).

**`protocolProfileBehavior`.**
A request imported with one (its `postmanProtocolBehavior`) is written as that object, member order, explicit defaults and keys Vayu does not apply included, with each key Vayu owns checked against the stored setting (issue #1765):
`strictSSL` (`verifySSL`), `followRedirects`, `maxRedirects`, `disableUrlEncoding` and `disableCookies` keep the imported spelling while it reads as the stored value (absent or not the right type reading as the default) and are otherwise overwritten in place, or appended when absent;
`disabledSystemHeaders` is kept while its names set to `true` are the stored set, and otherwise written as `{name: true}` in stored order; `disableBodyPruning` and every other key are the imported object's.
Without one, the object is generated in the order `strictSSL, followRedirects, maxRedirects, disableUrlEncoding, disableCookies, disabledSystemHeaders, disableBodyPruning`, each only where it differs from Postman's default:
`strictSSL: false`, `followRedirects: false`, a `maxRedirects` other than 10, `true` for either flag, the non-empty header list, and `disableBodyPruning: true` on a GET or HEAD that sends a body.
A folder or collection is never given one: an import flattens a folder's `protocolProfileBehavior` onto the requests below it (#2538), so its applied settings come back on those requests and a key Vayu does not apply is lost.

**Saved examples.**
An example imported from Postman carries the saved response it came from (`request_examples.postman_response`),
and so does one saved in the app from a live response (`savedFrom` on [`POST /requests/:id/examples`](examples.md#post-requestsidexamples));
either is written back from it in the source's member order: `originalRequest` (the request as it was recorded, not the request's current state), `responseTime`, `_postman_previewtype` and any other member as stored; `name`, `code` and `body` from the example's own fields.
The status text is the stored one while `status` is still the code it was recorded with, `header[]` (its `name` fields and number values included) while `headers` still reads the same,
`cookie` while the enabled `Set-Cookie` rows (name in any case, and value) still read as the recorded `header[]` has them (an edit to those rows rebuilds `cookie` from them, a `Max-Age` counted from the export, so a removed row's value is not exported; an unrelated header edit keeps it byte for byte), and the preview language and type while the declared Content-Type is unchanged;
an edit to any of those regenerates the part it made stale.
A member the source left out (`code`, `status`) stays out until an edit gives it a value.
The recorded request's `auth` is written in v2.1's attribute-array shape (a v2.0 file states it as an object, which the v2.1 schema refuses), and with `includeSecrets: false` it is blanked like any other credential and counted in `secretsOmitted`,
as are the credentials in the recorded request's headers and URL, the response's `Set-Cookie` and other sensitive `header[]` rows and the values in `cookie[]`.
An example with no stored response (saved in Vayu before #1763 or from a response restored from a stored run, or imported from OpenAPI) gets `originalRequest` from the request's current state, the status text from the engine's reason-phrase table and `_postman_previewlanguage` from its Content-Type (`Text` when it states none), with `cookie: []`.

**Errors:**
- `400` `Invalid body: must be an object`.
- `400` `Invalid 'collectionId': must be a non-empty string`.
- `400` `Invalid 'includeSecrets': must be true or false`.
- `404` `Collection not found`.

## POST /export/postman-environment

One environment as a Postman environment export (`core/postman_export.hpp`), the inverse of the Postman environment importer: importing the document gives back the same variable names, values, enabled flags, secret flags and types, apart from `json` (below).
**Reads only.**

**Request:**
```json
{
  "environmentId": "env_9a1f...",  // Required, non-empty
  "includeSecrets": false          // Optional - default false
}
```

`includeSecrets: false` writes the string value of every variable marked secret as `""`, counted in `secretsOmitted`; the row stays, still typed `secret`, so the name is visible for the person importing it to fill in.
A secret whose value is exactly one `{{variable}}` reference names a secret without being one and is kept, uncounted.
`true` writes every value as stored.

**Response:**
```json
{
  "text": "{\n\t\"id\": \"env_9a1f...\",\n\t\"name\": \"Production\",\n ...",
  "fileName": "Production.postman_environment.json",
  "notes": {
    "variablesExported": 6,
    "secretsOmitted": 1,
    "notCarried": [
      { "code": "variable_types", "count": 2,
        "message": "JSON variable types have no Postman equivalent, and typed secrets were written as secret" }
    ]
  }
}
```

- `text` is `JSON.stringify(document, null, "\t")`: tab-indented, no trailing newline.
  The document is `{id, name, values, _postman_variable_scope: "environment"}`: `id` is the environment's id, `values` holds one `{key, value, type, enabled}` row per variable in the stored order, and no export timestamp is written.
  A row has no `description`.
- A row's `value` is the stored value as the text a send uses (#3245): a string verbatim, a number or boolean as its JSON text (`5` is `"5"`, `true` is `"true"`), an object or array as compact JSON (`{"a":1}`), an absent or `null` value `""`.
  Its `type` is `secret` for a secret variable, else the stored `string`, `number` or `boolean`, else `default`, Postman's unset marker.
  `enabled` is the stored flag, `true` when absent.
- `fileName` is `<environment name>.postman_environment.json`, with every character a filesystem refuses replaced by `_` (`environment` when nothing is left of the name).
- `variablesExported` counts the rows written.
  A stored variables column that does not parse as an object exports as no variables.
- `notCarried` holds one `variable_types` entry for the types a row could not carry: a variable typed `json`, which Postman has no type for, is written as `default`, and a secret typed `number`, `boolean` or `json` is written as `secret`, Postman's row having one `type` slot (#3252).
  The entry's `count` is how many rows, each counted once.
  No entry means every type was carried.
  A stored `createdAt` is not written; Postman's row has no place for it.

**Errors:**
- `400` `Invalid body: must be an object`.
- `400` `Invalid 'environmentId': must be a non-empty string`.
- `400` `Invalid 'includeSecrets': must be true or false`.
- `404` `Environment not found`.

## POST /export/run-report

A finished **load** run as a document to share (issue #2127): its report, the configuration it ran with and its time series, with everything that could carry a credential or a payload left out (`core/run_export.hpp`).
The document's schema is [`run-export.schema.json`](../run-export.schema.json), JSON Schema draft-07 with `additionalProperties: false` at every level.
**Reads only.**

**Request:**
```json
{
  "runId": "run_5a7c...",      // Required, non-empty
  "format": "json",            // Optional - "json" (default), "markdown", "html"
  "series": "full",            // Optional - "full" (default) or "none"
  "baseRunId": "run_e8f0..."   // Optional - a second finished load run
}
```

`json`, `markdown` and `html` are written.
The formats are one table (`RUN_EXPORT_FORMATS`), so each adds a row and its renderer, and a row to `engine/tests/fixtures/run-export-formats.json`, which the app's format registry and the MCP server's list are held to.
Every format renders the same document, so what the rules below leave out is left out of all of them.
`series: "none"` leaves `timeSeries` out; `full` reads every tick of [`GET /runs/:runId/metrics`](metrics.md#get-runsrunidmetrics), paged at its 50000-tick maximum to the end.
`html` draws the series, so it reads every tick whatever `series` says.
`baseRunId` is checked like `runId` (below) and fills the document's `comparison`; without it `comparison` is `null`.

**Response:**
```json
{
  "text": "{\n  \"schema\": \"vayu.run-report\",\n  \"schemaVersion\": 1, ...",
  "fileName": "Create order 2026-10-05 0810.run.json",
  "mimeType": "application/json",
  "notes": { "urlCredentialsOmitted": 1 }
}
```

- `text` is the document: for `json` two-space indented with invalid UTF-8 replaced, for `markdown` the report [below](#the-markdown-report), for `html` the page [below](#the-html-report).
- `mimeType` is `application/json`, `text/markdown` for `markdown` or `text/html` for `html`.
- `fileName` is `<title> <UTC start, YYYY-MM-DD HHmm>.run.json` (`.run.md` for `markdown`, `.run.html` for `html`), with every character a filesystem refuses replaced by `_` (the rule `POST /export/postman` uses; `run` when nothing is left).
  The title is the one the run's reference line uses (below).
- `notes.urlCredentialsOmitted` counts the values the URL rule below dropped.

**What the document carries is an allowlist.**
Every member is copied from the report or the run's stored snapshot by name, so a field the report gains later is absent here until it is added on purpose:

1. No `results[]`, no trace (`trace`, `rawRequest`, `sentHeaders`), no captured sample, anywhere.
   A trace records what was sent, credentials included, and a sample holds response headers and bodies verbatim.
2. `config` holds the `method`; the `url` after `redact_url_credentials` (`core/vayu_extensions.hpp`: a `user:pass@` password dropped and the user name kept, a credential-named query or fragment value emptied, a lone `{{variable}}` kept);
   `headerNames` and `paramNames`, names only, whether enabled or not; `body` as `{mode, bytes}`, `bytes` the size of the body text as stored and `null` for a body that is not text; `auth` as `{mode}`; and the report's `metadata.configuration` tuning object.
   Never a header or parameter value, never the body.
3. Text the engine copied from a script or a response is carried as counts only:
   `schemaValidation` keeps `failuresTotal` and drops `failures[]`, a `lifecycle` outcome drops its `message`, `messages`, `console` and their dropped counts, an element row (a step's or the run's `elements`) drops `messages`, `console` and their dropped counts (#3127), and the report's `auth` section (whose `lastError` is a token endpoint's words) is left out.
4. Text the user wrote (the request name, the run comment, the data file's display name, step, transaction, metric and series names) is carried as written.
5. Within a section a value is copied only when it is a scalar or a list of scalars; anything deeper is named member by member.

**The document** (`"schema": "vayu.run-report"`, `"schemaVersion": 1`; a breaking change bumps the integer and is noted here):

| Member | Holds |
|--------|-------|
| `generatedAt`, `engineVersion` | Epoch milliseconds of the export; the engine's version |
| `run` | `id`, `reference`, `type` (`load`), `status`, `startTime`, `endTime`, `name` (the request name, or `null`), `comment` (or `null`), `baseline` |
| `verdict` | `{state, stoppedEarly, reason}`, derived below |
| `config` | As in rule 2 |
| `report` | `summary`, `latency`, `statusCodes`, `errors`, and when the run has them `rateControl`, `timingBreakdown`, `stream`, `slowRequests`, `sampling`, `warnings`, `scenario` (step and transaction aggregates, and a scenario load run's exact `assertions`), `monitor`, `testValidation`, `capacity`, `coverage`, `schemaValidation` (counts), `lifecycle` (outcomes), `elements`, `thresholdValidation`, `assertions` (the run's assertion block, #3537), `customMetrics` - each as [`GET /runs/:runId/report`](runs.md#get-runsrunidreport) documents it, less what the rules above leave out |
| `timeSeries` | One entry per tick: `elapsed_seconds`, `requests_completed`, `requests_failed`, `current_rps`, `current_concurrency`, `throughput`, `error_rate`, `status_codes`, `status_seconds`, `latency_p50_ms`, `latency_p95_ms`, `latency_p99_ms` (the tick's own second, [as stored](metrics.md#get-runsrunidmetrics): the three percentiles are absent from a second with no completion, issue #2386, and the HTML charts skip that point rather than drawing 0 ms; `status_seconds` is [as stored](metrics.md#get-runsrunidmetrics) with any entry that is not `{second >= 0, span >= 1, counts}` of five counts >= 0 dropped, an empty list kept, and the key absent from a tick stored before issue #2866); absent for `series: "none"` |
| `comparison` | `null` without `baseRunId`; otherwise `{baseRunId, baseReference, differences, deltas, statusCodes, errorClasses}`, below |
| `notCarried` | `[{code, message}]`, one entry per kind of thing this run held that the document left out, in the order `traces_and_samples`, `request_values`, `message_text`, `credential_refreshes` |

`statusCodes`, `errors.byStatusCode` and a tick's `status_codes` are objects, code to count, in the document: the report itself writes the first two as `[[code, count], ...]` pairs.

`run.reference` is the *Copy for agent* run line ([MCP: Naming what the user means](../mcp/runs-and-reports.md#naming-what-the-user-means)) with the start in ISO-8601 UTC, because a file is read away from the locale and zone the app would print it in: `Vayu run "Create order" (run_5a7c...) - load test, POST /v1/orders, 2026-10-05T08:10:00Z, completed`.
The title is the request name unless it is the default `New Request`, else the collection a collection load run ran, else the method and path; the URL is cut to its path.

`verdict` reads the report fields the app's run verdict reads (`judgeRun` in `app/src/components/shared/run-outcome.ts`): `status`, `summary.totalRequests` and `summary.errorRate`, `summary.drainCut`, `thresholdValidation`, and the report's top-level [`assertions`](runs.md#get-runsrunidreport) block, for a single-request run and a scenario load run alike (#3537).
A failed check is a failed assertion of either population (`exact.failed` or `sampled.failed`), an errored element execution (`errored`) or a failed teardown (`teardownFailed`); like an errored request, it keeps met budgets from reading `passed` without failing a run that declared no budget for it.
The first matching row wins:

| `status` and budgets | `state` | `reason` |
|----------------------|---------|----------|
| `stopped` | `not_judged` | `stopped` |
| `failed`, no budget missed | `failed` | `run_failed` |
| A declared budget missed (`thresholdValidation.failed > 0`) | `failed` | `budgets_missed` |
| A Stop cut the run's own drain (`summary.drainCut.cancelled > 0`; #3538) | `not_judged` | `drain_stopped` |
| No budget declared | `not_judged` | `no_budgets` |
| Every budget met, some requests errored (`summary.errorRate > 0`) | `not_judged` | `budgets_met_with_errors` |
| Every budget met, an assertion failed (`assertions.exact.failed` or `assertions.sampled.failed` > 0; #2820, #3458) | `not_judged` | `budgets_met_with_assertion_failures` |
| Every budget met, an element execution errored (`assertions.errored > 0`) | `not_judged` | `budgets_met_with_element_errors` |
| Every budget met, a teardown failed (`assertions.teardownFailed > 0`) | `not_judged` | `budgets_met_with_teardown_failures` |
| Every budget met, none of the above | `passed` | `budgets_met` |

`reason` names the first failed check; the Markdown and HTML line names every one (below).
A cut drain removed the run's slowest requests from every figure, so what is left is not judged however well it did: its line is `15 requests were still unanswered when the drain was stopped`, and a budget the answered requests already missed still fails the run.
A report with no `assertions` block (a run that asserted nothing and errored nowhere, or one stored before the block whose old fields derive none) has no failed check.
`engine/tests/fixtures/run-verdict-conformance.json` pins this table to the app's: the engine's suite replays it through the export and the app's through `reportOutcome`.

`stoppedEarly` is `status == "stopped"`.

**A summary that is not a whole-run measurement** (issues #2895, #2905).
`report.summary` carries two optional booleans, each present only when `true` (the `GET /runs/:runId/report` flags of the same name): `partial` for a run the engine died under and reconciled at the next start, whose counts are its last saved tick's, and `summaryMissing` for a failed load run that stored no summary, whose counts are not whole-run totals.
In both, `report.latency` is absent (the schema no longer requires it, #2938): a crashed run flushed no rows to take a percentile from, and the sampled rows of a failed run with no summary are not the run's latency.
The Markdown and HTML latency table then reads `-` in every row.
The verdict is not changed by either; the Markdown and HTML reports word it (below).

`comparison` diffs the run (the target) against `baseRunId` the way the app's vs-baseline strip and the MCP `compare_runs` tool do (`compareReports`): the engine's copy is `core/run_compare.hpp`, and `engine/tests/fixtures/run-compare-conformance.json` pins all three to the same answers.
Its members:

- `baseRunId`, and `baseReference`, the base run's line written as `run.reference` is.
- `differences[]`: `{field, base, target}` for every way the two runs were not the same experiment, in the order `run_type` (`Send`, `Load test` or `Collection run`; the export takes load runs only, so it does not arise here today),
  `mode`, `concurrency` (virtual users; for a ramp the start level and ramp time too), `target_rps`, `duration` (only past a 2x ratio; an unfinished run's status is appended, `"3 s, stopped"`), `status`,
  `http_version` (`auto` differs from nothing), `data_file` (name and the first 8 characters of its hash, then `, numbers read as numbers` when `dataFileCastNumbers` is set; none against one *is* a difference, and so is one file read both ways, #2540, since the hash is of the bytes),
  `request` (method and URL with the query, fragment and userinfo cut), `compression` and `expect_continue` (#2516; `allowed` against `not allowed`, an absent key reading as `not allowed`).
  The two values are strings formatted as the app shows them.
  Every report the export reads carries `metadata.runType`, so a `mode`, `concurrency` or `target_rps` only one run recorded is listed, its missing side `not recorded` (the shared rule leaves such a field unknown when either report lacks `runType`); any other field only one report carries is unknown and not listed.
  Read these before the deltas: a short stopped run against a long one always looks like a regression.
- `deltas[]`: `{metric, base, target, delta, pctChange, direction}`, one per metric in this order:

  | `metric` | `direction` |
  |----------|-------------|
  | `latency.p50`, `latency.p90`, `latency.p95`, `latency.p99`, `latency.avg`, `latency.max` | `lower-is-better` |
  | `summary.avgRps`, `summary.throughput` | `higher-is-better` |
  | `summary.errorRate` | `lower-is-better` |
  | `summary.totalRequests` | `neutral` - it moves with how long a run was told to run |

  `delta` is `target - base` and `pctChange` is `delta / base * 100`.
  A value a report lacks is `null`, and so is every figure computed from it; `pctChange` is `null` against a zero base.
  So is a figure the report says the engine did not record (#2904), judged per run: `summary.summaryMissing` (a failed run with no summary) nulls that run's `summary.*` metrics and its latency, and `summary.partial` (reconciled after a crash) nulls its latency alone, so the other run's value stands and the `delta` is `null`.
  The base's own headline numbers are the entries' `base` values.
- `statusCodes`: `{code: {base, target}}` over every code either run saw, a code one run never saw counting `0`.
- `errorClasses`: `{class: {base, target}}` over the `transport`, `protocol` and `tool` failure classes either run's [`summary.errorClasses`](runs.md#get-runsrunidreport) counted (#3828), in that order, a class one run never counted being `0`.
  It is `{}` unless **both** runs carry `summary.errorClasses`: a run stored before the engine counted them has no figure, and reading it as `0` would show a regression that never happened.
  A recorded `{}` (nothing failed) is a figure and reads `0`.
  `protocolCodes` is not compared.

### The Markdown report

`format: "markdown"` renders the document above as plain GitHub-flavoured Markdown, to paste into a pull request or an issue, or to save as `<title> <UTC start>.run.md` (`core/run_export_markdown.hpp`).
It is a pure function of the document: it reads no database and no report, so it can say nothing the document does not.
No raw HTML and no images.
Its size does not grow with the run: the time series is never read, and a table fed by an open set (status codes, error types, warnings) shows ten rows and folds the rest into one `Other (<n> codes)` row, so a 2-hour run that saw 300 status codes is still under 6 KB.
The tables a plan or a spec feeds (steps, transactions and the contract's operations) show twenty rows in document order, the order of the plan and never sorted by count, and fold the rest into one `and <n> more steps` row.

The sections, in order:

1. `# <title>`, then the run's reference line in a code span (the same line `run.reference` holds).
2. The verdict, from the document's `verdict` and never recomputed: `**Passed** - 3 of 3 budgets met`, `**Failed** - p95 <= 30 ms missed (41 ms)` (every missed budget, or `not evaluated` for one the run could not measure), `**Not judged** - no budgets declared`.
   Met budgets that did not pass, and no budgets, name every failed check of `report.assertions` in this order, after the error rate when requests errored: `150 assertions failed`, `4 assertions failed in the sampled replay` or `150 assertions failed, 4 more in the sampled replay`;
   `3 elements errored`; `1 teardown script failed` (`**Not judged** - 3 of 3 budgets met, but 0.4% of requests errored, 68 assertions failed`, `**Not judged** - no budgets declared; 91 assertions failed in the sampled replay`, #3537).
   A cut drain is its count alone: `**Not judged** - 15 requests were still unanswered when the drain was stopped` (`1 request was`, #3538).
   For a stopped run a line `Stopped early at 3 s of 20 s` follows, and for a run with `summary.partial` or `summary.summaryMissing` one sentence each follows that, saying the totals are the last saved tick's or not whole-run totals, and that latency was not recorded (the latency table then reads `-` in every row, #2938).
3. `## Run`: target (`<METHOD> <url>`, or `Collection run, 3 steps per iteration` - the step count is `report.scenario.steps`, left off when the document holds no per-step stats), mode, virtual users, duration, start (ISO-8601 UTC), engine version and the comment.
   A `capacity` run reads its configuration as a search: `Search from 1 up to 128 virtual users` (the first level and the ceiling), `Deadline 300 s, ran 62.4 s` (the configured deadline, then `summary.testDuration`, because the search ends when it finds its limit) and a `Step` row with `configuration.stepDuration` as it was sent (`5s`, or a number of seconds).
4. `## Results`: requests, a `Skipped requests` row only when `summary.skippedRequests` is above 0 (`625 requests skipped: the load generator stalled for 2.5 s`, from `skippedRequests` and `stalledMs`, issue #2911; absent or `0` prints no row), requests per second (`avgRps`, labelled as the whole run with the drain included),
   responses per second while sending (`completedWhileSending / sendingDurationSeconds`, issue #2882, only when the report has both), error rate with its split into HTTP errors and no response, bytes in and out, and the throughput and error-rate budgets that judged them.
   The error rate is the report's, never derived from the counts.
5. `## Latency`: min, p50, p90, p95, p99, p999 and max, with the budget that judged each (`<= 30 ms - missed`).
   A scenario run's table opens with the line `*All steps pooled.*`: it is one histogram over every step, and the per-step figures are the Sequence table's.
   A streaming run's table opens with `*Each stream's full duration.*` (after that line, for a run that is both).
6. `## Stream`, only for a run whose document has `report.stream`, which a streaming run carries and every other run lacks (#3240).
   A line saying what the Latency table above is (`The Latency table above is each stream's full duration, not the time to its first event.`: a stream's latency is its whole transfer, so it grows with the events the server sends), then a table of `Streams` (`completions`), `Events` (`totalEvents`), `Events per second` (`eventsPerSecond`, in `events/s`) and `Streams ended at a cap` (`capped`),
   then a table with a p50, p95, p99 and max row of the events each stream delivered (`events`, whole counts) and, as a `Time to first event (ms)` column, of the time to each stream's first event (`timeToFirstEvent`), then a `Time to first match (ms)` column (`timeToFirstMatch`, #3774), a `Largest event gap (ms)` column (`maxEventGap`) and an `Event rate (events/s)` column (`eventRate`, #3776).
   Each of those four columns is left off when the document lacks its block, which the engine omits when no stream measured it, so a zero never stands for a figure that was not measured.
   A figure the document lacks reads `-`.
7. `## Capacity`, only for a run whose document has `report.capacity`: the stop reason in bold and what the search found (`**Latency budget exceeded**
   - Sustained 41 virtual users at 403 req/s, with a p99 of 178 ms against a 200 ms budget.`), then where the limit sits (`The limit lies between 41 and 51 virtual users:
   it held 41 and gave out at 51, where p99 reached 226 ms.`), why it stopped in the document's own figures (`p99 stayed above the budget across two consecutive measurements of the level (each 5s long).`), the budget, error limit and step length the search ran under, and a table of the levels it judged: virtual users, throughput, p99, plus `Errors
   (%)` and `Samples` only when some level carries them (a run stored before the engine reported them has neither). A level the search measured twice reads `51 (re-measured)`, and a p99 or error share past its limit says `(over budget)` or `(over
   limit)` in words. The sentences are the app's Capacity summary's (`components/shared/CapacitySummary.tsx`, with the stop reasons' labels and detail lines in `components/shared/capacityStop.ts`): the stop-reason table in `run_export_view.cpp` and `capacityStop.ts` word the same
   stops, so a change to one is a change to both. A reason neither table knows (a newer engine's) prints under its raw key with no detail line. What the search found depends on why it stopped: a measured capacity when the target gave out (`slo_exceeded`, `errors_exceeded`), `At
   least N virtual users held the budget` when it ran out of ceiling, time or patience (`cap_reached`, `deadline`, `stopped`), the saturation level when throughput plateaued, and `The search ended before it finished measuring a single level` when `levels` is empty. A latency here is spelled `178 ms` as the rest of this report spells it, not `178ms` as the app does.
8. `## Contract`, only when the document has `report.coverage` or `report.schemaValidation`, which a run of a collection bound to an OpenAPI document carries and every other run lacks (#3036).
   Up to three lines, each present when its section is: `Coverage: 3 of 5 operations covered; declared-response coverage 80.0% (8 of 10).` (the percentage is the document's `declaredResponseCoveragePct`, never recomputed from the counts);
   `Schema validation (sampled): 100 responses sampled, 90 checked (87 valid, 3 failed), 10 unchecked.`, which says `sampled` unless the section has `exact: true` (a collection run, which checked every step: `Schema validation (every step checked): 100 responses, ...`), because a load run's check walks a reservoir;
   and `Unchecked: body is not JSON or nests too deeply (6), no schema for the status (4).`, the three commonest `uncheckedReasons` with the rest counted (`and 2 more reasons`), worded as the app's `response-viewer/validation-reasons.ts` words them, shorter, and a code it does not know under its raw key.
   A table follows with a row per `coverage.operations[]` entry in document order (method and path, operation id, requests sent, declared responses hit and missed), folded past twenty rows into `and <n> more operations`.
   The path and operation id are the spec author's text, escaped as every name is.
9. `## Sequence`, only for a scenario run whose document counts iterations or lists steps: one line (`2,110 iterations started, 2,090 completed, 15 abandoned, 5 cut short` - abandoned and cut short only when above zero, cut short being started less completed less abandoned, as the app derives it), then a table with a row per step in plan order:
   executed, errors, `Assertions` (`2,080 passed, 18 failed`, summed from the step's `assert.*` and `script.*` element tallies, an `error` counted as failed, with each miss of a `required` extractor added to the failed count because it failed the step; `deferred to a post-run replay` for a script the engine only replays afterwards; `-` for a step that asserts nothing) and its p50, p95 and p99.
   Step names are free text and escaped as every name is.
10. `## Transactions`, only when the run declared any: name, count, errors and p50, p95 and p99 per `report.scenario.transactions[]` entry.
11. `## Errors`, only when there were any: by status code (`HTTP 503`), then by transport error type.
    A request that got no response is listed once, under its error type: status code 0 counts the same requests, so no row reads `HTTP 0` (issue #2400).
    A `No response` row (the app's words) appears only when the error types sum to less than code 0, which is a run stored before the per-type counts, whose types stop at the error store's cap; its count is the remainder (code 0 minus the types' sum), so the requests no type names are not lost and none is listed twice.
    With no error types at all it holds the whole of code 0.
    A document whose `report.summary.errorClasses` counted a class (#3828) closes the table with one `MCP transport failures`, `MCP protocol failures` or `MCP tool failures` row per counted class, in that order.
    They are the same failures seen by class, not further ones: a failed reply is also under its HTTP status or its `mcp_*` type, so the rows do not add up to the ones above them.
    Without the key, or with `{}`, there are none.
    The HTML report reads the same table.
12. `## Compared with <base reference>`, only when the document has a `comparison`:
    each metric's base, this run, change and a word from the delta's own `direction` (`improved`, `regressed`, `unchanged` for a change of exactly zero, `-` for a neutral metric that moved, such as the request count, which is neither better nor worse, or `not compared` for a figure one run lacks), then one line per `comparison.differences[]` entry.
13. `## Warnings` from `report.warnings`, and the footer `Generated by Vayu
    <version>. No request or response data is included.` A warning's `names`
    are appended as `: a, b, c` (the first five, then `and N more`) unless its `message` already ends with `: ` and every name joined by `, `, which is how the engine writes an unresolved-variable warning, so each name appears once.

Every table is padded to its widest cell so it reads as a table before it is rendered.
All free text (the title, URL, comment, error types, warning text) goes through one `escape_markdown_cell`:
line breaks and control characters become a space, and `\`, `` ` ``, `|`, `<`, `>`, `[`, `]`, `*`, `~`, an `&` that would write an entity, an `_` that is not inside a word and a leading block marker (`#`, `-`, `+`, `1.`) are backslash-escaped, so a request named `` a | b <script> `` cannot split a table or start a tag. Numbers are spelled the same on every host, whatever its locale:
`,` groups thousands and `.` marks decimals. A latency or rate has two decimals below 10 (trailing zeros dropped) and none from 10, `<0.01` for a positive value that would round to 0;
a percentage has one decimal and `<0.1` likewise. The tiers are pinned by `engine/tests/fixtures/run-export-number-tiers.json`.

`engine/tests/fixtures/run-export/<case>.document.json` and `<case>.golden.md` hold the renderer to its exact bytes for each shape of run (`run_export_markdown_test.cpp`); a deliberate change to the output is regenerated with `VAYU_UPDATE_GOLDEN=1`, never edited by hand.

### The HTML report

`format: "html"` renders the same document as one self-contained page, to open in a browser, attach to a ticket or print: `<title> <UTC start>.run.html` (`core/run_export_html.hpp`).
Like the Markdown report it is a pure function of the document, so it can say nothing the document does not.

It holds the Markdown report's sections in the same order (title and reference line, verdict, run, results, latency with its budgets, a streaming run's events, a capacity search's result, the contract's coverage and schema checks, a scenario's sequence and transactions, errors, comparison, warnings), written as semantic HTML -
one `h1`, tables with `th scope`, a description list for the run - from the same reading of the document, so the two cannot word a verdict or a capacity result differently.
Stream (#3240), Capacity, Sequence and Transactions (#2819) are sections of paragraphs and tables like the rest, each present only when the document has it:
the Stream section is the Latency note above its totals and distribution tables, the capacity sentences are paragraphs above the levels table, the iteration line is the paragraph above the steps table,
the Contract section (#3036) writes its coverage, validation and unchecked-reason lines as paragraphs above its operations table, and a level or assertion count past its limit carries the same word beside its colour (`(over budget)`, `18 failed`).
A table's one-line caption (a scenario run's latency table, `All steps pooled.`) is its `<caption>`; the partial and missing-summary sentences sit in the verdict's band, one paragraph each.
Above the title sits a one-line brand (the Vayu mark at 28 px, then the wordmark `Vayu run report`, muted; the mark has an empty `alt` because the wordmark names the product).
The mark is `shared/icon_png/vayu_icon_64x64.png`, embedded as a base64 `data:` URI (`run_export_html_logo.hpp`) because it exists only as a raster; the test suite compares the embedded bytes with that file.
Then come three charts drawn from `timeSeries`, then the footer, which names the engine version:

1. Throughput (req/s) and virtual users, two stacked panels sharing the x-axis.
2. Latency p50, p95 and p99 in ms, with the p95 budget as a labelled dashed line when the run declared one.
   The axis stretches to reach the budget, so a generous budget is drawn however far above the data it lies.
3. Responses by class: 2xx/3xx, 4xx, 5xx and No response (status code 0).
   A class that saw no response is not drawn and has no label.
   The chart reads the series one of two ways, chosen once for the whole `timeSeries`:
   - When any tick carries `status_seconds` (issue #2888, runs stored after #2866), it is **responses per second**: one point per entry at `counts[i] / span`, at the end of the entry's span (`second + span`), the entries kept once per `second` (the last wins) and in second order, with 3xx counted into 2xx/3xx.
     The ticks' own timing moves nothing, and a tick without the key adds no point.
     A series whose every `status_seconds` is empty draws no status chart.
   - Otherwise (a run stored before #2866) it is **responses per tick**: a tick carries cumulative counts, so each class is drawn as what it gained since the previous tick, a count that moved backwards adding nothing.

Every y-axis starts at 0 and names its unit, the x-axis is seconds from the start of the run, and each line is labelled where it ends instead of in a legend; the percentile lines differ in lightness, not hue, since red and amber mean failure here.
Each chart has an accessible name and a `<desc>` giving every series' minimum, maximum and the time of its peak, read from every tick.
A line is drawn from at most 480 points: a longer series is cut into 240 stretches and each keeps its lowest and highest value, so a one-tick spike survives, and the file stays under 300 KB for a run of any length.

**The page loads nothing and runs nothing.**
There is no script, no `<link>`, frame or font and no `url(...)`; the one image is the brand mark above, an inline `data:image/png` URI, so it is the only `src` attribute and it cannot fetch anything.
A `Content-Security-Policy` meta tag (`default-src 'none'; style-src 'unsafe-inline'; img-src data:`) enforces that: no request leaves the page.
The only `href` values are `#` anchors to the page's own sections: the target URL is text, never a link.
The charts are inline `<svg>`, which is why hovering a line shows its summary natively.
Every string written into the page (name, comment, URL, error keys, warning text, data file name) goes through one `escape_html`, in text and attribute position alike.

The page follows the reader's colour scheme (`color-scheme: light dark`, the palette switched by `prefers-color-scheme`, no toggle) and prints light on A4 (`@page` margin 14 mm, sections and charts kept whole, the verdict band printed in colour).
Pass and fail are always a word beside the colour (`Passed`, `Failed`, `Not judged`, `met`, `missed`); the palette holds 4.5:1 for text and 3:1 for graphics in both schemes (`run_export_html_test.cpp` measures it).

`engine/tests/fixtures/run-export/<case>.golden.html` pins the bytes for nine shapes of run, among them a capacity search, a scenario run and two streaming runs, regenerated like the Markdown goldens.

**Errors:**

| Status | `error.code` | When |
|--------|--------------|------|
| `400` | `bad_request` | The body is not an object; `runId` missing or empty; `format` not one of the table's names; `series` not `full` or `none`; `baseRunId` not a non-empty string, or equal to `runId` |
| `400` | `unsupported_run_type` | The run or the base is a design or collection-sequence run |
| `404` | `not_found` | The run or the base does not exist |
| `409` | `run_in_progress` | The run or the base is `pending` or `running`: its numbers are not a result yet. A `stopped` run is a result |
