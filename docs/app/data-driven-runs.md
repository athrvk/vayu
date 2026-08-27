---
description: >-
  Drive a Vayu run from a CSV, TSV, JSON or JSONL file - a row per iteration, exposed as {{data.column}} and pm.iterationData, for a collection run or a single request's load test.
---

# Data-Driven Runs

A run can be driven by a file: a row per iteration, its columns readable from
the requests themselves and from scripts.

Two runs take one:

- **A collection run.** Pick the file in the **Run collection** dialog, beside
  Iterations and Load test - or declare it once on the collection's **Data** tab
  and have the dialog pre-fill it.
- **A single request's load test** (issue #993). Pick the file in the **Run a
  load test** dialog, under the profile fields. The request needs no collection
  wrapper: `N` users each sending the same request with different data is the
  canonical load shape, and until this it was expressible only by wrapping the
  request in a one-step collection.

What differs between them is only *which* row a given request binds - see
[How many iterations, and which row](#how-many-iterations-and-which-row). The
file, the refusals, the `{{data.column}}` namespace and `pm.iterationData` are
the same on both.

This page is the file's contract - what Vayu accepts, what it refuses, and what
a value becomes once it is bound.

## Supported files

| Extension           | Format                           | Values arrive as |
| ------------------- | -------------------------------- | ---------------- |
| `.csv`              | Comma-separated, RFC 4180        | strings, always  |
| `.tsv`, `.tab`      | Tab-separated, same grammar      | strings, always  |
| `.json`             | An array of row objects          | their JSON types |
| `.jsonl`, `.ndjson` | JSON Lines - one object per line | their JSON types |

There is no XLSX support and no headerless mode. A spreadsheet exports to CSV in
one step, and a file whose first row is data would leave every column
unaddressable - see below.

## The header row _is_ the mapping

Column names become `{{data.column}}` tokens and `pm.iterationData` keys with no
remapping step, exactly as Postman, JMeter and k6 work. A mapping UI would be a
second source of truth for something the file already states.

That makes the header row's rules strict, and each refusal names the offending
cell:

- **An empty header cell** is refused - there is no name to address the column
  by.
- **A duplicated header cell** is refused - `{{data.user}}` could mean either
  one.
- **A row with more or fewer values than the header names** is refused, naming
  the row and both counts. A short row would leave a token unbound and a long
  one would drop cells nobody can see.

JSON and JSONL have no header, so the columns are the union of every row's keys,
in first-seen order. A key that only _some_ rows carry is a **warning** at pick
time naming how many rows lack it - the iterations bound to those rows would
fail on a `{{data.*}}` token naming it, but a column nothing references is
harmless, so it does not block the run.

## Values: strings from CSV, native types from JSON

A CSV or TSV cell is always a string. `007` stays `007` and a 20-digit id
survives, which is JMeter and k6 behaviour and the reason the preview says so.
JSON and JSONL keep what the file declared - `3` is a number, `true` is a
boolean, `null` is null.

If you need a number to arrive as a number, use a JSON file - and write the
token _outside_ the quotes in the body, `{"n": {{data.n}}}`, because that is
what decides whether it arrives as `2` or `"2"`.

A `null` cell is a value `pm.iterationData` hands to a script and a value a
`{{data.column}}` token **refuses** - see below.

## Quoting (CSV and TSV)

The parser is RFC 4180, not a `split(",")`:

- A quoted field may contain the delimiter, newlines, and CRLF.
- A literal quote inside a quoted field is written doubled: `"say ""hi"""`.
- A quote that does not _open_ a field is an ordinary character, so `6" pipe`
  needs no escaping.
- Blank lines are skipped, and the count is reported as a warning.

A file that **ends while a quoted value is still open** is refused, naming the
line the quote opened on. Reading it any other way would fold every remaining
line into one cell, silently.

## Encoding

Files must be **UTF-8**. A UTF-8 byte-order mark is stripped rather than
becoming part of the first column's name.

**UTF-16 with a byte-order mark** is also read - that is what Excel's "Unicode
Text" export writes. Anything else is refused: a Windows-1252 file (Excel's
plain "CSV" on Windows) would otherwise arrive with question marks where the
accented characters were, and it would parse cleanly, so nothing later could
catch it. Re-save as UTF-8 and pick it again.

## Size limits

Two engine settings bound a run's data set, and the app enforces both _before_
the run rather than letting `POST /runs` refuse it afterwards:

| Setting                | Default | Bounds                          |
| ---------------------- | ------- | ------------------------------- |
| `maxScenarioDataRows`  | 1000    | How many rows one run may carry |
| `maxScenarioDataBytes` | 16 MiB  | How large the data set may be   |

Both are editable in **Settings -> Engine -> General**, and the app reads the
live values - raise a limit there and the same file is accepted without
restarting anything. The row limit alone does not bound the payload, since one
row is free to hold a megabyte in a single cell, which is why there are two.

The caps apply to a file **re-read from a remembered path** exactly as they do
to one picked by hand, and both refusals name the setting. That matters because
neither side of the comparison holds still: a declared file grows rows after it
was declared, and the setting itself can be lowered under a file that has not
changed at all. So the Run dialog's pre-fill, Send-with-row and the Data tab
each refuse a file over the cap instead of previewing it - the byte cap when the
file is opened (the app's main process stats it before reading), the row cap
once it is parsed, since counting rows means parsing and the engine never opens
a file.

The engine never opens a file. The app parses it and sends the rows inline on
the run payload, because the script sandbox has no filesystem access by design
and handing the daemon a user-supplied path would be a new trust boundary. The
row set itself is never stored on either side - a run's snapshot records its
count alone - but a cell bound into a request travels with that request, and a
run stores the requests it sent. See [What is stored](#what-is-stored).

## Reading a row: `{{data.column}}` vs `pm.iterationData`

Both read the same row. They differ in _when_:

- **`{{data.column}}`** is substituted into the request - URL, headers, body,
  form fields - immediately before the send. Use it to make each iteration hit a
  different endpoint or send a different payload. See the
  [`{{data.column}}` contract](../engine/api-reference.md#post-runs) in the
  engine's HTTP API reference.
- **`pm.iterationData`** is read by scripts, _after_ the step's request was
  composed, so it cannot change where the request goes. Use it for assertions
  and for values a script derives. See
  [Data rows](../engine/scripting.md#data-rows-pmiterationdata).

`data.*` is a **reserved namespace, not a variable tier**: `{{data.id}}` and
`{{id}}` are different names, so a data file can neither shadow nor be shadowed
by a global, collection or environment variable. See
[Variable Resolution](variable-resolution.md#data-is-reserved-and-sits-outside-this-order).

A `{{data.column}}` naming a column the bound row does not carry **fails the
step before anything is sent**. Substituting an empty string would send a
request quietly pointing somewhere else, which is the failure this namespace
exists to remove. A cell that is present but **`null`** fails the same way, for
the same reason - the token says the value came from the file. A column that is
legitimately empty for some rows belongs in a script, where `pm.iterationData`
hands `null` to a branch that can read it.

A cell carrying quotes, backslashes or newlines is **safe in a JSON body**: a
token inside a string literal is escaped as it binds, so `say "hi"` arrives as
that text inside valid JSON rather than ending the string. A token written
_outside_ a string literal - `{"n": {{data.n}}}` - is not escaped, which is how
a JSON file's number arrives as a number.

A cell is **safe in an XML body** too, and by a rule that reads the token's
position rather than one that escapes everything:

| Where the token sits                             | What the cell arrives as                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Element text                                     | `&`, `<` and `>` escaped - `Ben & Jerry's` arrives intact                                                                 |
| An attribute value                               | the above, plus whichever quote delimits _that_ attribute                                                                 |
| A `<![CDATA[…]]>` section                        | byte for byte, which is what the section is for; a `]]>` in the cell splits and reopens the section rather than ending it |
| A tag or attribute **name** - `<{{data.tag}}>`   | byte for byte: no escape is legal in a name                                                                               |
| An XML **comment** or **processing instruction** | nothing - the row is **refused**, naming the token                                                                        |

The comment and processing-instruction refusals are deliberate: neither is
content the server reads, and a cell carrying `-->` or `?>` would end the
construct and change the document into one you did not write. Move the token
into the element or attribute it belongs to.

Nothing else is escaped: a URL, a header, a form field and a plain-text body
take the cell byte for byte - including a `text` body that happens to hold XML,
because the mode you picked is what decides the rule.

A **header** is the one of those with a limit. A header line ends at a line
break, so a cell holding `ok` followed by a newline and `X-Admin: true` would
not put that text in the header - it would end the header and send the rest as a
header of its own, which is a request your file never described. There is no
escape for a line break in a header, so the row is **refused**, naming the token
and the row. It applies to a header name, a header value, and a credential that
goes into a header line - a bearer token, or an api key sent in a header. Basic
auth's username and password are base64-encoded and an api key sent in the query
is percent-encoded, so a line break in either is harmless and binds as written.
A JSON or JSONL file is where this turns up: those keep the cell as the string
it is, while the CSV grammar has no way to carry a raw newline into one.

The limit is the header's, not the data file's, so it holds for whatever put the
bytes there: an environment variable substituted into a header is refused when
the request is composed, naming the variable
([variable resolution](./variable-resolution.md)), and anything else - a script,
an import, a request sent by another client - is refused just before it would go
on the wire, naming the header.

## How many iterations, and which row

**One iteration per row** by default: leave Iterations empty and the row count
is the run's length.

Give an explicit Iterations count and it wins - row `i % rows` binds to
iteration `i`, so a count above the row count wraps back to the top, and a count
below it leaves the remaining rows unused. The picker states which of those is
about to happen, because a 500-row file running once is the surprise this
preview exists to remove.

**A load run** binds rows differently: every virtual user claims rows from one
shared cursor, so no two start on the same row while unclaimed rows remain, and
the rows then repeat for as long as the duration lasts. Once they wrap, users do
share rows - size the file to the concurrency if that matters. The row count
says nothing about how long the run is.

**A single request's load test** is that same cursor with one request where a
collection run has a sequence: one row is claimed per request sent, in turn,
wrapping when the set runs out. So a 3-row file under a 6-request run sends rows
0, 1, 2, 0, 1, 2 - the file bounds *which values* the run sends and never how
many requests it sends, which is the load profile's job. Iterations is not
defaulted from the row count here, unlike a collection run: a load profile
already says how long the run is.

## Declaring the contract: the Data tab

A file picked in the Run dialog is parsed, sent and forgotten, so at the moment
you write `{{data.email}}` in a URL nothing in Vayu knows that column exists.
The collection's **Data** tab is where you say so: pick the file, check the
preview, and press **Declare columns**.

What that stores, and what it does not:

|                     | Where it lives                          | Travels with the collection? |
| ------------------- | --------------------------------------- | ---------------------------- |
| The **columns**     | On the collection, as `dataSchema`      | Yes - and through import     |
| The file's **path** | This machine only, in local app storage | No                           |
| The file's **rows** | Nowhere                                 | No                           |

Declaring changes no binding rule - a token still binds from the row the run
carries. What it buys is everything that needs to know the columns _before_ a
run:

- **The Run dialog pre-fills.** If the declared file is still where you left it,
  opening **Run collection** re-reads it and previews it, ready to start. Move
  or rename the file and the dialog says so and offers the picker - it is a
  note, not a refusal. Which file that is follows the chain rule like everything
  else here: running a sub-collection that declares nothing offers the file its
  nearest declaring ancestor was given, because that is the contract the run
  binds against.
- **The Data tab re-opens it too.** Coming back to the tab reads the declared
  file again and lines it up against the contract with no re-pick: comparing
  them is what the tab is for, so it does not wait to be handed the same file a
  second time. Edit the file on disk and the drift shows on the next visit. A
  file that has moved has its name struck through beside the declared columns,
  and the picker stands - which is also how you compare a _different_ file.
- **A file that does not match is flagged**, in both directions and in both
  places: a declared column the file is missing (every `{{data.x}}` written
  against it would fail to bind at iteration 1) and a column the file carries
  that the contract does not declare (usually the sign of a contract that has
  drifted, or of the wrong file). Both are warnings; the run is still yours to
  start.
- **The engine's refusal names the columns.** Starting a run whose requests
  carry `{{data.*}}` with no file is already refused before anything is sent;
  with a contract declared, that message lists the columns the collection
  expects, so it says which file to run with rather than only that one is
  missing.

- **The builder checks your tokens.** With a contract in scope, a
  `{{data.email}}` that names a declared column reads as one, and a
  `{{data.emial}}` that names nothing declared is painted amber with the
  declared list in its tooltip - so a typo shows while you are typing it rather
  than at iteration 1. It is advice, not a refusal: an undeclared column still
  binds if the file you run with carries it.
- **The columns are offered while you type.** `{{data.` completes them in the
  URL, params, headers and body, and `pm.iterationData.get("` completes them in
  the script editors.
- **You can send one request against one row.** A caret appears beside **Send**
  in the request builder whenever a contract and a declared file are both in
  scope; it lists the file's first rows, and picking one sends _that_ request
  bound to _that_ row - the tokens substituted, and `pm.iterationData` readable
  in both scripts. This is how you iterate on a script that reads a row without
  starting a whole run each time. See [Send with a row](#send-with-a-row).
- **The Data tab audits the collection.** A **Referenced columns** panel splits
  the declared columns into the ones your requests use, the ones your requests
  name but the contract does not declare, and the ones nothing references -
  across this collection and every sub-collection that does not declare a
  contract of its own. What counts as a use is what a run actually binds: the
  URL, params, headers and body, and the **credentials** a step sends - a
  bearer token, a basic username and password, an api key's name and value -
  including the ones a request inherits from a collection. An OAuth 2.0 config
  is not among them: its token is fetched once when the run's plan is resolved,
  before any row exists, so a `{{data.*}}` there binds nothing. Scripts are
  scanned for literal `pm.iterationData.get("column")` arguments only - the
  request's own and the collection chain's, which run around every step - and
  the panel says so: a column name a script computes at run time cannot be seen
  from here.

A sub-collection with no contract of its own uses the nearest ancestor's, the
same way a variable defined on a parent collection is in scope below it.

**Re-declare from this file** replaces the columns when your file changes shape;
**Clear** removes the contract and forgets the remembered path.

Vayu only ever re-opens a file whose extension is one of the formats above, and
only up to the same `maxScenarioDataBytes` a run may carry - the remembered path
is not a general licence to read your disk. A re-opened file over
`maxScenarioDataRows` is refused too, once it has been parsed, so a file that
outgrew the cap says so here rather than at the next run.

## Send with a row

Everything above is about a _run_. One thing is worth doing without one: a
pre-request script that reads `pm.iterationData`, or a URL carrying
`{{data.id}}`, used to be testable only by starting a collection run and digging
the step out of the result - a run per line of script.

With a contract declared and its file still in place, the request builder grows
a **caret beside Send**. It lists the first 20 rows of the file, and takes any
row in it by number; pick one and the request is sent bound to it:

- every `{{data.column}}` in the URL, headers and body is substituted from that
  row, exactly as a run's iteration would substitute it;
- both scripts read the row as `pm.iterationData`, with `pm.info.iteration` `0`
  and `pm.info.iterationCount` `1` - the send _is_ row 0 of 1;
- the response lands in the response pane like any other Send, and the send
  appears in History like any other design run.

The caret is **absent**, not greyed out, when there is nothing to bind - no
contract in the collection chain, or no remembered file for the collection that
declared it. A file that has moved says so when you open the list, and picking
it again in the Data tab is the fix. So does a file over `maxScenarioDataRows`:
a single send binds one row, but the file is the collection's data set, and one
no run can use is not a set to pick a row out of.

**Auth credentials bind on a single send too.** A `{{data.user}}` in a
basic-auth username, a bearer token or an api key takes the row's value the same
way the URL and the body do, and it does so _before_ the credentials are encoded

- so the header carries the row's values rather than base64 of the token text.
  This is the same thing a collection run does per iteration, which is what makes
  a credentials file work identically under Send-with-row and under Run
  collection.

The exception is **OAuth 2.0**: its token is fetched from the token endpoint
rather than written into the request, so no row can reach it, under either
Send-with-row or a collection run. A `{{data.*}}` in an OAuth 2.0 config is
refused by name rather than sent wrong - use a static credential there, or move
the token into the request itself.

**Any row, by number.** The list is 20 rows because a popover is not the file,
and the row a long run failed on - "iteration 501 · row 501" - is never among
them. So the **Row number** field above the list takes any index the file has:
typing one shows that row and selects it, and Enter sends with it. A number the
file has no row for is refused by name ("the file has 500 rows") rather than
clamped to the last one, because binding a row you did not ask for is worse than
binding none.

**From a failed step.** A collection run's step card carries **Repro row N**,
which opens the request that step ran with that row already selected and this
list open on it (issue #730) - so reproducing a failure is the step's own action
and one click on the row, rather than finding the request in the tree by name
and then discovering its row is out of the list's reach.

The rows read for the picker are held for that send and nothing more. The send
itself is stored like any other design send, bound values included - see
[What is stored](#what-is-stored).

## What is stored

**The row set is not.** The rows ride the run payload and are dropped when the
dialog closes - both dialogs, and both shapes of run. They are user data of unknown sensitivity - credentials,
customer records - so neither the app nor the engine keeps the set, and the file
itself is read fresh every time - whether you pick it or the dialog pre-fills it
from the declared path. Declaring a contract does not change this: what is saved
with the collection is the _shape_ of the file - its column names, and its name
for display - never a cell of it. A run's stored snapshot records the row count
and nothing else.

**A cell that binds into a request is stored with that request.** A collection
run keeps one row per step execution, and each holds the exchange as it
happened: the URL, the request headers as sent - including the `Authorization`
header that binding-before-encoding builds out of the row's own values - the
request body, and the response. A load run keeps the same material for the
completions it samples, and a single [Send with a row](#send-with-a-row) lands
in History like any other send. So a run driven by a credentials file has each
bound iteration's credentials in its history, in SQLite, and on screen in its
step cards.

That is the design-mode trace rule, not an oversight of this feature: a trace
records what was **sent** rather than a redacted account of it, since a
redaction guess is wrong in both directions and reassuring when it is wrong.
The run's step view carries that disclosure where the steps are listed, and
names the data file when one was bound.

The expiry is the run's: step rows are deleted when their run is, so
`maxRunsRetained` and `runRetentionDays` (Settings, Data & retention) are what
bound how long a bound cell lives. Deleting the run deletes them immediately.
