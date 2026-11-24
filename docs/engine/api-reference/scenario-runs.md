---
description: >-
  A scenario run: a collection executed step by step, how its variables and outcomes are decided.
---

# Scenario runs

A scenario run executes every step of the plan, in order, once per iteration.
Each step is the `POST /execute` exchange - pre-request script, send through the environment's cookie jar, test script - so a step behaves exactly as a Send of the same request does, and the two cannot drift apart.

**What carries between steps.**

- **Variables.**
  The environment, globals and collection scopes are loaded once at run start, mutated in memory by every step's scripts, and written back **once, when the run ends** (through the same diff that keeps a Send from rewriting a scope no script touched).
  The collection scope is each step's own (#3248): the chain from the root collection, through the collection being run, down to the folder the step's request sits in, that folder the one a script's `pm.collectionVariables.set` writes, as on a Send of the same request.
  Each collection is read once, so what one step writes into a folder is what a later step in that folder, or in a folder below it, reads; a sibling folder does not see it.
  A `script.setup` and `script.teardown` read and write the collection that declares them (#3456): the run's lifecycle set is every collection from the root down to the one being run and, on a `recursive` run, every folder beneath it, set up root first and torn down in reverse (see `lifecycle` under [`GET /runs/:runId/report`](runs.md#get-runsrunidreport)).
  Every collection a script changed is written back to its own row in the one write at the end, which comes after `script.teardown` (#3249): a teardown's `pm.environment.set` / `pm.globals.set` is saved with the steps' writes.
  A load run persists no variable, a teardown's included.
- **Cookies.**
  The environment's jar, unchanged - so a step that logs in leaves a session the next step sends.

> **A plan in which anything can write a variable resolves its `{{names}}` at
> each send** (issue #2521). The plan is composed once, at run start, and its
> sequence stays fixed for the run. When any step of it carries an enabled,
> non-blank element that writes a variable scope before some send - a
> `script.pre`, a `script.post` (a test script), a `script.setup`, or any
> `extract.*` kind, on the request, a folder above it or the collection; a
> `script.teardown` alone does not count, because it runs after the last send
> - **every** step keeps each name a scope answers written, scripted or not,
> and each iteration resolves them immediately before that step's send,
> against the scopes as every script and extractor up to and including the
> step's own pre-request script left them, read through the step's own folder
> chain (#3248), so a sub-folder's `{{name}}` in a recursive run is its
> folder's value. That is Postman's order: a login
> whose test script or extractor stores a new token is followed by a step whose
> `Bearer {{token}}` carries that token, on every run and every iteration, and
> not the one the environment held when the run started. The same four kinds of
> name as in [`deferredVariables`](compose.md#deferredvariables) still resolve at
> composition, and an OAuth 2.0 config defers only on a sequential run (a load
> run acquires its token at plan time).
>
> **A plan with no such element is resolved once, before the first send**,
> exactly as before: a name that already had a value when the run started is
> fixed for the whole run, which is what keeps a collection edited mid-run from
> changing the sequence underneath it.
>
> **A name composition could not answer** (issue #1008) is resolved the same
> way. Since #1009 that name keeps its braces instead of resolving to `""`, so
> each step resolves it again, immediately before that step's own send, against
> the scopes as every script up to and including that step's own pre-request
> script left them - not just through `pm.environment.get(...)` and a
> `pm.request` edit, though a script can still reach it that way too. That is
> what lets a step early in the plan fetch a token and a later step's `Bearer
> {{token}}` carry it with no script of its own. A step's own request holds one
> search per field, and a plan where every name was already defined at run start
> and nothing writes a variable pays that and nothing else.
>
> The exceptions are the two reserved namespaces below, which neither pass
> touches: `{{data.*}}` and the `{{$vu}}` / `{{$iteration}}` identity (issue
> #994). Composition leaves both alone so the runner can bind them per
> iteration, and neither is a name any script scope answers either. **A bare
> name the run's `dataColumns` names travels the same way** (issue #1007):
> composition defers it exactly as it defers `{{data.*}}`, and the per-row bind
> substitutes it before the step's pre-request script ever runs - so neither
> pass sees it unresolved, and neither can answer it from a same-named
> environment variable instead of the row.

**Scripts** additionally read `pm.info.iteration` (0-based), `pm.info.vu` (1-based) and `pm.info.iterationCount`.
See [scripting.md](../scripting.md#script-identity-pminfo) for which run shapes report which.

**A run with `data` binds one row per iteration.**
Row `i % rows` binds to iteration `i`, and the run's scripts read it as `pm.iterationData` - `get(name)` and `toObject()`, read-only, and `undefined` for a run sent without `data`.
With `iterations` absent the row count *is* the iteration count; with both given the explicit count wins and the index wraps.
The rows reach the run's worker and nowhere else: they are not persisted, and the snapshot records the row count (`dataRowCount`) plus the file's `dataFileName` and `dataFileHash` when they were sent, and `dataFileCastNumbers: true` when its numbers were read as numbers, never its path or rows.
The full contract is in [scripting.md](../scripting.md#data-rows-pmiterationdata).

**`{{data.column}}` puts the row into the request itself.**
`pm.iterationData` is read *after* a step's request was built, so it cannot change where the request goes; the `data.*` namespace can.
A step whose URL, header or body carries `{{data.email}}` has it substituted with that iteration's row, per iteration, immediately before the send.
A form-data part's `contentType` binds the same way, on a text part as on a file part.

The `{{data.column}}` spelling is **reserved and disjoint from the variable tiers** - not a fourth, higher tier.
`{{data.id}}` and `{{id}}` are different names, so a data set can neither shadow nor be shadowed by a global, collection or environment variable through that spelling, and adding a data file to an existing collection cannot change what its other tokens resolve to.
Composition (`POST /compose`, and the plan resolution that shares it) leaves a `data.*` token written exactly as it stands for that reason; `{{data.}}` with no column after it names nothing and follows the ordinary unknown-name rule instead.

**A bare column name is a second, different rule and it *is* a tier** (issue #1007).
Postman binds a dataset's columns to bare names, so an imported data-driven collection is written `{{username}}` rather than `{{data.username}}`, and while a row is bound that row's own bare column names answer **above the active environment** -
see [D18 in variable resolution](../../app/variable-resolution.md#d18---a-bound-rows-bare-column-names-outrank-the-environment-issue-1007) for the full ladder and the tradeoff it makes against #402's guarantee.
Which bare names a bind owns is not global - it is stated per composition, as the [`dataColumns`](compose.md#post-compose) field, or filled by the engine itself where it already knows the dataset (a scenario plan's steps, a single-request load run, a send carrying one row).
A bare name **not** in that set resolves as an ordinary variable, exactly as it did before this rule existed; only a name the set names is deferred by composition the way `data.*` always was, for the run's per-row bind (`core::apply_data_template`) to join through the identical walk - the same escaping, the same missing-column and null-cell refusals, the same header rules, for either spelling.
There is no second, looser substitution path for the bare one.

**Where a token participates.**
Exhaustively, and identically for both spellings:
the **URL** (path and query string alike, so a token in a stored request's params reaches it once they are joined into the URL), every **header name** and **header value**, the **raw body**, **both halves of every form field** (`x-www-form-urlencoded` and `form-data`), and the **credential fields** of the request's auth -
the bearer **token**, basic auth's **username** and **password**, and an api key's **name** and **value**.
Script text is never interpolated at all (a script reads its row through `pm.iterationData`, or through `pm.variables` for a bare name - see [scripting.md](../scripting.md#variables-pmvariables)).

The pass runs over the **composed** text, not the text as it was authored, so a token that arrived as a *variable's value* binds like any other:
a variable `endpoint` whose value is `/u/{{data.id}}` leaves `{{data.id}}` in the URL after composition - it is rescanned since issue #1009, but the `data.` namespace is deferred to bind time (issue #1007), so this token survives it - and the data pass then binds it.
That is usable, and it is also why the no-data refusal below says "or from the variable value it was written into" - the token it names may not appear anywhere in the request as you wrote it.

**`{{$vu}}` and `{{$iteration}}` are the second reserved namespace** (issue #994), and they bind at the same moment out of the same walk - a field carrying one of each is one string, so both are split once and joined together.
They need no rows behind them: `{{$vu}}` is the virtual user's own 1-based number in a scenario run and `1` in every other shape (one request repeated is one user's iterations, whatever the concurrency), and `{{$iteration}}` is that user's 0-based iteration, the submission index on a single-request run, and `0` on a plain `POST /execute`.
A variable named `$vu` does not answer for the identity, for the reason a variable named `data.id` does not answer for the column, and `{{$vus}}` is an ordinary unknown `$name` that keeps its braces.
They bind everywhere a `data.*` token does, **credential fields included** (issue #1055): a credential carrying either name defers its build and is bound before `apply_auth` encodes it, on every run shape rather than only on one carrying rows, because the identity comes from the iteration rather than from a row.
A credential that also holds a name only a variable scope answers takes the row first and is applied after the pre-request script (#2473), on every send that runs one (see [Authentication](authentication.md#authentication)).
An OAuth 2.0 config is the exception and is refused by name - its token is acquired before any iteration exists.

**A run binds only what it was given rows for.**
A `POST /runs` carrying `scenario.data` binds per iteration, one carrying the top-level [`data`](load-runs.md#the-data-rows-a-data-driven-load-run) binds per submission, and a `POST /execute` carrying a `data` object binds that one row.
A request sent *without* rows performs no data pass at all, so a `{{data.*}}` token in it reaches the wire as the literal text `{{data.id}}` - no substitution, and no warning, since composition leaves the reserved namespace written as it stands by design.
The no-data refusal below is the scenario path's alone: a single request has no plan to refuse before it starts, so a raw API or MCP caller putting `{{data.*}}` into one without rows is asking for the literal braces and gets them.

> **Credentials bind before they are encoded.** A credentials file behind basic
> auth is the canonical data-driven run, so a step whose credentials carry a
> `{{data.*}}` keeps them unresolved in the plan and applies its auth *per
> iteration* instead: the row is bound first, and only then does the username
> and password become one base64 `Authorization`, or an api key become a
> percent-encoded query parameter. Every other step still resolves its auth once,
> when the plan is composed.
>
> **OAuth 2.0 is the exception, and it is refused rather than ignored.** Its
> token is acquired against the token endpoint, never bound per iteration, so no
> iteration exists for a row to reach - a `{{data.*}}` anywhere in an `oauth2`
> config is a `400` at `POST /runs` naming the token, with or without a data
> set. A sequential run acquires a step's token at its send, after the step's
> pre-request script, so an `oauth2` config naming a variable the script sets
> resolves then; a collection load run acquires once at planning and refuses a
> name nothing answers.

Which columns a collection *expects* is a separate, declared thing - see `dataSchema` under [Collections](collections.md#collections) and [Data-driven runs](../../app/data-driven-runs.md).
Declaring it changes no binding rule; it is what lets the refusal above name the columns, and what the app checks a picked file against before the run.

**What a cell renders as.**
The CSV/TSV path produces strings unless the file opted into number reading (#2540), so the first row is the ordinary case; a JSON or JSONL file may carry any type:

| Cell | Substituted text |
|------|------------------|
| String | The string, byte for byte - no quoting round trip |
| Number | As JSON writes it: `7`, `-1.5` |
| Boolean | `true` / `false` |
| Object / array | Compact JSON: `{"a":1}`, `[1,2]` |
| `null` | Nothing - the bind **errors** instead, see below |

**Placement is typed, and that is the point.**
In a JSON body, a token written *inside* a string literal produces a string and a token written *outside* one produces the value's own JSON type:

```json
{ "id": "{{data.id}}", "n": {{data.n}}, "flag": {{data.flag}} }
```

sends `"id":"42"`, `"n":2`, `"flag":true` for a JSON file's `{"id":"42","n":2,"flag":true}`.
Write `"n":"{{data.n}}"` instead and the number arrives quoted; that is the knob, not a bug.

**A value cannot break the document it lands in.**
For a body whose text is a JSON document - `json`, `jsonrpc`, `mcp`, and a `graphql` body written as the `{"query": ...}` envelope - a token inside a string literal binds **escaped**, so a cell carrying `"`, `\` or a newline arrives as its own text inside valid JSON rather than ending the string early.
A token outside a string literal is not escaped, which is what keeps typed placement working.
Nowhere else is anything escaped: a URL, a header, a form field and a `text` body take the rendered value byte for byte, and a bare (un-enveloped) GraphQL document is escaped once, later, when the engine wraps it.

An `xml` body has quoting rules of its own rather than JSON's, so it gets its own encoding - decided per token from where in the document that token sits, because XML has no single escape set the way a JSON string literal does:

| Position | Encoding |
|----------|----------|
| Element text | `&`, `<`, `>` escaped as entities |
| Attribute value | the above, plus the quote delimiting *that* attribute (`"` or `'`, whichever the author wrote) |
| `<![CDATA[…]]>` | verbatim - a `]]>` in the value is written `]]]]><![CDATA[>`, which reopens the section instead of ending it |
| A tag or attribute name (`<{{data.tag}}>`) | verbatim - no escape is legal in a name |
| Inside `<!--…-->` or `<?…?>` | **none - the bind is refused**, naming the token |

The last row is a refusal rather than an encoding because every candidate is wrong there: a comment is not sent as content at all, a processing instruction is markup addressed to the parser, and a value carrying `-->` or `?>` would end the construct and send a document the author did not write.
It errors the step like a missing column does, for every row alike.

The **mode** decides this, not the content: a `text` body holding XML still takes the cell byte for byte.

A token naming a column the bound row does not carry **errors the step before anything is sent**, with a message naming the token, the row index and the columns the row does have.
Substituting an empty string would send a request quietly pointing somewhere else, which is the failure this namespace exists to remove.

A cell carrying a **CR or LF bound into a header** errors the same way.
A header line ends at CRLF, so a cell holding `ok\r\nX-Admin: true` does not put that text in the header - it ends the header and makes the remainder a header of its own, forged by the data file.
There is no escape for a line break in a header the way there is for a quote in a JSON body, so the row is refused rather than encoded around, naming the token and the row.
The rule covers a header name, a header value, and a credential written into a header line (a bearer token, an api key sent in a header); basic auth's pair and an api key sent in the query are base64- and percent-encoded before they reach the wire, so they bind unchanged.
JSON and JSONL rows keep native strings - there is no CSV grammar to have stripped the newline - so this is an ordinary cell, not an exotic one.

The cell is one of three origins the rule covers, and they share one definition of what a header may hold.
A `{{variable}}` substituted into a header, or into a credential written into a header line, is refused by `POST /compose` with `unsendable_header`, naming the variable; every other origin - a script, a credential typed with the byte in it, an import, a raw `POST /execute` payload
- is refused before the transfer starts, naming the header.
That last gate also covers a NUL (which truncates the line rather than forging one) and a multipart part's field name, filename and content type.

**Two headers that bind to one name** error the same way.
`X-{{data.h}}` resolving to `authorization` beside a literal `Authorization`, or two templated names resolving alike, would send that header twice where the request's rows name two different headers - so the row is refused instead, naming the header as it is written, the name it produced and the row.
Two headers *written* alike are not this: they are a repeat the author typed and can see, and every row sends both (issue #2466); this refusal exists only for the rows that produce one.

**A header name a row binds to nothing** errors the same way (issue #1095), and is reported ahead of a collision when a row does both - two names that bind to nothing collide on a name neither of them has, which is not what the file's author needs to be told.
`{{data.header_name}}: acme` whose cell is blank would otherwise send the line `": acme"`, under a name nobody wrote and with a value they did mean, once per iteration.
The message is the one every layer that can leave a header nameless shares, with the row in front of it; the column is inside the header as written, where that wording names it.
A name a bind merely *shortens* is not this rule - `X-{{data.h}}` with a blank cell binds to `X-`, which is a name a request can carry.

A cell that is present but **`null`** errors the same way, naming the token and the row.
It is the same failure one type down - the token says the value comes from the file and the file says there is none - and writing `""` for it would send `{"n": }` for a typed placement or a quietly blank field for a quoted one.
A column that is legitimately optional belongs in a script, through `pm.iterationData` (see [scripting.md](../scripting.md#data-rows-pmiterationdata)), where `null` is a value a branch can read.

A run sent **without a `data` set at all** whose plan still carries a `data.*` token is refused outright, before any run row exists: nothing would bind the token, so every iteration would send the literal text `{{data.id}}`.
The `400` names the step and the token, and - when the collection [declares a data contract](collections.md#collections) - the columns it declares, so the message says which file to run with rather than only that one is missing:

```
step 1 (request 'Fetch user', id 'req_a') carries {{data.id}}, but this run has
no 'scenario.data' set. ... (declared columns: id, email)
```

Starting such a collection as a quick smoke check means running it with a data file - a one-row set is enough - because the run this refuses would not have exercised the endpoint either.

**Each step execution writes one `results` row** carrying the design-mode trace plus `iteration`, `stepIndex`, `stepName`, `requestId` and `outcome`, and - for a run with `data` - `dataRowIndex`, the row that iteration bound.
The step whose error ended its iteration short of the plan's end also carries `stepsNotRun`, defined under Outcomes below; it is absent, never `0`, on every other row.
A step whose extractors found nothing carries `extractorMisses` (#3053), how many of them did, on the same absent-at-`0` terms (the rule is in [Elements](../elements.md#kinds)).
A step whose request still held a `{{name}}` when it went to the transfer carries `unresolvedTokens` (#3248), how many distinct names, on the same terms: the residual pass answers every name the step's scopes define, so a name counted here is one nothing defined, sent as written, never refused.
A step refused or skipped before the transfer carries none.
Bodies are capped by `maxTraceBodyBytes`; the row count is capped by `maxScenarioStoredSteps` ([the `scenario` block](load-runs.md#the-scenario-block-collection-runs)).

A step whose scripts said anything additionally carries a **`scripts` node** (issue #724) - the same object and the same keys [`POST /execute`](execute.md#post-execute) returns and a design send stores, so a step's assertions read the same inside a run as they do on a single send.
It is the only route those results take: a collection run answers `202` long before its scripts have run, so nothing about a step is ever returned live.
A step whose scripts said nothing stores no node at all.
The `results.error` summary line ("3 tests failed - <first name>") is unchanged and stays what the outcome is derived from; the node is the list that line summarises.

Every level's scripts run and every level's results land in that node (#2522): the collection's, each folder's from the outermost in, then the request's own, in that order, each `testResults` and `consoleLogs` entry carrying a `scope` of `collection`, `folder` or `request` (absent on a trace stored before the field, read as `request`).
A failing `pm.test` at any level fails the step, and a script that throws at any level errors it; when the level that threw is not the request's own, the step error names it - "Collection pre-request script failed - ...", "Folder test script failed - ..." - where the request's own throw keeps "Pre-request script failed - ..." / "Test script failed - ...".
When more than one level throws, the first one is reported.
A step's `pm.sendRequest` calls are recorded in that node's `scriptRequests` (#3633), every level's in run order, with the masking and the shared `maxTraceBodyBytes` budget `POST /execute` describes; a load run's steps record none.

A step of a collection **bound to an OpenAPI document** additionally carries a `validation` node (issue #681) - the same object and the same shape [`POST /execute`](execute.md#post-execute) returns - saying whether its response matched the schema that document declares.
Absent for an unbound collection and for a step that sent nothing.
By default the verdict is its own channel and changes no outcome; `failOnSchemaError: true` on the run makes a schema failure fail a step that passed everything else.
The run's rollup is [`schemaValidation`](runs.md#get-runsrunidreport) in the report.

**Outcomes** are `passed`, `failed`, `skipped`, `errored` and `stopped`:

| Outcome | Meaning | Effect on the iteration |
|---------|---------|-------------------------|
| `passed` | The request completed and every assertion held. | Continues. |
| `failed` | A `pm.test` assertion did not hold, at the collection, a folder or the request. | Continues - the request itself completed. |
| `errored`, step | The step did not run clean: the pre-request or test script threw, at any level (a thrown error, a script timeout, a refused `pm.request` write-back, a top-level `pm.response.to.have.status(...)` that did not hold), or the exchange did not complete (a transport failure, a request timeout, a request refused before the wire, a `{{data.*}}` token the row could not bind). | **Continues with the next plan position**, as Postman and Newman do by default. With `stopOnError: true` it ends the iteration instead. |
| `errored`, flow control | The runner refused the step's flow control: an unresolved or ambiguous `setNextRequest` (or `control.switch` / `control.loop`) target, or the `maxStepsPerIteration` cap. | **Ends the iteration**, whatever `stopOnError` says. The next iteration still runs. |
| `skipped` | A pre-request script called `pm.execution.skipRequest()`, so nothing was sent. The row carries the request and **no response**. | Continues with the next step. |
| `stopped` | A Stop (`POST /runs/:id/stop`) or an engine shutdown cut the step short (#3397): its transfer, the late OAuth 2.0 token request ahead of it, or one of its scripts' `pm.sendRequest` was cancelled, or one of its scripts was ended while it ran (#3460). The row carries the cancelled response (status `0`, `Request cancelled`). | **Ends the run.** No later step is sent or stored, and the step is no error: not in `errored`, `failed`, `stepsNotRun`, the status distribution, coverage or the assertion tally. |

Either kind of `errored` is the same outcome on the row, in the summary's `errored` count and on the `step` frame, with the error in `results.error`; the table's split is only about what the iteration does next.
An HTTP error status is not an outcome: a step that answered 4xx or 5xx with every assertion holding is `passed`, and the summary's `failedRequests` counts it.
The five outcomes are disjoint and sum to `stepsExecuted`, a skipped step included (`passed + failed + errored + skipped + stopped`; a summary stored before #3397 has no `stopped` and reads it as `0`).
A step that completed before the Stop landed keeps the outcome it earned.
A [scenario load run](scenario-load.md#scenario-load-runs) reports the other four under the same arithmetic and reads a step's flow control the same way: a no-response step and a thrown inline script are `errored` (#2947), a step that errored has its own jump (`control.switch`, `control.loop`) dropped, and a jump the run cannot honour is the `errored` of the step that set it (#2974).
A load run stores no step rows, so that error's text, the same sentence, is the `stepError` of a `run` warning in the [engine log](../logging.md).
What differs there is a step that got no response: on a load run it ends its iteration, so a load run's `errored` is not the sum of its steps' `noResponse`, and `iterationsAbandoned` is its iteration-abort count.
On a collection run a transport failure continues the iteration like a script error does, as Postman's and Newman's runners do by default; a later step that reads a response that never arrived errors on its own row.
A step that errored while the iteration continues has its own flow control ignored - a `setNextRequest`, `skipRequest` or `setNextRequest(null)` from a script that then threw is an instruction from code that did not finish, so the iteration walks to the next plan position (see [scripting.md](../scripting.md#flow-control-pmexecution)).

**The run's summary also carries the HTTP/2 fallback count** (#3262).
Every sent step's trace has `httpVersionDowngraded` (see [`POST /execute`](execute.md#post-execute)), and the runner adds those up into the stored summary's `http_version_downgraded`, the key a load run writes, so the report's `summary.httpVersionDowngraded` is the same figure in both run kinds.
It counts requests, not steps: a step the plan skipped sent nothing and is never in it, and a request that asked for `http2` and got `HTTP/1.1` is one for every iteration it ran in.
It is written as `0` for a run that counted and saw none, so only a summary stored before #3262 lacks the key.

**`stopOnError`** is a top-level boolean on `POST /runs`, default `false`, type-checked before the run row is created (`null` reads as the default, and a non-boolean is a `400` `invalid_run_config` naming the field).
Set, every `errored` step ends its iteration, a transport failure and a script error alike, which is Newman's `--bail` shape and what a collection run did before issue #2526.
It is a collection-run (design-mode) key: a [scenario load run](scenario-load.md#scenario-load-runs) does not read it.
It rides the stored snapshot as sent and is echoed in the report's `scenario` section, so two runs that differ only in it never read as the same run.

**`stepsNotRun`** counts the plan positions an error cost: when an `errored` step ends its iteration, the positions after it that the iteration had not already attempted.
It rides the step row (and the `step` frame) that ended the iteration when it is above zero, and the report's `scenario.stepsNotRun` sums it over the run.
An iteration that ends any other way adds nothing: `setNextRequest(null)` and a forward jump are a script's decision, not a loss, and a stop is the user's: a `stopped` step adds nothing under `stopOnError` either.
`iterationsCompleted` keeps its meaning - an iteration an error ended still completed.

A run whose steps failed still reaches `completed`: the outcome of the work is in the steps, and only the runner itself failing makes the run `failed`.
A stop ends the step in flight - its send, its late token request and its scripts' `pm.sendRequest` all carry the run's stop as their cancel, so it lands within about a second rather than after a request timeout - and is otherwise honoured **between steps**, so a `stopped` run does not finish the iteration it was in.
An engine shutdown stops an active run the same way.

**A step's scripts can redirect the sequence.**
`pm.execution.setNextRequest(name)` runs a named request next instead of the one that follows, `setNextRequest(null)` ends the iteration, and `pm.execution.skipRequest()` (pre-request scripts only) sends nothing and marks the step `skipped`.
A target that names no step in the run, or one that two steps share, fails the step by name rather than guessing, and [`maxStepsPerIteration`](load-runs.md#the-scenario-block-collection-runs) is what stops a cycle.
Both refusals end the iteration whatever `stopOnError` says, and a step whose script errored has its redirect ignored.
The full contract, including everywhere the two methods throw, is in [scripting.md](../scripting.md#flow-control-pmexecution).

**The stored snapshot carries a step manifest, never the composed plan.**
`runs.config_snapshot` holds the block as validated - with `data` replaced by its row count - plus `{index, requestId, name, method, url}` per step, where `url` is the **stored, uncomposed** one.
The composed plan carries resolved `Authorization` headers and, for an `apikey` auth with `in: "query"`, a live key in the URL; it lives in memory for the run's life and nowhere else.

**Controller elements redirect the sequence too (issue #1515).**
`control.if`, `control.once` and `control.throughput` skip a step the same way `pm.execution.skipRequest()` does; `control.switch` jumps to a named member the same way `setNextRequest(name)` does - one flow-control channel, not two, so the rules above (an unresolved target fails the step by name, a cycle trips `maxStepsPerIteration`) apply identically.
`control.loop`, on a folder, walks its members a fixed number of times per iteration by looping back to the folder's first member.
See [elements.md](../elements.md#controllers) for the kind table and every config shape.

**`control.transaction` reports its own percentiles.**
A folder carrying one sums every member's own response latency, at microsecond precision, into a named total per pass, and the run's summary gains `scenario.transactions[] = { name, count, errors, latency: { min, p50, p90, p95, p99, max } }`, omitted for a transaction the run never closed.
A pass closes when the iteration leaves the folder (#3054): after the folder's last member whether it was sent, skipped by a controller or failed before an answer, or after any member from which the iteration jumps out of the folder or ends.
So `count` is one per iteration that attempted a member, and a pass whose every member was skipped, or that a Stop interrupted, is not counted.
`errors` counts the passes in which a member was an error by the report's own definition: no response, a status outside 2xx/3xx, or a failed assertion.
`includeTimers: true` (issue #1569) also folds a between-member `timer.*` wait into that sum - excluded by default, and always excluded for a wait after the folder's own last member, which is outside the transaction's span.
[elements.md](../elements.md#controllers) has the full close rule.
The same shape reports on a scenario load run's summary, top-level rather than under `scenario` - see `transactions` under [Scenario load runs](scenario-load.md#scenario-load-runs).
