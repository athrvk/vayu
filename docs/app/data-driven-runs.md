# Data-Driven Runs

A collection run can be driven by a file: one row per iteration, its columns
readable from the requests themselves and from scripts. Pick the file in the
**Run collection** dialog, beside Iterations and Load test.

This page is the file's contract - what Vayu accepts, what it refuses, and what
a value becomes once it is bound.

## Supported files

| Extension | Format | Values arrive as |
|-----------|--------|------------------|
| `.csv` | Comma-separated, RFC 4180 | strings, always |
| `.tsv`, `.tab` | Tab-separated, same grammar | strings, always |
| `.json` | An array of row objects | their JSON types |
| `.jsonl`, `.ndjson` | JSON Lines - one object per line | their JSON types |

There is no XLSX support and no headerless mode. A spreadsheet exports to CSV in
one step, and a file whose first row is data would leave every column
unaddressable - see below.

## The header row *is* the mapping

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
in first-seen order. A key that only *some* rows carry is a **warning** at pick
time naming how many rows lack it - the iterations bound to those rows would
fail on a `{{data.*}}` token naming it, but a column nothing references is
harmless, so it does not block the run.

## Values: strings from CSV, native types from JSON

A CSV or TSV cell is always a string. `007` stays `007` and a 20-digit id
survives, which is JMeter and k6 behaviour and the reason the preview says so.
JSON and JSONL keep what the file declared - `3` is a number, `true` is a
boolean, `null` is null.

If you need a number to arrive as a number, use a JSON file.

## Quoting (CSV and TSV)

The parser is RFC 4180, not a `split(",")`:

- A quoted field may contain the delimiter, newlines, and CRLF.
- A literal quote inside a quoted field is written doubled: `"say ""hi"""`.
- A quote that does not *open* a field is an ordinary character, so `6" pipe`
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

Two engine settings bound a run's data set, and the picker enforces both
*before* the run rather than letting `POST /runs` refuse it afterwards:

| Setting | Default | Bounds |
|---------|---------|--------|
| `maxScenarioDataRows` | 1000 | How many rows one run may carry |
| `maxScenarioDataBytes` | 16 MiB | How large the data set may be |

Both are editable in **Settings -> Engine -> General**, and the picker reads the
live values - raise a limit there and the same file is accepted without
restarting anything. The row limit alone does not bound the payload, since one
row is free to hold a megabyte in a single cell, which is why there are two.

The engine never opens a file. The app parses it and sends the rows inline on
the run payload, because the script sandbox has no filesystem access by design
and handing the daemon a user-supplied path would be a new trust boundary. Rows
are never persisted on either side - a run's snapshot records their count alone.

## Reading a row: `{{data.column}}` vs `pm.iterationData`

Both read the same row. They differ in *when*:

- **`{{data.column}}`** is substituted into the request - URL, headers, body,
  form fields - immediately before the send. Use it to make each iteration hit a
  different endpoint or send a different payload. See the
  [`{{data.column}}` contract](../engine/api-reference.md#post-runs) in the
  engine's HTTP API reference.
- **`pm.iterationData`** is read by scripts, *after* the step's request was
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
exists to remove.

## How many iterations, and which row

**One iteration per row** by default: leave Iterations empty and the row count
is the run's length.

Give an explicit Iterations count and it wins - row `i % rows` binds to
iteration `i`, so a count above the row count wraps back to the top, and a count
below it leaves the remaining rows unused. The picker states which of those is
about to happen, because a 500-row file running once is the surprise this
preview exists to remove.

**A load run** binds rows differently: every virtual user claims rows from one
shared cursor, so no two hold the same row at once, and the rows repeat for as
long as the duration lasts. The row count says nothing about how long the run is.

## Nothing is stored

The rows ride the run payload and are dropped when the dialog closes. They are
user data of unknown sensitivity - credentials, customer records - so neither
the app nor the engine persists them, and the file itself is read fresh each
time you pick it.
