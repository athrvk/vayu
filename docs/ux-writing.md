---
description: >-
  Vayu's UX writing rules: voice, the three failure-source error templates, the
  terminology glossary, and the case/punctuation/truncation rules that make the
  guide enforceable across hundreds of scattered strings.
---

# Vayu UX Writing

> Reference for every user-facing string: labels, placeholders, tooltips,
> empty states, dialog copy, error and toast messages. Future sessions must
> read this before touching UI text.

---

## Voice

Direct, precise, dry. The audience is developers testing APIs - they want the
fastest path to the fact, not a friendly tone layered over it.

- Second person ("you"), active voice, present tense.
- No whimsy, no apologies, no marketing words in-product ("Supercharge your
  testing!"). This is not Slack or Mailchimp's register.
- Use the jargon developers already have (HTTP status, header, cURL, JSON).
  Never invent cutesy names for standard concepts, and never paraphrase a
  technical value - show it verbatim.

## Errors have three sources, and each gets its own shape

Vayu error copy fails today because it treats every failure the same. It
isn't the same:

1. **The user's own target API responding with an error** (a 404, a 500) is
   *data*, not a Vayu error. Show it as a response, never dress it in error
   chrome (no red banner, no "Something went wrong").
2. **The network or target failing to respond at all** (timeout, refused,
   TLS): `Couldn't [verb] [target] ([raw code]). [one-line cause]. [next
   action]`.
   - `Couldn't connect to localhost:3000 (ECONNREFUSED). Nothing is listening
     on that port - is your server running?`
   - `No response after 30s from api.example.com. Raise the timeout in
     Settings › Network & connectivity or check the server.`
3. **Vayu itself failing** (disk full, engine crash, local storage): name the
   actual failure. Never blur it into the same shape as a network error - a
   full disk and a refused connection are different problems with different
   fixes.

**One opener only: "Couldn't [verb] [object]."** `Failed to`, `Could not` and
`Please` are banned in UI text. The first two are the passive, formal register
the voice section rules out; `Please` is the apology's softer cousin and breaks
the same rule (direct, no apologies - see [Voice](#voice)): say what to do, not
that you would like them to. The app's own text has one breach left, the
failed engine restart's "Please close the Application and reopen it."
(`electron/sidecar.ts`, #2292). Beyond it are engine response bodies that the
app shows after its own "Couldn't ..." prefix (#2295). The first is held by the
voice and casing scan, the second by the engine test #2295 adds (see
[Enforcement](#enforcement)). Log strings and code comments are a separate
surface and keep whatever form reads well there.

## Terminology glossary

One name per concept, everywhere in the UI. This is mostly ratifying what's
already consistent in the codebase, plus fixing the one real overload.

| Concept | Term | Notes |
|---|---|---|
| A named group of requests | **Collection** | Never "Folder" in a string a user reads - don't introduce it even for nested sub-groups. The ban covers copy, not identifiers (`DEFAULT_FOLDER_NAME`, a row type in the tree code) or engineering prose. |
| A named set of variables (dev/staging/prod) | **Environment** | No synonym. |
| A single HTTP request | **Request** | Never "Call" as a noun for it - "call" stays fine in prose ("a script calls `pm.variables.get`"). |
| A `{{token}}` value | **Variable** | Never "env var" - a variable can live in collection or global scope too, not just an environment, so that phrasing is inaccurate, not just inconsistent. |
| Where a variable resolves from (global / collection / environment / row) | **Scope** | Use it a bit more deliberately in variable-related copy (tooltips, the variable popover) rather than avoiding it. |
| Firing a single request | **Send** | Locked. Matches Postman/Insomnia convention and keeps "Run" free for the two below. |
| Firing a whole collection sequentially | **Run** | As in "Collection run" / run history - already established. |
| The free-text line a user writes about a run when starting it | **Comment** | The run header (History, and the live dashboard's) labels it "Comment", and the payload key is `comment`. Never "Note" or "Description". The start dialog's field is the **Run label**, a field name for the act of typing it. |
| The load-testing feature | **Load test** (noun), **Run** (verb: "Run a load test") | Already consistent as its own noun phrase. |
| A recorded run, by kind (History, tab titles, Recent runs) | **Send**, **Collection run**, **Load test** | One name per `Run["type"]` (`design`, `scenario`, `load`), defined once as `RUN_TYPE_NAME` in `modules/history/types.ts`, and spelled the same wherever the app says it: the row's visible kind, its accessible name ("Open Load test, completed, ..."), the palette's run subtitle, the History breadcrumb ("Load test run") and the Live crumb ("Live load test"). Never "request run", "collection" or "scenario load run" for these. `modules/history/types.test.ts` fails on a second kind table or an inline kind ternary. The agent reference (`lib/agent-reference.ts`) keeps its own words on purpose: it is pasted into an agent's context, not shown to a user. Never "Design" or "Design mode": `design` is the wire value, not a word the user sees. A run list's empty state says "No runs", never "No test runs" - a send is a run too. |
| Assertions on a response | **Tests** (tab), **Test validation** (results); **Assertions** (a scenario load run's exact count) and **Sampled replay** (the Test validation card when that Assertions card sits beside it) | Two populations, two names (#2820): **Assertions** is counted on every response, **Sampled replay** only on the responses kept for the post-run replay, and the Overview never shows two cards both called "Test validation". A run's verdict reason says "4,580 assertions failed" (singular "1 assertion failed"), never "failures" or "tests failed". The one real overload - "Test" means two different things across the load-test feature and response assertions. Not renaming either (both are established, product-defined terms), but never let both appear in the same sentence or dialog without a qualifier ("load test" / "response tests") to disambiguate. |
| A pre-request/post-request script | **Script**, living under the **Elements** tab | Keep "Elements" as the tab name (the consolidation from separate Pre-request/Tests tabs was deliberate), but individual script errors/labels keep saying "Pre-request script" / "Post-request script" (sentence case, matching the engine's own labels in `script_kinds.cpp`) - renaming those to "Elements" would lose information the label carries. Discoverability for someone looking for "Pre-request Script" or "Tests" is carried by two lines instead: the empty Elements panel's gloss (with a Post-request script chip), and the response Tests tab's empty state, which points at the Elements tab. An inline empty state is one line (`title` only), so the pointer is folded into it. |
| A failed request in a load test's numbers | **Error**; the two kinds are **HTTP errors** and **No response** | A request is an error when its response status is outside 2xx/3xx, or it got no response at all (timeout, refused connection, DNS or TLS failure). A 3xx is a success. One definition for every error count and rate (the live card, the report, History, the budget verdict, the Steps table's Errors column), so never "failed" in one place and "error" in another. This reconciles with the first source under "Errors have three sources": a target API's 404 or 500 is still *data* in the Send pane and gets no error chrome there, but in a load test it is counted as an HTTP error because the run's rate is the question being asked. Never "transport error" in user copy. A request a user's **Stop** cancelled before it was answered is none of **error** or **failed**: it got no outcome from the target, so it is counted apart as **cancelled** and is never an error. Say "N requests cancelled by Stop" (a fragment, muted, never destructive); it is in no error count, rate or total. |
| The number of simulated users in a closed-loop load test | **Virtual users** | Never "VUs", "Connections", "Concurrency" or "concurrent users" in UI copy; prose pluralises it ("1 virtual user", "64 virtual users"). Written once in `constants/load-test-modes.ts` (`CONCURRENCY_LABEL`, `CONCURRENCY_UNIT`, `formatConcurrency`), and the mode is **Constant virtual users**. The open-loop measurement keeps **In-flight requests**: a Constant RPS run's stat, chart title and series say that, every other mode says virtual users (`isClosedLoopMode`, `concurrencyMeasureLabel`). API and MCP field names keep `concurrency`, and genuine TCP/TLS "connection" copy (Settings › Network, the connection-reuse charts) is not this quantity. |
| The five load-test modes | **Constant RPS**, **Constant virtual users**, **Fixed request count**, **Ramp-up**, **Capacity discovery** | Sentence case like every other label; only the acronym (RPS) keeps its casing. Written once in `constants/load-test-modes.ts` (`loadTestModeLabel`). |
| The mock-server feature | **Mock server** | Sentence case in a heading as in a sentence; there is no Title Case variant. |
| Vayu's own backend process (the daemon on port 9876) | **Vayu's engine** | Bare "the engine" isn't wrong grammatically, but avoid it as a sentence's opening word or its subject noun with nothing attached - "Vayu's engine" is what tells the reader whose process failed rather than leaving "engine" to mean the request's own target server. |
| The collapsible panel left of the main area (the Collections, History, Variables, Services, Trash and Settings views) | **Sidebar** | "Sidebar" is the word a user reads - in the empty-tab hint, the shortcut labels, the "Sidebar views" group, the palette. "Drawer" is an identifier only (`Drawer`, `DrawerPanel`, `TOGGLE_DRAWER_CHORD`, `DRAWER_VIEW_CHORDS`) and never appears in a string a user can see. |
| Multi-project container | *(doesn't exist)* | "Workspace" isn't a Vayu concept. Don't introduce it as filler vocabulary during a string rewrite even where a sentence seems to want one. The one exception is **Backup** (Settings › General), a feature that used to be called "Workspace backup" - "Backup" alone is the locked term now, and "Workspace" should not reappear as a qualifier for it. |

## Decision rules

Rules a writer or reviewer can apply without judgment calls, so hundreds of
scattered strings land the same way.

- **Case.** Sentence case everywhere - buttons, headings, tabs, menu items,
  feature and mode names ("Collection run", "Constant virtual users"). There is
  no Title Case exception for a feature name. Proper nouns, acronyms and
  protocol names keep their casing (HTTP, RPS, cURL, OpenAPI, GraphQL, JSON).
  Two exceptions, both stated so neither is mistaken for drift:
  - **The three stored default names stay Title Case**: "New Collection", "New
    Request", "New Environment". They are stored data, not interface copy.
    `RunItem.tsx` and `lib/agent-reference.ts` compare a persisted
    `summary.requestName` to `DEFAULT_REQUEST_NAME` by literal, so lower-casing
    the default would make every run already recorded as "New Request" read as a
    name the user chose. A name the user types is theirs and keeps its casing.
  - **The menu bar macOS draws at the top of the screen follows the platform's
    Title Case** ("Check for Updates", "Toggle Developer Tools"), because that
    is how a macOS user reads it. Every other string is sentence case, including
    the same menu template popped from the title-bar icon on Windows and Linux:
    that is an in-app surface and has no platform convention to follow. One
    destination, one name: the settings item reads "Settings…" everywhere (macOS
    itself now calls it Settings, not Preferences). The macOS Dock menu follows
    the macOS rule; the Windows Jump List follows sentence case. The code that
    serves both from one template (`createMenu` in `electron/main.ts`, which
    needs a per-platform label function) belongs to the sentence-case sweep, not to this
    page.
- **Punctuation.** A full sentence ends with a period, including in a
  tooltip; a fragment does not. Oxford comma. No exclamation marks. " - " for
  a dash (the repo bans em-dashes everywhere), "…" for an ellipsis (one
  character, never three full stops after a word).
- **Names of things.** A settings path is written `Settings › Network &
  connectivity`, with `›` between the names and never `>`. The tool is "cURL" in
  a sentence ("a cURL command"); the command a user types, and the code-generator
  id, stay `curl`.
- **Numbers and units.** Always state the unit (ms or s, never a bare
  number). One format via `Intl`, not hand-built string concatenation. Real
  plural handling via `Intl.PluralRules` (`pluralize` for a noun, `pickByCount`
  for a sentence whose verb agrees), never "request(s)" or `n === 1 ? "" : "s"`
  (`plural-rule.test.ts`). The digits come
  from `lib/format-number.ts`: `formatNumber` for counts, `formatMs` for
  milliseconds and `formatRate` for per-second rates (two decimals under 10,
  whole numbers above, thousands separators), `formatPercent` for percentages
  (one decimal). They return digits only; the caller adds the unit, so a p99
  reads `2.27ms` in the History tile, the step table, the stat card and a chart
  tooltip. A measured latency under 0.01 ms reads `<0.01`, never `0`: a
  request that took 0.4 ms did not take no time, and only an exact 0 prints
  as `0`. `formatLatencyParts` returns the digits and the unit together
  (`{ value: "1.23", unit: "s" }` for 1234 ms), and a stat tile that draws the
  unit in a slot of its own renders both halves from it, never a literal "ms"
  beside `formatMs`: 1234 ms reads `1.23 s` on every tile. `formatLatency` is
  the same pair joined for a surface with no slot of its own (`999ms`, then
  `1.23s` once it rounds to 1000 ms). `formatSeconds` is the same rule for a
  span measured in seconds (an ETA, a ramp, a test's duration, an anomaly's
  length): under a minute it is `formatLatency` (0.4 reads `400ms`, 4.2 reads
  `4.20s`), from a minute up grouped whole seconds (`75s`, `3,600s`), so a clock
  and a latency never print the same span two ways, and the unit comes with it.
  The response viewer's total and queue wait (`formatDuration`,
  `formatResponseTime`) follow the same rule, so a 2.27 ms send reads `2.27 ms`
  there and as a load p50; only its phase breakdown (`formatPhaseDuration`)
  keeps a ladder of its own, one decimal in the tens of milliseconds.
  A chart axis labels its ticks
  with `axisMs` (`0.5ms`, `2ms`, `1.5s`), `axisRate` (`1.2k/s`) or `axisVitals`
  (`1.2k`), which take their decimals from the tick spacing so no two
  neighbouring ticks print alike (1200, 1210, 1220 read `1.2k/s`, `1.21k/s`,
  `1.22k/s`) and move the whole axis to one magnitude, never `0` beside `1k`. Do not `toFixed` a new
  latency, rate or percentage for display, and do not declare a `formatMs` or
  `formatSeconds` of your own: a source scan fails on it
  (`lib/no-local-format-ms.test.ts`), and a second one
  (`lib/no-hand-built-numbers.test.ts`) fails on any `.toFixed(` outside its
  short list of axis, byte-size and viewer-phase formatters. The screen-reader announcer takes the
  same digits and speaks the unit as a word (`2.40 seconds`). Name a latency series for what it
  measures: the average that includes generator queue wait is "average latency
  (incl. queue wait)" and the time on the wire is "wire time", never a bare
  "latency" or "wire".
- **Truncation.**
  - URLs truncate in the middle, keeping the host and the last path segment.
  - Variable names and file paths truncate keeping the final segment (never
    cut the part that identifies *which* variable or file).
  - IDs keep their first 8 characters.
  - The full value always goes in a tooltip or `title` attribute.
- **User-supplied names vs identifiers.** Quote user-supplied names ("Prod
  API"). Put technical identifiers and literal values in code style
  (`{{authToken}}`, `ECONNREFUSED`, header names).
- **Length budgets.** Buttons: at most 3 words. Toasts: at most one sentence
  plus one action. Empty states: one heading, one line, one primary button.
- **Confirmations name the consequence.** Destructive, unrecoverable actions
  get a dialog whose body states what's lost, and a button labelled with the
  real verb matching the title ("Delete environment", never "OK" or "Yes").
  Recoverable actions (anything that lands in Trash) skip the confirm dialog
  entirely and use an undo toast instead - a dialog for a reversible action
  is friction with no purpose.
- **Keyboard shortcuts in tooltips**, platform-aware glyphs, one format: the
  label, then the chord in a `TooltipHint` beside it, no parentheses
  (`Send request`  `⌘↵`). `TooltipShortcutLabel` renders it for the rail, the
  icon buttons and the URL bar alike. A parenthetical was rejected: the chord
  has to sit in the tinted primitive to read on the tooltip's accent fill, and
  "(⌘↵)" written into the label string would be plain foreground text.
- **A bare noun on the rail gets a gloss.** An icon-only rail button's tooltip
  is the only place its name is explained, so a name that is a category rather
  than a thing ("Services") carries a one-line fragment beneath the label that
  lists what is behind it ("Webhook inbox, OAuth issuer, mock servers"). A name
  that explains itself ("Trash", "History") gets none, and the gloss is never
  part of the accessible name. It is the `hint` on the view's entry in
  `constants/drawer-views.ts`, not a string written in the rail.
- **State-machine copy** uses one vocabulary per state machine, not
  synonyms: `Saving… / Saved / Unsaved changes` for persistence,
  `Running / Stopped / Completed / Failed` for a load test run. The present
  participle plus ellipsis means "in progress" and nothing else uses that
  form.
- **A finished load run has two vocabularies, and they are not synonyms.**
  The *status* says how the run ended (`Completed`, `Stopped`, `Failed`); the
  *verdict* says whether it held up: `Passed` (every budget met and no request
  errored), `Failed` (the run failed, or a budget was missed) or `Not judged`
  (no budgets were set, the budgets were met but requests errored, or the run was
  stopped). `Completed` never implies a pass. Never "Success" or "Succeeded" for
  a verdict, and never "Not judged" over a report that has not loaded - say
  nothing instead. The reason follows the title after a dash and names budgets by
  their short names ("2 of 4 budgets missed: p95, throughput"), counts errors by
  the one definition ("15.1% errors", never "failed responses"), and has no
  trailing full stop. `app/src/components/shared/run-outcome.ts` holds the
  strings.

- **A time is never written by hand.** Copy that says when something
  happened puts a `TimeValue` in the sentence ("Deleted 2 hours ago",
  "Recorded 5 minutes ago") rather than building the phrase from a number and
  a unit: the relative phrase comes from the platform (`Intl.RelativeTimeFormat`),
  so it is in the user's language and pluralises correctly, and the hover card
  gives the zone and UTC. Never `5m ago`, `2h ago` or `just now`; under a
  minute the platform's own "now" is the word. Where the sentence is a plain
  string (an `aria-label`, a native `title`), it calls `formatInstant` from
  `lib/time-value.ts` instead. An absolute time keeps its machine value
  visible and the card adds the zone. `time-surfaces.test.ts` fails on a
  hand-written formatter.

## Calibration examples

| Before | After |
|---|---|
| "Request failed" | "No response after 30s. The server at api.example.com accepted the connection but didn't reply. Raise the timeout in Settings › Network & connectivity or check the server." |
| "Failed to fetch" | "Couldn't connect to localhost:3000 (ECONNREFUSED). Nothing is listening on that port - is your server running?" |
| "No collections yet" | Heading: "No collections yet". Body: "Requests live in collections; your first one is created for you." Buttons: [New request] [Import]. |
| "Are you sure?" / [OK] | Title: "Delete 'Prod API'?" Body: "Its 12 variables are removed. Requests that use them will send the literal `{{baseUrl}}`. This can't be undone." Buttons: [Cancel] [Delete environment]. |
| "Variable not found" | "`{{authToken}}` isn't defined in 'Staging' or globals. It will be sent as literal text." |
| Static "Save" button | "Save" (disabled when clean) → "Saving…" → "Saved" (fades after 2s). On failure: "Couldn't save - disk full. Changes kept in this tab." |

## Enforcement

A sweep against this guide is only as durable as the test that keeps drift
from creeping back in afterward. These hold it:

- **`app/src/voice-casing.test.ts`** reads every string in the app's sources
  and fails on a banned opener ("Failed to", "Could not", "Oops", "Please",
  "Something went wrong") at the start of a sentence, on an exclamation mark
  after a word, and on Title Case where the case rule says label: the text of
  `Button`, `DropdownMenuItem`, `ContextMenuItem`, `SelectItem`, `TabsTrigger`,
  `DialogTitle`, `CardTitle` and `Label`; a `label` or `title` property or
  prop; a `*_LABELS` record under `constants/`; and the label argument of
  OAuth2Form's `field()`. Proper nouns, acronyms and product names keep their
  capitals through a named list in the test, each entry with its reason.
- **`app/src/lib/ui-strings.testkit.ts`** is what it reads: every string
  literal, template-literal segment and JSX text node under `app/src` and
  `app/electron`, with its file and line, comments excluded and the arguments
  of `console.*` and logger calls dropped (logs are exempt, see above). A new
  rule from this page is added to that scan rather than to a file walk of its
  own.
- **The engine's half** is two tests. `config_seed_test.cpp`
  `EveryEngineSettingLabelIsSentenceCase` reads the setting labels the Settings
  page renders verbatim (#2293); a later word may start with a capital only when
  it is all capitals or one of OAuth, OpenAPI, Send, Sends,
  Expect. The other, a scan of
  `engine/src/http/routes/*.cpp` for response bodies opening "Could not" or
  "Failed to", does not exist yet and is owned by #2295.
- **`app/src/user-text-spelling.test.ts`** (#2299) reads the same strings and
  fails on `Settings >` (write `Settings ›`), on lowercase "curl command" or
  "curl request" (write "cURL"), and on three full stops straight after a
  letter (write `…`). It has no allowlist: a spread, a regex, a `"..."` code
  sample and a GraphQL `... on` fragment put something other than a letter
  before the dots.
- **Narrow scanners**, one rule each, are filed by their own issues; each adds
  its rule to the scan above when it lands. Landed: hand-built plurals and
  "(s)" (`plural-rule.test.ts`, #2307), which reads "(s)" in the same strings
  and refuses a `=== 1` / `!== 1` ternary whose branches differ only by the
  plural suffix or are an agreement pair ("is"/"are", "it"/"them"); the fix is
  `pluralize` or `pickByCount` from `modules/dashboard/utils/format.ts`; and
  bare "the engine" and "design-mode" (`voice-bare-engine.test.ts`, #2298),
  which refuses either in a rendered string: write "Vayu's engine", and "Send"
  for a design-mode send.

What breaks a rule today sits in the scan's `KNOWN_BREACHES`, keyed
`file :: literal`, each entry naming the open issue that retires it. The commit
that fixes a string deletes its entry: a test fails on an entry whose literal
the sources no longer carry, so a fix cannot land with its entry left behind.
Text the rules match that is not interface copy (a line of a code sample) is
listed apart, with its reason instead of an issue.

`app/electron/mcp/**` is not scanned: its text is written for agents, not
people. The "Could not" strings in `electron/mcp/safety.ts` and
`electron/mcp/tools/kit.ts` are therefore unguarded by this scan.
