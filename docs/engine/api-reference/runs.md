---
description: >-
  The run-history routes: list runs, read one, stop it, read its report and samples, pin a baseline and delete runs.
---

# Runs

## GET /runs

List test runs (design mode, load tests and collection runs), newest first (`start_time DESC, id DESC` - the only order the UI uses; the `id` tiebreak makes the order total, so runs sharing a millisecond page in a fixed order and a page boundary inside such a tie neither repeats nor skips a row).
Rows carry a compact `summary` rather than the full `configSnapshot`, so the polled history sidebar stays cheap as history grows.

Each row's `summary` is derived from that run's `config_snapshot`, and the derivation is **cached per run id** (issue #1150): a snapshot is written once, when the run is created, so a repeated poll re-serves what the previous one built instead of re-parsing one snapshot per row every tick - 50 at the default page size, up to 500 at the cap.
The cache is bounded and holds nothing a request cannot rebuild, so it changes no answer - a run deleted between polls is gone from the list because the query no longer returns it, not because anything was invalidated.
This route also logs at **debug**, not info: it is the one endpoint a visible client polls, and an info line here reached the console of every engine started at the default app verbosity, every five seconds.

**Query parameters** (every one optional; the answer is always the paginated envelope):
- `limit` - page size (default 50, invalid/&le;0 falls back to 50, capped at 500).
- `offset` - rows to skip (default 0, negative floored to 0).
- `before` - a keyset cursor, `<startTime>:<id>`: the page starts after that row (#2978).
  Pass the previous page's `pagination.nextBefore` unchanged; the value is split on its first `:`, so an id holding one is read whole.
  Where `offset` makes SQLite step over every row before the page, a cursor page seeks `idx_runs_start_time` to the row and reads about `limit` rows however deep it is, and it does not shift when a new run starts between two pages.
  Every filter below still applies, and `total` still counts the whole filter, not the rows after the cursor.
  A value that is not an integer, a `:` and a non-empty id is a `400` with code `invalid_before`; `before` beside a non-zero `offset` is a `400` with code `before_with_offset` (an `offset` of `0` is the same as none).
  `offset` stays for a client that jumps to a page number.
- `type` - `design` | `load` | `scenario` (an unrecognised value is ignored, not an error).
- `status` - a `RunStatus` string (`pending` | `running` | `completed` | `failed` | `stopped`; unrecognised ignored).
- `requestId` - exact match on the run's linked request.
- `collectionId` - exact match on a run's stored `scenario.collectionId`, read out of the snapshot as JSON.
  This is the deliberate opposite of `q` below: it matches the field, never the text around it, so a design run whose URL happens to contain the id does not come back.
  A collection run records the path, and so does a load run driven over a collection (#3544); a single-request design or load run never does, so it can never match.
  Add `type=load` to leave the collection's sequential runs out.
  An id nothing has run is an empty page, not an error.
  A collection's most recent run is `?collectionId=<id>&limit=1`, since the list is already `start_time DESC`.
- `q` - case-insensitive substring **over the stored `config_snapshot` text** (SQL `LIKE`).
  It searches the raw snapshot, so it may over-match JSON keys or structure - acceptable for a search box.
- `baseline` - `true` lists only runs pinned as baselines, `false` only unpinned ones (any other value is ignored, like an unrecognised `type`).
  Leaving it out lists both, so omit it rather than passing `false` to mean "either".
  A request's current baseline is `?baseline=true&requestId=<id>&limit=1`, and a collection's `?baseline=true&type=load&collectionId=<id>&limit=1`, since the list is already `start_time DESC` - the lookups both the history view's vs-baseline strip and the MCP `compare_runs` tool make.
- `origin` - `app` | `mcp` | `other`, exact match on the run's stored `origin.kind` (#1817; see [POST /execute](execute.md#post-execute)).
  Like an unrecognised `type`, any other value is ignored rather than refused, so a client on a newer vocabulary than the engine gets a wider list, never an error.
  A run recorded before the field existed matches `other`.
  There is no client filter: narrowing to one MCP client is done client-side over the rows this returns.
- `outcome` - `passed` | `failed` | `not_judged`, exact match on the run's stored `outcome` (#3547, below), the verdict its row draws rather than how it ended: `outcome=failed` lists a `completed` run that missed a budget, which `status` alone never shows, and every run whose status is `failed`, summary or not (#3643).
  A row with no outcome matches no value, so a run recorded before the field existed is in no `outcome` page.
  An unrecognised value is ignored, like an unrecognised `type`.

Every parameter composes with every other; each one left out is a wildcard.

**`summary`** carries exactly these seventeen snapshot keys: `url`, `method`, `mode`, `duration`, `concurrency`, `iterations`, `targetRps`, `startConcurrency`, `rampUpDuration`, `comment`, `followRedirects`, `maxRedirects`, `requestName`, `dataFileName`, `dataFileHash`, `dataFileCastNumbers`, and `httpVersion`.
The first sixteen are each **omitted** when absent from the snapshot (a malformed snapshot yields an empty `summary`, never a `500`); `httpVersion` alone is always present.
`iterations` and `targetRps` (issue #2437) are what the run was sent, never a default the engine filled in: an iterations run's request count, and a paced run's rate.
`targetRps` is the one rename - the `POST /runs` body may name the rate `rps` or `targetRps`, the row reports it as `targetRps` (the rate the engine paced at: `rps`, or `targetRps` when `rps` is absent, null or zero), and the report's `configuration` does the same.
A field the run was not sent has no key here even though the engine ran its default (see [POST /runs](load-runs.md#post-runs)); a client that wants a default visible sends it.
`startConcurrency` and `rampUpDuration` (issue #1935) are the ramp-up knobs, so only a `ramp_up` run has them, e.g. `"startConcurrency": 2, "rampUpDuration": "10s"` beside `"concurrency": 50`; they are the same two keys the report's `configuration` carries.
`requestName` is the request's name **as the client sent it when the run started** - never re-read from the requests table, the same trust model `url` and `method` already have here -
so a request renamed or deleted since does not change what a past run's row says it invoked, and a run whose client omitted the field (or one recorded before it existed) has no key at all rather than a fabricated name.
It reaches `config_snapshot` the same way `url`/`method` do: whatever the client's `POST /runs` or `POST /execute` body carried; the renderer sends it from `execIdentity` (`execute-mapping.ts`), the same field [POST /compose](compose.md#post-compose)'s `requestId` path already stamps for the script sandbox's `pm.info.requestName`.
`dataFileName` and `dataFileHash` (issue #2051) name the file a single-request run's `data` rows came from, by display name and SHA-256 of its bytes (64 lowercase hex), never its path; a run sent without a file name has neither.
`dataFileCastNumbers` (issue #2540) is `true` when that file's numbers were read as numbers, and absent otherwise.
Every run since issue #1488 adds an eighteenth, `acceptEncoding`:
`true` when the run negotiated a compressed response (`negotiateCompression` for a collection run, `loadNegotiateCompression` for a load run -
see [Default request headers](health-config.md#default-request-headers)), `false` when it did not, and **omitted**, not defaulted, for a run recorded before that issue - the baseline comparison (below) is the one reader that treats an absent key as `false`, matching what every such run actually sent.
A raw `POST /runs` body of `"httpVersion": null` (erased before execution, so it behaves exactly like an absent key - see [POST /runs](load-runs.md#post-runs)) lands in the stored snapshot verbatim, and a run predating this field has no key at all;
neither case recorded a protocol, so both normalize to the literal string `"auto"` rather than being omitted, which would misrepresent "nothing was recorded" as "we lost it".
Do not read `"auto"` on an old run as the protocol it used: a load run stored before 0.11.0 hardcoded `CURL_HTTP_VERSION_2TLS`, and every run before it went out as HTTP/1.1 regardless, because nghttp2 was not linked.
The full snapshot stays available on `GET /runs/:runId`.
That route does not build a `summary` row at all: it returns the full `configSnapshot`, which already holds every key above.
The same seventeen keys are on the row [PUT /runs/:runId/baseline](#put-runsrunidbaseline) answers with, since both are built by one function; that row carries no `resultSummary`.

A **collection run** (`type: "scenario"`) carries none of the single-request keys above (`url` through `dataFileCastNumbers`): its work is a sequence, so there is no single `url`, `method` or `mode` to report.
Its row instead carries a nineteenth key, `scenario`, present on scenario runs only:

```json
"scenario": {
  "collectionId": "col_1234567890",
  "iterations": 3,
  "recursive": true,
  "stepCount": 12,
  "dataFileName": "users.csv",
  "dataFileHash": "<sha256>",
  "dataFileCastNumbers": true
}
```

`stepCount` is the length of the snapshot's step manifest, not the manifest itself - a row that shipped every step's name, method and URL would undo the reason `summary` exists.
The manifest stays on `GET /runs/:runId`.
Each of the seven keys is omitted when the stored snapshot has no such key: `dataFileName` and `dataFileHash` (issue #2051) are the data file a run's `scenario.data` came from, so a run sent without one has neither, and `dataFileCastNumbers` (issue #2540) is present, as `true`, only when that file's numbers were read as numbers.

**`hasWarnings`** (issue #1527) is `summary`'s twentieth key, `true` on a run whose stored `summary.warnings` array (issue #1503) is non-empty and **omitted** otherwise - a run still in progress, one whose terminal write failed, or one that finished with nothing to say.
Unlike the other keys above, it is not read out of `config_snapshot` and not part of the cached compact summary: it is a completion-time fact, read fresh off the row on every poll, so a history surface that polled a still-running run sees the glyph appear on the next poll after it finishes, never stuck at the answer its first poll cached.
The full `warnings` array itself stays on `GET /runs/:runId`'s `summary`.

**`baseline`** is on every row, `true` only for a run pinned through [PUT /runs/:runId/baseline](#put-runsrunidbaseline).
It is also on `GET /runs/:runId`, so a client that opened a run directly can draw the pin without listing.

**`origin`** is on every row and on `GET /runs/:runId`: `{"kind", "client"}`, who started the run as the starting client asserted it (#1817; the rules are on [POST /execute](execute.md#post-execute)).
`client` is the MCP client's name for an `mcp` run and `null` otherwise, and on an `mcp` run whose client sent no name.
A run recorded before the field existed reads `{"kind": "other", "client": null}`.
Metadata, not identity: nothing authorises on it.

**`outcome`** (#3547) is the verdict the row's own status and `resultSummary` (below) give the run (a `failed` status needs no summary), stored when the run ends so the list can filter on it: `"passed"`, `"failed"` or `"not_judged"`, the rule the app's history row draws by (`rowOutcome`, `run-outcome.ts`; `engine/tests/fixtures/run-row-outcome-conformance.json`).
The key is **omitted** on a row with no verdict, never `null`.

- A **`failed` status is `failed`** for every run type, with or without a `resultSummary` (#3643): the list draws the failed mark from the status, so the filter follows the mark.
  A design run that failed, a load or collection run that failed before a summary was written, and a crash-recovery orphan with no metric tick are all `failed`.
  It outranks every rule below.
- A **load run**: `stopped` is `not_judged`; a missed budget (`verdict: "failed"`) is `failed`; a drain a Stop cut (`drainCut`) is `not_judged`; no budget (no `verdict`) is `not_judged`; met budgets are `passed`, unless `errorRate` is above zero or a check failed (`assertions`: `exact.failed`, `sampled.failed`, `errored` or `teardownFailed`), which is `not_judged`.
  In that order: the first rule that applies decides.
- A **collection run** is `failed` when it `completed` with a missed budget or a step that `failed` or `errored`, and has no outcome otherwise: a clean one is never `passed`, and a `stopped` one says nothing.
- A **design run** that did not fail, a `pending` or `running` row, and a `completed` or `stopped` load or collection row with no `resultSummary` (no stored summary yet, or one that records none of its keys) have no outcome.
  Neither has a run recorded before the field existed, `failed` ones included: the column is not backfilled.

It is derived from the row's own status, type and stored summary whenever the engine writes either - the final status, a summary that lands after a Stop's status, and the startup reconcile that marks an abandoned run `failed` - so it never describes a status or summary the row no longer holds.
It is on the [PUT /runs/:runId/baseline](#put-runsrunidbaseline) row too, which is built by the same function; `GET /runs/:runId` does not carry it.

**`resultSummary`** is what a **design run's** row says about the exchange: `statusCode` and `latencyMs`, and nothing else.
A design run is one request and one response, so its outcome fits on the row and a page of them costs one extra query.
The two numbers rather than the whole `result` [GET /runs/:runId](#get-runsrunid) attaches: it carries the exchange's `trace`, request and response bodies included, which is a per-row cost a list cannot take.
A design run with no stored result - still running, or one whose result write failed - **omits the key** rather than reporting `statusCode: 0`, which is the wire's own way of saying the request never reached a server.

A **load run's** row carries its own `resultSummary` once the run is terminal (`completed`, `failed` or `stopped`; #2130), read from the whole-run summary the run stored, never from its result rows, which are many and unbounded:

| Key | Meaning |
|-----|---------|
| `rps` | Achieved requests per second over the run, the report's `summary.avgRps` |
| `p95Ms` | 95th-percentile latency in milliseconds, the report's `latency.p95`; omitted when the run timed no request (`latency.count` 0), not a stored 0 |
| `errorRate` | Percentage (0-100) of the run's status-code distribution that was errors: a status outside 2xx/3xx, or no response at all |
| `verdict` | `"passed"` or `"failed"`: the run's verdict against its declared `thresholds`, the same one the report's `thresholdValidation.verdict` prints |
| `assertions` | The run's assertion block (#3537), the report's top-level [`assertions`](#get-runsrunidreport) as it serves it, for both load run kinds: `exact` and `sampled` (each `{passed, failed}`), `errored` and `teardownFailed`. Beside `errorRate`, not folded into it |
| `assertionsPassed`, `assertionsFailed` | `assertions.exact` plus `assertions.sampled`, for readers older than the block (#2820, #3458). A required `extract.*` miss is in `assertionsFailed`, the count a `maxAssertionFailureRatePct` check's `assertionsExact` reports. `errored` and `teardownFailed` are not in it |
| `capacity` | A capacity run's headline (#2930), the same three keys of the report's [`capacity` section](#get-runsrunidreport): `stopReason`, and `maxHealthyConcurrency` / `kneeConcurrency` each only when the search found that level |
| `drainCut` | `{cancelled}`, the requests a Stop cut from the run's own drain (#3538), the report's `summary.drainCut`. Present only on such a run, which a reader treats as not judged unless `verdict` is `"failed"`; `verdict` itself stays the budgets' own |

Each key is **omitted** when the stored summary does not record it, never zeroed: `errorRate` is absent when the run recorded no status codes, and `verdict` is absent when the run declared no budgets - it was never judged, which is not the same claim as passing.
The three assertion keys are absent together, for a run that made no assertion and errored nowhere.
A run stored before #3537 reads as it did: a scenario load run's `assertions` is its `scenario.assertions` as `exact` alone, absent on a run stored before #2820, and a single-request run's is its `assert.*` and `script.*` rows of `elements` as `exact` (counted per execution, a required `extract.*` miss not in it) and its `testValidation` as `sampled`; neither has `errored` or `teardownFailed`.
A scenario load run whose every deferred `pm.test` failed against `200`s reads `"resultSummary": { "rps": 172.0, "p95Ms": 12.4, "errorRate": 0, "assertions": { "exact": { "passed": 0, "failed": 0 }, "sampled": { "passed": 0, "failed": 91 }, "errored": 0, "teardownFailed": 0 }, "assertionsPassed": 0, "assertionsFailed": 91 }`.
`capacity` is absent on every run that was not a capacity search; inside it, `maxHealthyConcurrency` is absent when the very first level already breached the budget and `kneeConcurrency` when the search ended without the target giving out, the report's rules for the same keys.
A capacity search that stopped on its latency budget reads `"capacity": { "stopReason": "slo_exceeded", "maxHealthyConcurrency": 48, "kneeConcurrency": 64 }`.
A run whose drain a Stop cut with 15 requests unanswered reads `"verdict": "passed", "drainCut": { "cancelled": 15 }` when the answered requests met every budget.
A `pending` or `running` load row, and a terminal one with no stored summary (the engine stopped before writing it), carries no `resultSummary` at all.

`verdict` is the verdict as stored, even for a `stopped` run, whose partial data the app shows as "Not judged" rather than passed or failed.
`errorRate` uses the same failure definition as the report's `summary.errorRate`, over the stored status-code distribution, and is omitted when no distribution is stored.

A **collection run's** row (`type: "scenario"`) carries one once it is terminal too (#2954), read from the `scenario` block of the stored summary under the same rule: nothing for a `pending` or `running` row, nothing for a terminal row whose summary is not stored yet.
The five counts are the step [outcomes](scenario-runs.md#scenario-runs), which are disjoint:

| Key | Meaning |
|-----|---------|
| `passed`, `failed`, `skipped`, `errored`, `stopped` | How many steps ended each way, the report's `scenario.passed` / `failed` / `skipped` / `errored` / `stopped`. `errored` is a step whose script threw or whose exchange did not complete, kept apart from `failed` so a run whose steps only errored does not read clean; `stopped` is a step a Stop or a shutdown cut short (#3397), absent for a run stored before it |
| `verdict` | As on a load row: the run's verdict against its declared `thresholds`, absent when it declared none, and as stored even for a `stopped` run |

Each key is omitted when the stored summary does not record it, never zeroed, and a stored summary with no `scenario` object (a run stored before collection runs wrote one) adds no `resultSummary`.
A clean four-step run reads `"resultSummary": { "passed": 4, "failed": 0, "skipped": 0, "errored": 0, "stopped": 0 }`: the zeros are recorded counts.
The load figures (`rps`, `p95Ms`, `errorRate`) are not on this row; the report has them.

`endTime` is `null` while a row's `status` is `pending` or `running` and the stored value once it is `completed`, `failed` or `stopped` (#2953).
The database seeds the column with `startTime` when a run is created, which would read as a run that took no time, and clears it to `0` once a load or collection run is running (#3340); a client takes "still going" from the `null`, and the same rule holds for `GET /runs/:runId`, the report's `metadata.endTime` and the `PUT /runs/:runId/baseline` row.

**Response (envelope):**
```json
{
  "data": [
    {
      "id": "run_1234567890",
      "requestId": "req_1234567890",
      "environmentId": null,
      "type": "load",
      "status": "completed",
      "startTime": 1234567890,
      "endTime": 1234567891,
      "baseline": true,
      "origin": { "kind": "app", "client": null },
      "outcome": "not_judged",
      "summary": {
        "url": "https://api.example.com/users",
        "method": "GET",
        "mode": "constant_rps",
        "duration": "60s",
        "concurrency": 100,
        "comment": "nightly",
        "followRedirects": true,
        "maxRedirects": 10,
        "httpVersion": "auto"
      },
      "resultSummary": { "rps": 98.7, "p95Ms": 41.3, "errorRate": 0.4, "verdict": "passed" }
    },
    {
      "id": "run_1234567891",
      "requestId": "req_1234567890",
      "environmentId": null,
      "type": "design",
      "status": "completed",
      "startTime": 1234567892,
      "endTime": 1234567893,
      "baseline": false,
      "origin": { "kind": "mcp", "client": "claude-code" },
      "summary": { "url": "https://api.example.com/users", "method": "GET", "httpVersion": "auto" },
      "resultSummary": { "statusCode": 200, "latencyMs": 34.2 }
    }
  ],
  "pagination": {
    "total": 812,
    "limit": 50,
    "offset": 0,
    "hasMore": true,
    "returned": 50,
    "nextBefore": "1234560001:run_1234560001"
  }
}
```

The load row's budgets passed, but `errorRate` is above zero, so its `outcome` is `not_judged`; the design row has none.

`hasMore` is read off the rows: the engine fetches one row past `limit`, so it holds on a cursor page, which has no offset to add to `total`.
`nextBefore` is the cursor naming this page's last row whenever `hasMore` is `true` (an offset page included, so a client can switch to cursors after its first page) and `null` on the last page.
A cursor page echoes `offset: 0`.

## GET /runs/:runId

Get details for a specific run.

**Response:** The run object shown in `GET /runs` (`id`, `requestId`, `environmentId`, `type`, `status`, `configSnapshot`, `startTime`, `endTime`, `baseline`, `origin`).
`endTime` is `null` until the run's `status` is `completed`, `failed` or `stopped`, as on the list row.

While the engine holds the run active, the object also carries `phase`, where its worker is: `setup`, `sending`, `draining`, `summarising` or `settled` (issue #3568), the same value as the live frame's [`phase`](live-metrics.md#get-runsrunidlive).
`draining` means the run's own end has come and it is waiting out the requests still in flight, which a Stop [cuts short without changing the outcome](#post-runsrunidstop).
The phase is never stored, so a run no longer active (finished, or the engine restarted) has no `phase` key at all; read `status` there.

For a `design` run that has at least one stored result, the response also carries a `result` object with that run's single exchange - the only other place it appears is `GET /runs/:runId/report`, whose `results` array and `metadata.configuration` are load-test concepts and are absent for a design run.
**`result` is design-only by construction**: it serves the first stored row on the assumption that there is exactly one, and a `scenario` run has one per step - its steps are read from the report's `results` array instead.

```json
{
  "id": "run_1234567890",
  "requestId": "req_1234567890",
  "environmentId": null,
  "type": "design",
  "status": "completed",
  "configSnapshot": { "...": "the run payload as composed, credentials withheld" },
  "startTime": 1234567890,
  "endTime": 1234567891,
  "baseline": false,
  "origin": { "kind": "app", "client": null },
  "result": {
    "timestamp": 1234567891,
    "statusCode": 200,
    "statusText": "OK",
    "latencyMs": 42.1,
    "error": "optional, only when the request failed",
    "trace": { "request": { "...": "..." }, "response": { "...": "..." } }
  }
}
```

`trace.error_type` / `trace.error_message` are present when the exchange failed, and `trace.response` when it did not or when the failure came after a header block arrived (issue #3423): an undecodable body, a timeout mid-body, too many redirects.
Such a failure is still reported at `statusCode` 0, and its trace keeps the `headers`, `headerLines`, `httpVersion` and `body` the live answer showed beside the error, so a client must not read the presence of `response` as success.
A failure that received no header block (a refused connection, an unresolved host, a failed handshake) has no `trace.response`.
A proxy's answer counts as a header block: a proxy's refusal, or headers on the tunnel it opened, are kept as the live answer shows them.

Every `trace.response` carries `bodyBytes` (issue #3423), the body's length in bytes, which a client cannot recount from `body` because a JSON string's length is not its UTF-8 size.
It is the length the engine held, which for a `bodyCapped` response is the prefix the read cap kept; a streaming run's is the body bytes the server delivered (issue #3238), which its `body` can be shorter than (at most `maxDesignResponseBodyBytes`, an event stream's bytes included since #3770; see [`POST /execute`](execute.md#post-execute)).
A row stored before #3770 holds no body for an event stream, and one stored before #3423 carries `bodyBytes` only on a cut or streamed response.

If the engine truncated a body for storage (over `maxTraceBodyBytes`), the affected `trace.request` and/or `trace.response` object carries `"bodyTruncated": true`, and `trace.request` gains `"bodyBytes": <original length>`; a storage cut keeps the response's `bodyBytes` rather than restating it.
Absent when the body fit.
A text `body` then holds the first `maxTraceBodyBytes` bytes of the original, less an incomplete last UTF-8 character the cut would leave, so it can be up to three bytes shorter and never ends in a U+FFFD the server did not send.
Clients surface this as a "body truncated for storage" notice and re-send to fetch the whole body.
A `trace.response` with `"bodyEncoding": "base64"` (see [`POST /execute`](execute.md#post-execute)) is measured in decoded bytes: its `body` is the base64 of the first `maxTraceBodyBytes` bytes rounded down to a multiple of three, so the slice still decodes, and `bodyBytes` counts decoded bytes.

`configSnapshot.body` is capped the same way, independently of the trace (issue #1486): `content` over `maxTraceBodyBytes` is cut to that length and the `body` object gains the same `bodyTruncated` / `bodyBytes` pair.
A run can be truncated on one side and not the other, since each is written by its own call into `sanitize_config_snapshot`.

`configSnapshot` withholds the composed request's credentials (issue #1803):
`auth` is reduced to `{"mode": ...}`, a header named in the shared secret set (`Authorization`, `Cookie`, `X-Api-Key`, ...) or by the request's `apikey` auth keeps its name with the value `"<redacted>"`,
and every value of a variable marked secret in the payload's scopes (globals, `environmentId`, the collection chain of `requestId`'s request, else of the composed `collectionId`, issue #3461;
for a scenario run, the chain of the run collection and of every folder a step sits in, so a recursive run masks a secret held on a sub-folder, issue #3270) is written as `<redacted>` wherever it landed in `url`,
`params`, `headers` or `body`, in its raw, percent-encoded (strictly, and as composition writes a query value, a path, a fragment and user info, which leave `/ @ & : + '` raw where the strict form escapes them), JSON-escaped and XML-escaped forms (a JSON body holds `pa"ss` as `pa\"ss`).
A value under four characters is not masked.
`result.trace` is the record of what was sent and keeps it all.
A run stored before this change returns its snapshot as it was written.

A load or collection run's `configSnapshot` also carries `defaultHeaders` (issue #1488), the run's resolved decision at start about what the engine would add to a request nobody wrote it into - never re-read for the send itself (see [Default request headers](health-config.md#default-request-headers)), kept only so a later run's report can say whether the two measured under the same conditions:

```json
"defaultHeaders": { "userAgent": "Vayu/0.26.0", "requestId": false, "acceptEncoding": true, "expectContinue": false }
```

`expectContinue` (issue #2516) is whether `sendExpectContinue` let libcurl add `Expect: 100-continue` to a body over 1 MiB, which makes it wait up to a second for the server's answer before sending.
A run recorded before it has no such key, and a comparison reads that as `false`, which is what the run sent.

Absent on a design run (it carries no throughput to compare) and on any run recorded before this issue.

## POST /runs/:runId/stop

Stop a running load test or collection run.
The engine signals the run, waits up to 5s for its worker to settle, and answers with a summary of what the run actually did.
A collection run's summary is optional; see [Stopping a collection run](#stopping-a-collection-run) below.

**What a Stop means depends on the phase it lands in** (issue #3341).
A load run moves through `setup`, `sending`, `draining`, `summarising` and `settled`, and the first Stop is latched with the phase it arrived in.
The phase is never stored; while the run is active it is published as `phase` on every live [`metrics` frame](live-metrics.md#get-runsrunidlive) and on [`GET /runs/:runId`](#get-runsrunid) (issue #3568).

- **A Stop before the strategy returns (`setup` or `sending`) decides the outcome, and the run ends `stopped`.**
  The queued backlog is thrown away rather than sent, and transfers already in flight are cancelled (removed from curl and completed as a `CANCELLED` "Request cancelled"), so the target stops receiving traffic immediately and the stop's latency does not belong to the upstream.
  A cancelled request was submitted, so it is counted, but **not as an error** (issue #2136): it is `summary.cancelled`, outside `totalRequests`, `errors` and `errorRate` (see [What counts as an error](metrics.md#what-counts-as-an-error)).
  Every request the run sent is in exactly one of `totalRequests` and `cancelled`.
- **A Stop after the strategy returned on its own (`draining`) decides nothing about the run's end.**
  A run that ends **naturally** lets its in-flight requests finish, but only up to its effective timeout (its own `timeout`, else the `defaultTimeout` setting) plus a 2s grace, except a streaming run, whose bound is its `maxStreamDurationMs` plus grace (the 5s stream backstop plus the same 2s, issue #2834).
  A Stop in that drain cuts it short at once: the transfers still in flight are cancelled and counted as `cancelled`, not as errors, because the operator asked for it.
  The run keeps its own end - `completed`, or `failed` when `thresholds.failRun` judges it so - and its sending window is what it would have been without the Stop, since the Stop ended no sending.
  When the Stop cancelled anything, the summary records it as `drainCut: {cancelled}` (issue #3538), and the run reads **not judged** ("15 requests were still unanswered when the drain was stopped") unless a budget it already missed fails it: the requests the Stop cut are the slowest the run sent, and judging what is left would pass a run on its fastest answers.
  A Stop in either phase also ends the deferred test replay and any script still running (#3460): the running script stops at its next interrupt poll and no further sample is replayed, so `testValidation.samplesTested` counts the samples the replay reached and the worker settles within the 5s below instead of after each remaining sample's `scriptTimeout`.
  `script.teardown` still runs after a Stop latched before it (see [scripting.md](../scripting.md#sending-a-request-from-a-script-pmsendrequest), "A Stop ends the script itself").
- **A drain that hits its deadline with no Stop** cancels what is still outstanding the same way, and because nobody asked for that one to stop, it is an error with no response, not a cancellation.
  Without that bound an upstream that never answers would hold the run in `running` indefinitely.

[`POST /shutdown`](health-config.md#post-shutdown) follows the same rules: it also cuts a natural-end drain short and leaves the run `completed`.

**Response** (active run).
`status` is the stored status once the worker has written a terminal one; before that it is `stopped` when the Stop decided the outcome, and `running` when it landed after the run's own end (the `draining` phase), where the worker has not yet written the `completed` or `failed` it will end with.
`running` there is accurate rather than a failure to stop: the drain is already cancelled, and the terminal status follows once the worker writes it.
When the worker has not settled within the 5s, the answer also carries `message`: `"Stop signalled; the run had not settled within the 5s grace period; read the report"` (#3342); a run that settled carries none.
```json
{
  "status": "stopped",
  "runId": "run_1234567890",
  "summary": {
    "totalRequests": 1500,
    "errors": 5,
    "httpErrors": 3,
    "noResponse": 2,
    "cancelled": 12,
    "errorRate": 0.33,
    "avgLatencyMs": 38.9
  }
}
```

`errors` and `errorRate` are the [one error definition](metrics.md#what-counts-as-an-error), the same figures the live tick and the report show; `httpErrors` and `noResponse` split `errors`.
`cancelled` is the requests this stop cancelled, counted in none of them.

`avgLatencyMs` is the same average the final report and the live ticks show: the latency sum over the [latency population](metrics.md#latency-population), divided by the number of requests in it.
It is not divided by `totalRequests` (which counts requests that carry no latency, so it would report a lower figure here than everywhere else for the same run) nor by the success count (a timeout's duration is in the sum).

A run that is already finished answers `{"status": "<status>", "runId": ..., "message": "Run already <status>"}`; one that is not in memory answers `{"status": "stopped", "runId": ..., "message": "Run was not active"}`.
That is a buffered design send, or a run still `pending` before its worker started (#3340): the row moves to `stopped` from `pending` or `running` only, so the stop stands.
A worker that had not started yet finds the row `stopped` and ends without sending; one that started in the meantime is signalled too.
A buffered send's exchange still completes and its result is stored, under a row that stays `stopped`; only a hang-up of the `POST /execute` call cancels it (see above).
A run whose row is gone by the time the move is tried answers `404`.

**A streaming design run** (`POST /execute` with `"stream": true`) is stopped here too: the endpoint asks its consumer worker to end the transfer, waits up to the same 5s, and answers `{"runId": ..., "status": ..., "message": ..., "totalEvents": N}`.
The worker owns the terminal write, so the run reaches its status with its trace and its true event count together, and `status` is the one it stored (#3342):

| `status` | `message` | When |
|----------|-----------|------|
| `stopped` | `Stream stopped` | The transfer read the stop; the stream's `complete` event carries `"reason": "stopped"` |
| `completed` | `The stream had already ended` | The server had closed the stream, or a cap had ended it, before the transfer read the stop (its post-request script was still running) |
| `failed` | `The stream failed before the stop took effect` | The transfer had already failed |
| `running` | `Stop signalled; the run had not settled within the 5s grace period; read the report` | The worker had not stored a result within the 5s, usually a slow post-request script; the stop still stands |

A stream that had already terminated keeps the reason it recorded rather than being rewritten as a user stop.

### Stopping a collection run

A sequential collection run (a `scenario` run, issue #2822) feeds no load collector, so its answer is read from the summary its worker stores once it has stopped, the same one the [report](#get-runsrunidreport) reads:

```json
{
  "status": "stopped",
  "runId": "run_1234567890",
  "summary": {
    "totalRequests": 31,
    "errors": 2,
    "httpErrors": 2,
    "noResponse": 0,
    "errorRate": 6.45,
    "avgLatencyMs": 12.5,
    "stepsExecuted": 40
  }
}
```

`totalRequests` is **requests sent** and `stepsExecuted` is **steps**, as in the report: a step the plan skipped is a step and not a request.
`errors`, `httpErrors`, `noResponse` and `errorRate` come from the stored status-code distribution over those requests, and `avgLatencyMs` is the stored latency block's `avg` (`0` when no step sent).
There is no `cancelled`: a collection run keeps no count of what its stop cancelled.
`status` is the run's stored status.
A sequential run has no drain, so a Stop always lands while it is sending and decides the outcome: the run ends `stopped`.

**The summary is absent when the worker has not stored one** within the 5s, or could not store it.
The answer is then `{"status": "<stored status>", "runId": ..., "message": "Stop signalled; read the report"}`, usually with `status` `running`; when the 5s ran out, `message` says so, as for a load run above.
The stop still stands: read the run's report once it reports a terminal status.
A scenario **load** run is a `load` run and answers from its collector as above.

## GET /runs/:runId/report

Get the final report for a completed run.
The response is a **nested** object; conditional sections appear only when relevant (e.g. `rateControl` only for `constant_rps`, `testValidation` only when a test script ran, `thresholdValidation` only when the run declared [budgets](load-runs.md#the-thresholds-block-passfail-budgets),
`assertions` only when a load run asserted or an element errored, `capacity` only for a `capacity` run, `auth` only when the run's OAuth 2.0 credential could be refreshed mid-run, `coverage` only for a run measured against a bound spec, `schemaValidation` only for a run that checked at least one response against one).

**Response:**
```json
{
  "metadata": {
    "runId": "run_1234567890",
    "runType": "load",
    "status": "completed",
    "startTime": 1234567890,
    "endTime": 1234567950,
    "requestUrl": "https://api.example.com/users",
    "requestMethod": "GET",
    "configuration": {
      "mode": "constant_rps",
      "duration": "60s",
      "concurrency": 100,
      "targetRps": 100,
      "followRedirects": true,
      "maxRedirects": 10,
      "httpVersion": "auto",
      "dataRowCount": 2,
      "dataFileName": "users.csv",
      "dataFileHash": "<sha256>",
      "dataFileCastNumbers": true,
      "carriedBudgets": ["latencyP99Ms"],
      "acceptEncoding": true,
      "expectContinue": false
    },
    "openapi": {
      "specId": "spec_3f2b1c9a-...",
      "specHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    }
  },
  "summary": {
    "totalRequests": 6000,
    "successfulRequests": 5970,
    "failedRequests": 30,
    "httpErrorRequests": 20,
    "noResponseRequests": 10,
    "cancelledRequests": 0,
    "errorRate": 0.5,
    "totalDurationSeconds": 60.4,
    "avgRps": 99.34,
    "testDuration": 60.4,
    "sendRate": 100.0,
    "throughput": 99.34,
    "setupOverhead": 0.12,
    "cleanupOverhead": 0.03,
    "peakConcurrency": 100,
    "droppedRequests": 0,
    "skippedRequests": 0,
    "stalledMs": 0,
    "avgQueueWaitMs": 0.4,
    "avgInFlight": 4.2,
    "bytesSent": 192000,
    "bytesReceived": 7680000,
    "throughputBytesPerSec": 127152.32,
    "httpVersionDowngraded": 0,
    "connectionReplays": 0,
    "sendingDurationSeconds": 60.0,
    "completedWhileSending": 5990,
    "errorClasses": {}
  },
  "latency": {
    "min": 12.3, "max": 1250.5, "avg": 42.1, "median": 38.5,
    "p50": 38.5, "p75": 45.2, "p90": 78.3, "p95": 95.1, "p99": 156.7, "p999": 450.2
  },
  "statusCodes": [[0, 10], [200, 5970], [500, 20]],
  "rateControl": { "targetRps": 100, "actualRps": 100.0, "achievement": 100.0,
                   "requestsSent": 6000, "requestsExpected": 6000 },
  "errors": {
    "total": 30,
    "withDetails": 10,
    "types": { "timeout": 6, "connection_failed": 4 },
    "byStatusCode": [[0, 10], [500, 20]]
  },
  "timingBreakdown": {
    "avgDnsMs": 0.15, "avgConnectMs": 0.42, "avgTlsMs": 0.31,
    "avgFirstByteMs": 3.1, "avgDownloadMs": 0.14,
    "phases": {
      "dns":       { "p50": 0.1, "p95": 0.2, "p99": 1.4,  "max": 12.0, "count": 6000, "mean": 0.15 },
      "connect":   { "p50": 0.3, "p95": 0.9, "p99": 8.2,  "max": 40.1, "count": 6000, "mean": 0.42 },
      "tls":       { "p50": 0.0, "p95": 0.0, "p99": 22.0, "max": 61.0, "count": 6000, "mean": 0.31 },
      "firstByte": { "p50": 2.9, "p95": 4.0, "p99": 6.1,  "max": 30.0, "count": 6000, "mean": 3.1 },
      "download":  { "p50": 0.1, "p95": 0.3, "p99": 0.9,  "max": 4.2,  "count": 6000, "mean": 0.14 }
    }
  },
  "slowRequests": { "count": 12, "thresholdMs": 1000, "tracesStored": 12, "percentage": 0.2 },
  "warnings": [
    { "code": "unresolved_tokens",
      "message": "12 requests sent with unresolved variables: token",
      "count": 12, "names": ["token"] },
    { "code": "pre_request_script_skipped",
      "message": "1 step carries a pre-request script that does not run under load",
      "steps": 1 },
    { "code": "cookies_dropped",
      "message": "4 Set-Cookie headers were dropped across the run by libcurl's cookie engine (a line over 5000 bytes, a name and value over 4096 bytes, or more than 50 in one response), so the virtual users that received them sent their later steps without those cookies.",
      "count": 4 }
  ],
  "stream": { "...": "streaming runs only - see below" },
  "sampling": {
    "errorsDropped": 0, "successTracesDropped": 29000,
    "slowTracesDropped": 0, "responseSamplesDropped": 998000,
    "exemplarsDropped": 0, "sampleBodiesDropped": 12,
    "responseBodiesCaptured": 23, "responseSampleBudgetSpent": false
  },
  "monitor": {
    "samples": 58, "failures": 2, "noMatchScrapes": 0, "lastError": "timed out",
    "series": {
      "node_cpu_seconds_total": { "min": 1.2, "max": 3.9, "avg": 2.6, "count": 58 }
    }
  },
  "testValidation": {
    "samplesTested": 500, "testsPassed": 498, "testsFailed": 2, "successRate": 99.6,
    "console": [ { "level": "warn", "text": "cache miss for /users", "count": 412 } ],
    "consoleDropped": 3
  },
  "thresholdValidation": {
    "checks": [
      { "metric": "latencyP99Ms", "limit": 50, "actual": 47.2, "passed": true, "evaluated": true }
    ],
    "passed": 1, "failed": 0, "verdict": "passed"
  },
  "assertions": {
    "exact": { "passed": 0, "failed": 0 }, "sampled": { "passed": 498, "failed": 2 },
    "errored": 0, "teardownFailed": 0
  },
  "customMetrics": {
    "ttfb2": { "type": "trend", "count": 42, "p50": 10.0, "p95": 40.0, "p99": 47.0, "max": 50.0 },
    "bytesOut": { "type": "counter", "count": 4, "value": 4096.0 },
    "cacheHit": { "type": "rate", "count": 10, "value": 30.0 }
  },
  "auth": { "refreshes": [ { "atSeconds": 3620.4 } ], "refreshFailures": 0 },
  "coverage": {
    "operationsTotal": 18, "operationsCovered": 14,
    "declaredResponsesTotal": 41, "declaredResponsesHit": 29,
    "declaredResponseCoveragePct": 70.7, "undeclaredStatusesSeen": 1,
    "operations": [
      { "operationId": "deletePet", "method": "DELETE", "path": "/pets/{petId}",
        "sent": 0, "statusesSeen": [], "declaredHit": [], "declaredMissed": ["204"],
        "undeclaredSeen": [] }
    ]
  },
  "schemaValidation": {
    "sampled": 40, "checked": 36, "valid": 30, "failed": 6, "unevaluated": 0,
    "uncheckedReasons": { "body_not_json": 4 },
    "failures": [ { "step": "get pet", "status": 200, "path": "/id", "message": "Value type not permitted by 'type' constraint." } ],
    "failuresTotal": 6
  },
  "lifecycle": {
    "setup": [ { "id": "el_setup1", "kind": "script.setup", "outcome": "ok",
                 "scriptRequests": [ { "scope": "collection", "status": 200, "request": { "...": "..." },
                                       "response": { "...": "..." }, "totalMs": 41.2 } ] } ],
    "teardown": [ { "id": "el_teardown1", "kind": "script.teardown", "outcome": "error", "message": "Error: boom",
                    "messages": [ { "kind": "error", "text": "Error: boom" } ],
                    "console": [ { "level": "log", "text": "tearing down" } ] } ]
  },
  "elements": [
    { "id": "el_1", "kind": "assert.status", "name": "Is 200",
      "passed": 9, "failed": 1, "missing": 0, "error": 0, "skipped": 0, "deferred": 0 },
    { "id": "el_2", "kind": "extract.json", "required": true,
      "passed": 8, "failed": 0, "missing": 2, "error": 0, "skipped": 0, "deferred": 0 },
    { "id": "el_3", "kind": "script.post",
      "passed": 0, "failed": 0, "missing": 0, "error": 0, "skipped": 0, "deferred": 10 }
  ],
  "results": [ { "id": 41, "...": "request/response outcomes, failures first" } ],
  "resultsStored": 4812,
  "resultsCap": 100
}
```

Each section's fields, and the per-step verdicts a collection run adds, are documented in [Collection run verdicts](collection-runs.md).

The whole-run aggregates come from the run's stored `summary` (written once when the run reaches a terminal status - see [db-schema/runs.md](../db-schema/runs.md#runs)), combined with the sampled `results` rows for the timing breakdown and the `results[]` array (at most 100 rows, failures first - see "`results[]` is not a uniform sample" in [Collection run verdicts](collection-runs.md)).
A run with no summary has either not reached a terminal status yet (`metadata.status` is `pending` or `running`) or failed without writing one; its report is built without it rather than erroring.
**The response shape is the same either way.**
A load run the engine died under is marked `failed` at the next start and given the totals of its last persisted tick instead (see "A run the engine died under" below).

A report read while the run is `pending` or `running` is therefore **partial**: `metadata.status` says the run is still in flight, and `thresholdValidation` is absent even when the run declared budgets, because the verdict is computed from the summary written at the end, and `metadata.endTime` is `null` (#2953), not the seed or the `0` the database holds for it.
Read `metadata.status` before treating a report as final.

A design or scenario run stores its `results` rows just before its status flips, and a client fetching once in that gap needs them with their traces, so its partial report is built from the rows stored so far.
A partial report of a **load** run reads no `results` row at all (issue #2659): it is the one a client re-reads on a timer, and a load run writes its rows only as it finishes, in chunks (see [`results`](../db-schema/run-artifacts.md#results)), so a report built from them is all zeros while the run sends and a growing prefix of the flush after.
Its figures come from the run's in-memory counters instead,
the ones the [live stream](live-metrics.md#get-runsrunidlive) reads:
`summary.totalRequests`, `successfulRequests`, `failedRequests` with its `httpErrorRequests` / `noResponseRequests` split, `cancelledRequests`, `errorRate`, `statusCodes` and `errors.byStatusCode`, `droppedRequests`, `skippedRequests`, `stalledMs`, `peakConcurrency`,
`avgQueueWaitMs`, `bytesSent`, `bytesReceived`, `httpVersionDowngraded`, `connectionReplays`, and `avgRps`, `throughput`, `sendRate` and `avgInFlight` over the time from `startTime` to the read, which `testDuration` and `totalDurationSeconds` report (#3340).
`latency` is absent, because the percentiles come from histograms the run is still writing and arrive with the summary.
`results[]` is empty and `resultsStored` is `0` (`resultsCap` is unchanged), `errors.types` is `{}`, `errors.withDetails` is `0`, and `timingBreakdown` and `slowRequests` are absent.
In the moment between the summary write and the status flip the aggregates are the summary's, as for a finished run, still with no row read.
A run whose row says `running` but which the engine no longer holds answers the same shape with every count at zero.

**A run the engine died under** (issue #2895) is marked `failed` when the next engine starts (`reconcile_orphaned_runs`, see [db-schema/runs.md](../db-schema/runs.md#runs)).
A load run that persisted at least one [metric tick](metrics.md#get-runsrunidmetrics) is given a summary built from its last one, and its report carries **`summary.partial: true`**.
The figures are the run's up to that tick:
`totalRequests`, the success/failure split, `errorRate`, `statusCodes` and `errors.byStatusCode` (all from the tick's cumulative status distribution), `cancelledRequests`, `testDuration` (the tick's elapsed seconds), `avgRps` (completions over that time, not the tick's trailing rate), `sendRate`, `throughput`, `droppedRequests`, `skippedRequests`, `stalledMs`, `bytesSent` and `bytesReceived`.
What the tick does not measure for the whole run is absent rather than `0`: `avgInFlight`, `connectionReplays`, `sendingDurationSeconds`, `completedWhileSending`, `peakConcurrency` and `avgQueueWaitMs` (issue #2963), while `setupOverhead` and `httpVersionDowngraded` are `0`, `sampling` is absent, and the report has **no `latency` block** (issue #2938):
the percentiles come from the stored `results` rows, of which such a run has none, so omitting the block says "not recorded" where a block of zeros would read as steps that answered instantly.
The same pass stamps the run's [`outcome`](#get-runs): `failed` for a load run whose summary, the partial one included, gives its row a `resultSummary`, and none for a run without one or for a collection run.
A failed load run with no summary at all, because it wrote no tick or failed on a path that writes none, carries **`summary.summaryMissing: true`**, and its counts are not whole-run totals (those of whatever sampled `results` rows were stored, often `0`) and whose report has no `latency` block either, even where sampled rows exist, and no `peakConcurrency` or `avgQueueWaitMs`.
Both keys are absent, never `false`, on every other report.
A client that shows a figure from a report carrying either one says the figure was not recorded rather than showing it as measured.

**`metadata.scenario`** appears on every collection run, finished or not (issue #3569), and on no other: `collectionId`, `iterations`, `recursive`, the data file's `dataFileName` / `dataFileHash` / `dataFileCastNumbers` and `stepCount`, each omitted when the snapshot lacks it.
It is the run's snapshot identity, echoed as the list row's `scenario` is, and not the top-level [`scenario`](load-runs.md#the-scenario-block-collection-runs) breakdown, which is built from the stored summary and is absent for a run the engine did not finish.
A client that names a collection run reads it here; the manifest's per-step `steps` array is not repeated, only its count.

**`metadata.openapi`** appears only for a run whose collection was [bound to a spec](collections.md#post-collections) when the run was planned (issue #637).
It is echoed from the run's snapshot rather than re-read from the collection: a report has to say what the run was measured against, and the binding is free to have moved since.
An unbound run carries **no `openapi` key at all** - absent rather than an empty object, so "not measured against a spec" has one spelling.

The binding is resolved by walking from the run's collection up to the root and taking the **nearest bound ancestor**, the same walk a single request's design-mode validation uses (issue #716).
An import binds the root and files every request under tag sub-collections, so running one tag folder is measured against the document its root binds.
When the binding came from an ancestor rather than from the collection the run named, the node carries `"inherited": true` - absent otherwise, like every other finding here.
The run still enumerates only its own subtree, so the coverage below is **partial by construction**: most of the contract's operations are honestly uncovered, and that flag is what lets a reader tell scoped-run truth from a collection that has stopped calling its API.

**`coverage`** says which of that spec's operations the run exercised and which of their declared responses it saw (issue #629).
It is present only for a scenario run - design or load - of a collection bound to a document that carries an [operation index](specs.md#post-specs), and **absent, never zeros**, for every other run: an unbound collection, a single-request run, and a document stored before the index existed all report no block rather than a contract covered zero of.

| Field | Meaning |
|---|---|
| `operationsTotal` / `operationsCovered` | Declared operations, and how many got at least one request |
| `declaredResponsesTotal` / `declaredResponsesHit` / `declaredResponseCoveragePct` | Declared status patterns (an `x-` extension key under `responses` is not one), and how many the run produced |
| `undeclaredStatusesSeen` | Distinct (operation, status) pairs the document declares nothing for |
| `operations[]` | Per operation: `sent`, `statusesSeen`, `declaredHit`, `declaredMissed`, `undeclaredSeen`, and `transportErrors` / `otherStatusResponses` / `statusesTruncated` when non-zero |
| `operations[].statusesTruncated` | Distinct statuses the operation answered with that appear in **neither** list - the two are capped at 50 each and `undeclaredSeen` repeats codes from `statusesSeen`, so this is not the entries the two dropped between them |
| `transportErrors` / `undeclaredOperationRequests` | Whole-run findings, present only when they happened |

Rows come back **uncovered first** - an operation nothing exercised is the finding - and in document order within each group, so two runs of one contract print the same way.
A status hits the **most specific** declared pattern that covers it (exact, then a `2XX` range, then `default`), so an operation declaring both `200` and `2XX` that only answered 200 reports `2XX` as missed: those are two distinct promises.
A transport error counts as a request sent and as no response seen; status `0` is never listed as a status the server sent.

**Every number here is exact, not sampled.**
The engine counts each send and each response as it happens, through a tally that is not the bounded `results[]` store - so a load run whose rows were thinned to a reservoir still reports every operation it touched.
Coverage is computed against the document `metadata.openapi` names, at the moment the plan resolved, and stored with the run; a binding that has since synced to a newer spec cannot rewrite it.

`operationsCovered`, `operationsTotal` and `declaredResponseCoveragePct` are deliberately plain numbers, shaped like `thresholdValidation`'s counts, so a headless CI gate can threshold on them without the block being reshaped.
Nothing thresholds on them today.

**`schemaValidation`** says whether the responses a run checked matched the schemas that same document declares (issues #682, #681).
It sits beside `coverage` and is computed against the same document, but on different evidence, and the difference is the block's most important field: coverage counts every send, while this walks whatever the run's mode gave it - the **bounded reservoir of responses a load run stored**, or **every step a collection run executed**.

| Field | Meaning |
|---|---|
| `sampled` | Responses this pass walked - the denominator for everything else |
| `checked` | Of those, the ones a declared schema could speak about |
| `valid` / `failed` | The partition of `checked`. `valid + failed == checked`, always |
| `unevaluated` | Checked responses whose schema carried a keyword the draft-07 validator could not evaluate (a nested `propertyNames` included, #2729) |
| `uncheckedReasons` | Reason code -> count, accounting for every one of `sampled - checked` |
| `unevaluatedKeywords[]` | `{keyword, count}`, so what went unread is named and not only counted |
| `failures[]` | Bounded examples, at most 10: `{step?, status, path, message}`. They cover distinct failing steps (the first failure of each, in the order the steps first failed) before repeating one, so a late failing step is not hidden by an early one (#3038) |
| `failuresTotal` | Every failure found, the cap included - so "3 shown of 90" stays readable |
| `exact` | `true` when `sampled` is the whole population rather than a reservoir - written by a collection run, absent for a load run |
| `failOnSchemaError` | Whether a schema failure was allowed to fail its step. Collection runs only |

The reason codes are the ones [`POST /execute`'s validation node](execute.md#post-execute) uses, unchanged.

**Under load these numbers are sampled, and nothing here pretends otherwise.**
Validation is deferred to run end because a load run refills concurrency on every completion, so a schema walk on that path would cost throughput for the whole run
- and would do so invisibly.
`failed: 0` therefore means "no *sampled* response failed".
`sampled` is written so a reader always has the denominator; the app renders it beside the tallies for the same reason.

**A collection run writes the same block with `exact: true`**, because it sends one request at a time and checks every step - there is no hot path to keep off, so `sampled` there *is* the run.
The flag exists so a reader is never left to infer the denominator from the run's mode: the same five numbers are a wider claim in one than the other, and only the block knows which.
A report written before the flag existed was sampled, which is why absent reads as sampled.

A step's responses are kept when a deferred pass will read them - it carries a script, or it is bound to an operation and the document carries schemas - and the run's sample budget is split evenly across those steps.
What was displaced is reported as `sampling.response_samples_dropped`.

**Absent, never zeros**, for every run that checked nothing: an unbound collection, a single-request run, a document carrying no response schemas, and a run whose reservoirs held nothing.
A run whose responses were never checked did not pass a contract.

## GET /runs/:runId/samples

Get the response headers and body a load run captured for its retained samples.
Paginated; **no deprecated alias** - the endpoint is new in 0.15.0, so there is no pre-consolidation spelling for it to keep working.

Deliberately **not** part of `GET /runs/:runId/report`.
That path loads every `results` row for the run and JSON-parses each `trace_data` to accumulate aggregates that never look at a body, and the dashboard polls it; at 1000 samples carrying 32 KiB bodies, folding them in would turn every poll into ~32 MB read from SQLite and parsed.
So the bodies live in their own tables and are fetched here, per page, only when a reader actually expands a sample.

**Query params:**

| Param    | Default | Notes                                     |
|----------|---------|-------------------------------------------|
| `limit`  | `50`    | Capped at 500; a non-numeric value falls back to the default |
| `offset` | `0`     | Floored at 0                              |

**What a run captures** - and does not - is described under [`result_bodies`](../db-schema/run-artifacts.md#result_bodies): every error, the slow outliers, and the first three of each distinct status code, within `maxSampleBodyBytes` per body and `maxSampleBytes` for the run.
A uniformly sampled success carries no body by design.

**Response:**
```json
{
  "data": [
    {
      "resultId": 41,
      "response": {
        "headers": { "content-type": "application/json", "server": "nginx" },
        "body": "{\"error\":\"upstream timeout\"}",
        "bodyEncoding": "utf8",
        "bodyBytes": 28,
        "contentType": "application/json"
      }
    },
    {
      "resultId": 42,
      "response": {
        "headers": { "content-type": "image/png" },
        "bodyBytes": 20480,
        "contentType": "image/png",
        "binary": true
      }
    }
  ],
  "pagination": { "total": 23, "limit": 50, "offset": 0, "hasMore": false, "returned": 23 }
}
```

`resultId` is the `results` row this exchange belongs to - join it against `results[].id` on the report rather than re-deriving an order.

The `response` node always carries `headers` and `bodyBytes` (the size **as received**, before any truncation).
The rest is conditional, and each key means something the bytes alone cannot say:

| Key             | When present | Meaning                                                                 |
|-----------------|--------------|-------------------------------------------------------------------------|
| `body`          | Not binary   | The stored bytes, as `bodyEncoding` says. `""` when the response had none, or when the body was dropped |
| `bodyEncoding`  | Not binary   | `"utf8"`: `body` is the stored text. `"base64"`: the stored bytes are not valid UTF-8 text (or hold a NUL) and `body` is their standard, padded base64 |
| `bodyTruncated` | `true` only  | `body` is a prefix; the response was larger than `maxSampleBodyBytes`. Same convention design-mode traces use |
| `bodyDropped`   | `true` only  | The run's `maxSampleBytes` budget was spent before this sample: headers kept, body not. **Distinct from an empty response body** |
| `binary`        | `true` only  | Stored as a descriptor - `bodyBytes` and `contentType`, no bytes. See [`result_bodies`](../db-schema/run-artifacts.md#result_bodies) for why a binary body is never stored as text |
| `contentType`   | Non-empty    | The response's `Content-Type`                                           |
| `events`        | Streams only | What the stream delivered, in the trace's `events` shape (see below). Absent for every sample that did not stream |

**`bodyEncoding: "base64"` is not `binary: true`** (issue #3159).
`binary` is decided when the sample is captured, from the `Content-Type` and the first 1024 bytes, and such a body is never stored.
A body that passed that sniff is stored as text, and `bodyEncoding` is decided when the sample is read, over every stored byte, because a JSON string holds only UTF-8: a NUL or a byte that is not UTF-8 past the first 1024 lists the whole body as base64, with `bodyBytes` still the size as received, never the encoded length.
A body the `maxSampleBodyBytes` cap cut inside a multi-byte character is first trimmed back to a character boundary, so it stays `utf8` with `bodyTruncated` set rather than turning the whole prefix into base64.

**A streamed sample carries its events** (0.17.2).
`events` is `{items, totalEvents, eventsTruncated}` - the same node a streaming design run's trace is served with, minus `endReason` and each item's `receivedAt`: under load a stream ends by server close or by one of two caps (`maxStreamEvents` / `maxStreamDurationMs`) and nothing per sample records which, so no reason is named rather than one invented.
The list is parsed out of the stored body on read, bounded by `sseMaxStoredEvents`, and `totalEvents` is the count taken **on the wire** - so a capture the `maxSampleBodyBytes` cap cut still reports the whole stream's length, with `eventsTruncated` covering both that cut and the stored-events cap.
The events are parsed from the stored bytes whatever `bodyEncoding` says, and a byte in an event that is not UTF-8 is answered as U+FFFD.
A sample whose request declared a `streamTextPath` (issue #3773) stored the path beside the count, so each item carries its `text` and the node gains `streamText`, both derived from the stored bytes as on a design stream's trace; a sample without one carries neither.
See [`result_bodies`](../db-schema/run-artifacts.md#result_bodies) for why the count and the path are stored and the list is not.

```json
"events": {
  "items": [ { "event": "token", "data": "hello", "sourceId": "42" } ],
  "totalEvents": 4000,
  "eventsTruncated": true
}
```

**Captured data is stored verbatim** - no redaction, consistently with design-mode traces, which already store request headers as sent.
A response `Set-Cookie` is captured along with everything else.
It is deleted with the run, so `maxRunsRetained` is its expiry.

A run that captured nothing is an empty page, not an error; an unknown run id is a **404** in the shared error shape.

**Response (404):**
```json
{ "error": { "code": 404, "message": "Run not found" } }
```

## GET /runs/:runId/results/:resultId

One stored result of a run (#3704), in the shape of its entry in [`GET /runs/:runId/report`](#get-runsrunidreport)'s `results[]`: `id`, `timestamp`, `statusCode`, `statusText`, `latencyMs`, `error` when the exchange failed, and `trace` when one was stored, without the cost of the whole report.
The trace is served as stored: a design send's request and response bodies at the length `maxTraceBodyBytes` kept, and its `scripts.scriptRequests` holding every `pm.sendRequest` the scripts made, by index, in the shape [`POST /execute`](execute.md#post-execute) answers them.
A streamed send's `response.body` is the stream's bytes, and its `events` list is parsed from them as it is served, not stored (issue #3770, [`POST /execute`](execute.md#post-execute)).
A trace that does not parse is served as its stored text, a JSON string, as the report serves it.
Reads only.

The handle is the `runId` and `resultId` a recorded buffered [`POST /execute`](execute.md#post-execute) answers; any `results[].id` of the report, or `resultId` of [`GET /runs/:runId/samples`](#get-runsrunidsamples), names a row too.
`resultId` is digits only; anything else matches no route.

**Response:**
```json
{
  "id": 42,
  "timestamp": 1763452800123,
  "statusCode": 200,
  "statusText": "OK",
  "latencyMs": 245.5,
  "trace": {
    "request": { "method": "GET", "url": "https://api.example.com/users", "...": "..." },
    "response": { "body": "{\"id\":1,\"name\":\"John\"}", "...": "..." },
    "scripts": { "scriptRequests": [ { "source": "pre", "...": "..." } ] }
  }
}
```

**Response (404):** an unknown run is `Run not found`; a `resultId` that is not a stored row of *that* run - another run's result, or an id past the 32-bit range - is `Result not found`.
```json
{ "error": { "code": "not_found", "message": "Result not found" } }
```

## PUT /runs/:runId/baseline

Pin (or unpin) any run - design, load or scenario alike.
`PUT` rather than `POST` per the [create vs update](resource-writes.md#resource-writes-create-vs-update) split: the run already exists, and this updates it.
There is no deprecated alias; the endpoint is new.

Two things follow from a pin, and both are the point of it:

- **Retention never expires it.**
  `prune_runs` skips a baseline under both count caps and the age cap, and a pinned run does not count toward `maxRunsRetained` or `maxDesignRunsRetained` either - a pin a cap could expire is not a pin, and pins crowding a cap would evict the recent history the cap exists to keep.
- **Clients can find it**: `GET /runs?baseline=true&requestId=<id>&limit=1`, or `...&collectionId=<id>&...` for a load run over a collection.

The engine's own meaning of the flag stops there - it holds no opinion about *why* a run is kept.
A client's vs-baseline comparison is a narrower, load-only reading of the same flag:
only a load run has the percentiles and throughput a diff needs, so a comparison lists `type=load` alongside `baseline=true` (`GET /runs?baseline=true&type=load&requestId=<id>&limit=1`) rather than treating any pinned row as its baseline - otherwise a more-recently-pinned design or scenario run of the same request would shadow it.

Several runs may be pinned at once (one per request or collection is the expected use).
The engine records the pin and holds no opinion about which baseline applies to which run - that selection is the client's, so a pin never unpins anything else.

**Request body** - `baseline` is required and must be a boolean:
```json
{ "baseline": true }
```

**Response `200`:** the updated run row, in the same shape [GET /runs](#get-runs) lists (including `summary` and `origin`, but never `resultSummary`), so a client can patch its cached row instead of re-listing.

**`400`** when the body is not JSON, has no `baseline`, or `baseline` is not a boolean - including `null`.
Unlike the merge-patch resource updates, an unusable value here is refused rather than ignored: this body has exactly one field, so ignoring it would answer `200` to a request that changed nothing.

```json
{ "error": { "code": "bad_request", "message": "Invalid 'baseline': must be a boolean" } }
```

**`404`** when no run has that id.

## DELETE /runs

Clear run history: delete every run - design, load and scenario alike - except the ones retention never deletes either (issue #2429):

- a run **pinned as a baseline** (see [PUT /runs/:runId/baseline](#put-runsrunidbaseline)) is kept - the pin is a promise to keep the run, and a bulk clear does not break it.
  Unpin first, or name the run in [DELETE /runs/:runId](#delete-runsrunid), to remove one;
- a run whose stored status is still **`running` or `pending`** is kept and left running.
  Stop it, then clear again.

Each run goes with its metrics, results and captured bodies, through the same cascade and the same batched pass as retention: batches of 100, each in its own transaction, and each row re-read under that batch's lock, so a run pinned or started while the clear is under way is spared.
A deleted run is gone for good; runs have no trash.
The call takes no body and no query parameters.

**Response `200`:**
```json
{
  "deleted": 2,
  "keptPinned": 1,
  "deletedIds": ["run_1712345678901", "run_1712345678902"]
}
```

`deleted` is the length of `deletedIds`, the runs this call removed, so a client can close whatever was showing one.
`keptPinned` counts the pinned baselines stored once the clear finished; a run kept for being in flight is in neither number.
An empty history answers `{"deleted": 0, "keptPinned": 0, "deletedIds": []}`.

## DELETE /runs/:runId

Delete a run and all associated metrics/results.

**An active run is stopped first.**
Removing the rows of a run that is still executing would leave its worker writing new metrics and results against the same id - orphan rows that no run owns, and a run that partially reappeared as it finished.
So a run that is still active is stopped exactly as `POST /runs/:runId/stop` stops it, and the rows are removed only once its worker has completed its final writes.
Expect the call to take as long as the stop does (up to ~5s for a large run).

If the worker has not settled within that window nothing is deleted and the call returns **409** - a half-deleted run racing a live writer is worse than a delete that has to be retried.
The stop still stands, so a retry a moment later succeeds.
A run whose stored status is `running` but which has no worker (the daemon restarted under it) has nobody to race and is deleted immediately.

**Response:**
```json
{
  "message": "Run deleted successfully",
  "runId": "run_1234567890"
}
```

**409 Conflict** (still stopping - nothing was deleted):
```json
{
  "error": {
    "code": "conflict",
    "message": "Run is still stopping; it was not deleted. Retry once it reports a terminal status."
  }
}
```
