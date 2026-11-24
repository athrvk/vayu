---
description: >-
  `pm.sendRequest`: sending a request from a script, its options, its result and its limits.
---

# Sending a request from a script (`pm.sendRequest`)

The one part of the sandbox that touches the network.
Its reason for existing is the token fetch: a pre-request script that needs a credential the request itself cannot supply.
`fetch` and `XMLHttpRequest` are absent; their hover points here.

```javascript
pm.sendRequest(
  {
    url: "https://auth.example.com/token",
    method: "POST",
    header: { "Content-Type": "application/json" },
    body: { mode: "raw", raw: JSON.stringify({ client_id: "abc" }) },
  },
  function (err, res) {
    if (err) {
      console.error("token fetch failed: " + err.message);
      return;
    }
    pm.environment.set("token", res.json().access_token);
  }
);
```

The first argument is a URL string or an options object; the second, when given, must be a function.

| Option | Shape |
| ------ | ----- |
| `url` | string, required, or `pm.request.url` - the Url object, so `pm.sendRequest(pm.request.url, cb)` reads as "send this again". A hand-built `{ host, path }` object is still not accepted |
| `method` | string, default `GET`; case-insensitive, an unknown verb throws |
| `header` / `headers` | `{ name: value }` or Postman's `[{ key, value }]`. Both names read; sending both at once throws |
| `body` | a string, or `{ mode, <mode>: ... }` for `raw` (`raw` string, sent as `text/plain`), `urlencoded` (`urlencoded` rows, sent as `application/x-www-form-urlencoded`) or `formdata` (`formdata` rows, sent as `multipart/form-data`). Rows are Postman's `[{ key, value, disabled? }]` or a `{ name: value }` object; a `disabled` row is skipped, and a `formdata` row may carry a `contentType`. A `type: 'file'` row and the `file` and `graphql` modes throw. A `header` naming a Content-Type wins over the one the mode implies, except for `formdata`, whose type carries the boundary |
| `auth` | Postman's `{ type, <type>: params }`. `basic`, `bearer`, `apikey`, `noauth`; any other type throws |
| `timeout` | milliseconds. Absent, the call takes the resolved timeout of the send or run the script belongs to - the request's or run's `timeout`, else the `defaultTimeout` setting; a sequential collection run's step scripts take their step's, which is the stored request's own `timeout` when it states one (#2937), and every other script of a run the run's - in every script that may send: a Send's scripts (buffered or streamed), a collection run's step, `script.setup` and `script.teardown` scripts, and every script of a load run, its inline step scripts, `script.setup` / `script.teardown` and the deferred `tests` script (issues #2833, #2841). Either is clamped to the script's remaining budget (below) |

**Synchronous, in both forms.**
The send blocks and the callback runs inline, before `pm.sendRequest` returns.
Called without a callback, it returns a promise instead (#2577), already settled when it comes back: resolved with `res`, or rejected with the `err` the callback would have been given, so the code after an `await` runs with the answer.

```javascript
const res = await pm.sendRequest("https://auth.example.com/token");
pm.environment.set("token", res.json().access_token);
```

**Which failures throw and which reach the callback.**
Transport failures are the network's answer, so they arrive as the callback's `err` - an `Error` with a `.code` (`CONNECTION_FAILED`, `DNS_ERROR`, `TIMEOUT`, `TOO_MANY_REDIRECTS`, …) and `res` null - or, without a callback, as the promise's rejection with that `Error`.
The script's own mistakes throw out of the call instead, in both forms: an unusable argument, an unsupported body mode, exceeding the request cap, and the capability being off.
A response over the byte bound below is the network's answer too, not a mistake: it arrives as `err` with `.code` `RESPONSE_TOO_LARGE`.
So does a URL whose scheme is not `http` or `https` once its variables resolve (`file:///...`, `ftp://...`): `err.code` is `INVALID_URL`, the message names the scheme, and nothing is read - the same refusal a Send of that URL gets ([URL schemes](../api-reference/compose.md#url-schemes)).

**Vayu's own ports are never a target.**
A URL naming the engine's own port or the MCP port (9877, or the daemon's `--mcp-port`) on this machine - `127.0.0.1`, any other `127.x.y.z`, `localhost`, `[::1]` - throws `pm.sendRequest refused: Vayu does not send requests to its own engine port ...`, before anything is dialled, because the engine's API would take the script's request for the app's.
A redirect that leads there, or a host name that resolves there, is refused by the transport instead and reaches the callback as `err` with `.code` `INVALID_URL` and the same sentence.
Every other local server is reachable as before.
See [Reserved local ports](../api-reference/compose.md#reserved-local-ports).

`res` carries `code`, `status` (the reason phrase, as on `pm.response`), `responseTime`, `headers` with `get()`/`has()`/`each()`/`all()`/`count()`/ `toObject()`/`one()`/`indexOf()` - the same read methods documented under [Reading response headers](response-headers-and-assertions.md#reading-response-headers) - `json()` and `text()`.
It is a subset of `pm.response` and has no `to.*` assertion chain.

**Every request leaves one line in the Console** (#3462), so what a script sent is listed even when nothing logs it - a token fetch that failed and a callback that returns on `err` would otherwise leave no trace.
It is an `info` line, written when the transfer ends and before the callback runs, naming the method, the URL, the status or the error code, and how long the transfer took:

```text
pm.sendRequest POST https://auth.example.com/token -> 200 (143 ms)
pm.sendRequest GET https://auth.example.com/token failed: CONNECTION_FAILED (3 ms)
```

A 4xx or 5xx answer is a status, not a failure; `failed:` is the `err.code` the callback receives.
The URL is the one the script gave, after its variables resolve, with its credentials masked the way an export finds them:
the password of `user:pass@` and the value of a query parameter named like a credential (`token`, `api_key`, `client_secret`, ...) read `<redacted>` (`user:<redacted>@host`, `?api_key=<redacted>&page=2`), the rest of the query stays, and a key that `auth` appends is never shown.
Only a request that was sent has a line: a call refused before it goes out (the cap, a bad option, the capability being off) throws and writes none.
The line counts against the [console caps](console-and-examples.md#console-output) like any other, and with `scriptEnableConsole` off it is not written;
the record below still is, and so is a line in the engine's [log file](../logging.md) (#3677), which the Logs tab shows: `cat: "script"`, `warn` when the call failed (method, URL with its credentials and query stripped, `errorCode`, the transport's message, `ms`) and `debug` when it did not, so a failed token fetch is found at the default `info` level with `cat:script`.
A call cancelled with the enclosing exchange is `debug`; the record carries no `runId`, which the script context does not hold.

**The exchange itself is recorded beside the line** (#3633).
On a Send and in a sequential collection run, its setup and teardown scripts included, every request a script sent leaves a record of what went out and what came back:
the method, the URL the transfer dialled (after `auth` and the Postman encoding), the request headers and body, the response status, headers and body, the redirect hops, the timing phases and, for a transfer that failed, the error code at status `0`.
The records ride the send's `scriptRequests`, in call order, on the live answer and on the stored trace alike, so History shows them later; a setup or teardown script's ride its `lifecycle` row.
The summary line names its record by index (`scriptRequest`), so the Console draws the two as one expandable row; a record whose line the console cap dropped, or that ran with the console off, has no line.
The record is masked where it is built, by the rules an export uses plus what `auth` wrote: a credential header's value (`Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, the header an `apikey` auth named, ...) reads `<redacted>` in every header list, request and response and each hop, and a URL's `user:pass@` password and credential query values are blanked to empty as on the line.
Bodies are kept as sent and received, and all of one send's records share one `maxTraceBodyBytes` for their bodies: a body past what is left is cut and says so (`bodyTruncated`, `bodyBytes`).
The script itself still receives the whole response.
A load run records nothing and keeps only the line.
The shape is [`scriptRequests` in the API reference](../api-reference/execute.md#post-execute).

**Three bounds, all hard.**

- *The script's deadline.*
  The wall-clock limit is enforced by a QuickJS interrupt handler, and QuickJS only calls it **between bytecode operations** - a blocking C function never yields to it.
  So the request's timeout - the `timeout` option, else the enclosing send's own resolved timeout (its `timeout`, else `defaultTimeout`) - is clamped to whatever is left of the script's budget; without that, a 5s script calling `pm.sendRequest` under a 30s request timeout would hold its thread for 30s with no error and no way to interrupt it.
  A call made with the budget already spent is refused by name - `pm.sendRequest was called with none of the script's time budget left` - and that sentence is what the script's error reports, since the handler never ran and so never stopped anything.
- *A request cap.*
  One script execution may issue at most **10** requests, then throws.
  A load run's `tests` script runs once per *sampled* response, serially, on the run's worker thread, so an uncapped loop would turn post-run validation into minutes of apparent hang.
- *A response byte bound.*
  The fetch reads at most what the enclosing execution reads, and **refuses** past it - the callback's `err` says `Response is N bytes, over the M byte limit`, and `res` is null.
  Which setting supplies `M` follows the path: a design-mode send's scripts (Send, and a collection run's step, setup and teardown scripts) take `maxDesignResponseBodyBytes`;
  every script of a load run (an inline step script, `script.setup` / `script.teardown`, the deferred `tests` script) takes `maxResponseBodyBytes`, because a script that runs once per submission or per sampled response belongs to the run's memory budget rather than to the one sized for a body a person is about to look at.
  Refusing rather than handing over a prefix is the deliberate half: `res` has no truncation flag - nor does `pm.response` - so a cut body would reach `JSON.parse` as corrupt input with nothing to say why.
  Before issue #1188 this fetch was the one read in the engine with no bound at all.

**A Stop ends it.**
In a load run, and in every script of a collection run (`script.setup`, `script.teardown` and each step's own, #3397), the run's Stop (or the engine shutting down) cancels a fetch in flight within about a second, and every fetch after it at once, so a hung host never holds a Stop open for the request timeout (#3371).
The callback's `err` says `Request cancelled`.
That is the run ending, not the script failing: a `script.setup` / `script.teardown` or a step script whose fetch was cancelled is recorded `skipped`, with the step script's tests and throw left out of the step's result and the run's counts, and a replayed `tests` script whose fetch was cancelled is left out of the run's pass and fail counts.
On a collection run the step itself is then `stopped`, since its own send is cancelled too.

**A Stop ends the script itself, too** (#3460).
The same Stop or shutdown stops a run's script that is still running, fetch or no fetch, at QuickJS's next interrupt poll, so a script stuck in a loop never holds a Stop open for its `scriptTimeout`.
Every script of every run kind honours it: `script.setup`, an inline step script under load, the deferred replay (see [Load Test Scripts](execution-context.md#load-test-scripts)) and a sequential run's step scripts.
A script it ended is recorded exactly as a cancelled fetch's is, `skipped` with the message `the run was stopped while this script was running`, never an error.
`script.teardown` is the one exception: teardown runs at the end of every run that set up, a stopped one included, so a Stop latched before teardown began leaves it to run (its fetches still cancelled at once), and only the engine shutting down ends it then; a Stop or shutdown that arrives while it runs ends it.
A `POST /execute`'s scripts are not ended by a hang-up or a shutdown: its post-request script runs after a stream's own Stop.

**It leaves the way its execution leaves.**
The fetch takes the transport policy its enclosing execution resolved - the proxy mode and URL, the bypass list, the custom CA bundle and the client-certificate registry - rather than whatever the daemon's own environment would pick up.
A script that authenticates through `pm.sendRequest` and then lets the real request carry the session has to take the same route out of the machine, or one of the two is unreachable behind a corporate proxy (issue #705).
Which policy that is follows the path, as the byte bound above does:
a design-mode send's scripts take the one resolved for that send (a collection run's, for every script of that run), and every script of a load run takes the one the run's own transfers left by -
resolved once when the run starts and kept for it, so a Settings edit made while the run was in flight cannot send an assertion by a route the responses it is asserting on never took (issues #1256, #2841).
The [default headers](../api-reference/health-config.md#default-request-headers) the engine adds follow the same rule: a load run's scripts send the load scope's set its transfers carried, a design-mode send's scripts the design scope's.

**Not available to agents.**
Vayu's MCP target allowlist is checked in the MCP server, against the composed URL, before it calls the engine - so a script-issued request never passes that gate.
The engine therefore refuses script-issued requests unless the caller explicitly asks for them (`allowScriptRequests` on `POST /execute` / `POST /runs`); Vayu's own Send and load runs ask, and the MCP server never does.
Calling it from an agent-started run throws a message saying so.
See [MCP](../mcp/resources-and-prompts.md#the-script-sandbox-surface).

The flag is a property of **who asked for the execution**, not of the shape its answer comes back in: `POST /execute` reads it before it branches on `stream`, so a streaming send's pre- and post-request scripts are governed by exactly the bit a buffered send's are (issue #653).
Pressing Send with the **Event stream** setting on and off gives `pm.sendRequest` the same answer.

**`{{variables}}` resolve as the call is made** (#1001).
The URL, each header name and value, a raw body, a form body's field names and values and each credential of an `auth` block are resolved once, against the local scope, the bound data row and the three named scopes exactly as `pm.variables.replaceIn` reads them -
so a value this same script set two lines earlier is visible, which is Postman's rule and what makes an imported token-refresh script work.
It is not a second pass over the request being sent: that request's own names resolve after the pre-request script ends (#2521), and nothing here revisits them.
A name nothing defines keeps its braces (#1009), and a `{{data.column}}` the bound row lacks throws naming the column, the same way `replaceIn` does.

**The URL goes out encoded as Postman sends it.**
Once its variables resolve, the URL is percent-encoded component by component as `postman-url-encoder`'s `toNodeUrl` writes it (`core::encode_url_as_postman`): the path, query, fragment and user info each by its own Postman set (listed under [Query encoding](../api-reference/compose.md#query-encoding)), a backslash before the query as `/`, the host lowercased.
So `pm.sendRequest("https://x/a b?q=c d&r=\"x\"", cb)` sends `/a%20b?q=c%20d&r=%22x%22`, where before the space made libcurl refuse the URL.
`&` and `=` in the query stay separators, and `%` is never encoded, so an escape already written (or a URL composition already encoded, such as `pm.request.url`) is sent unchanged.
There is no way to turn this off: Postman builds the call with a `protocolProfileBehavior` of its own, so neither the enclosing request's `disableUrlEncoding` nor anything in the options reaches it.
A `{{name}}` nothing answered goes out as written, where Postman would encode its braces in the path.
A non-ASCII host is dialled by its punycode name (`bücher.example` as `xn--bcher-kva.example`), as it is on every send path; see [Non-ASCII hosts](../api-reference/compose.md#non-ascii-hosts).

Send writes the same request line for every URL with its Send URL without encoding toggle off (#2465): the encoder is the same one.

Header **names** resolve too (#1067), under the collision rule composition owns rather than a second one written here (#1051, `http/header_names.hpp`): two names written differently that resolve to one name would send that header twice where the script wrote two different ones, so the call throws naming both spellings (never the name they produced, which can be a secret), and nothing goes out.
Names are compared without case.
A name that resolves to nothing at all is refused the same way, and it is the one thing resolution can produce that nothing further down the send would catch: the pre-send gate reads header text for the bytes that break a line, and what is left of an empty name is the line `: value`, which libcurl sends.
This call met that rule first, a script writing header names of its own; since #1084 composition and the execute-time residual pass refuse it in the same words, so one wording answers wherever a name is resolved.
A resolved name is also trimmed of the spaces and tabs around it and must then be an RFC 9110 token: ` X-Trace` goes out as `X-Trace`, and `X Trace` throws with the same wording as the `invalid_header_name` refusal (#2467).

```javascript
pm.environment.set("tenant", "acme");
pm.sendRequest(
  {
    url: "{{baseUrl}}/{{tenant}}/token",
    method: "POST",
    auth: { type: "basic", basic: { username: "{{id}}", password: "{{secret}}" } },
  },
  function (err, res) {
    if (err) {
      return;
    }
    pm.environment.set("token", res.json().access_token);
  }
);
```

**`auth` is composed, or refused by name.**
The block takes Postman's `{ type, <type>: params }` shape, with the parameters in either spelling Postman writes - the exported `[{ key, value }]` array, or a plain object.
`basic`, `bearer` and `apikey` (`in: 'header'` by default, `'query'` for a parameter) go through `vayu::http::apply_auth`, the engine's one auth composer, so the header or the percent-encoded query parameter is the one every other send would have written, and an `Authorization` header the script set itself still wins.
Every other type throws naming it - `oauth2` included, because acquiring its token needs the database this path deliberately does not carry.
So does a type whose block is not there (`{ type: 'basic' }` with no `basic` beside it, or the key misspelled), a parameter the type does not take, and a block with no credential in it.
Each type takes the names Postman's own auth helper reads: `basic` `username` and `password` (either may be empty, not both), `bearer` `token` (not empty), `apikey` `key` (required), `value` and `in`.
A token or key naming a variable that resolves empty is not refused: it writes nothing, as the request's own auth would, and on `pm.request.auth` the send's `authNotice` says so (#3203).
The refusal names the parameter and lists those, so `basic: { user, pass }` fails saying so rather than composing `Basic Og==`.
What Postman's export writes beside the credential still reads: an entry's own `type` member, and the basic helper's `showPassword`, which sends nothing.
Dropping the option would send an unauthenticated request that looks like the script's own mistake, which is the reason the body modes it cannot send whole (`file`, `graphql`, a file part) are refused too.
