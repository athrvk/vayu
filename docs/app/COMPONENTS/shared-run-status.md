---
description: >-
  Shared components of the Vayu desktop app for the tab breadcrumb, toasts and run status: the status pill, outcome banner, stop button and error summary.
---

# Shared: Breadcrumb, Toasts and Run Status

## Tab Breadcrumb (`components/shared/TabBreadcrumb.tsx`)

The one "where am I" line a detail tab draws, and the answer to the builder
being the only surface that had one (#1691). Takes a `label` for the `nav`'s
accessible name and an ordered `crumbs` array of `{ id, label, onSelect? }`.

- **Every crumb can be cut, none to nothing** (#3495). The ancestors truncate
  down to a `min-w-[3ch]` floor, so a chevron never lands on a label's first
  letter; the current crumb is `min-w-0` and a `TruncatedText`, so a long name is
  cut with its full text on hover rather than running under the nav's clip.
- **A crumb navigates only if the caller gave it an `onSelect`.** The current one
  is inert, because you are already there, and a control that does nothing is
  worse than text.
- **Blank labels are dropped, and nothing to show renders nothing** - not an
  empty row, which is the permanent ~30px band `RequestDescription` charged every
  request for before it became the Info tab.
- **`titlesPane` makes the current crumb the pane's heading** (#3498), at the
  main pane's outline level (`components/ui/heading.tsx`): the tab's `h1` on the
  request builder and the dashboard, which draw no other title, and on
  `LoadTestDetail` only where it is the whole pane (the dashboard's report; in
  History the run's header is the `h1`). `CollectionDetail` leaves it off: its
  header's name is the `h1`.

Adopted by the request builder (`useRequestCrumbs` - collection chain, then the
request), `CollectionDetail` (the collection's chain, drawn only when it is
nested: for a root it would repeat the header title underneath itself),
`LoadTestDetail` and the dashboard (`History` + which of the two run states this
is, revealing the drawer with `revealDrawerView` so a crumb never closes the list
it names).

## Toaster (`components/shared/Toaster.tsx`)

Mounted once by `App.tsx`. Renders the queue in `stores/toast-store.ts` through
the shadcn/Radix primitive in `components/ui/toast.tsx`, which owns the dismiss
timer, pausing on hover / focus / window blur, swipe-to-dismiss, and the
`data-state` the exit animation keys off. `F8` moves focus into the stack.

Toasts are the app's **single in-app** channel for reporting the outcome of an
action the user took, including save failures (see `save-store.reportFailed`). The
one exception leaves the app entirely: a terminal event that lands while Vayu
is not the window in front may also raise an opt-in OS notification
(`services/notify.ts`, issue #1358), and every one of those events still raises
its toast too. Four variants - `info`, `success`, `warning`, `error` - each
carried by an icon and a left rail rather than colour alone; tokens and
durations in `docs/design-system/feedback-and-dashboard.md` -> Toasts.

## Run Status Pill (`components/shared/RunStatusPill.tsx`)

A run's status as a word and a glyph, tinted by its status family: `Running`
(spinner), `Completed`, `Stopped`, `Failed`. The dashboard header and the history
run tab's header (`HistoryDetail`, #1944) draw it; the history row draws only the
glyph (`RunStatusGlyph`). Welcome's recent runs and the collection context bar's
last-run row take the word and `-text` token through `runStatusDisplay`, fed the
row's verdict (`rowOutcome`, #3496); the command palette's run rows are plain
text, so they say the verdict in words instead (below). All read `RUN_STATUS` in
`components/shared/run-status.ts`, so the label, glyph and `-text` token exist
once per status. The dashboard header's ending includes `failed` (#1932), set
when the engine reports the run failed, so a failed run no longer reads as
Completed; it says Running for as long as the run is live, a lost stream
included (#3351). An optional `label` replaces the word and keeps the status's
glyph and family: the dashboard passes **Finishing** for a run draining its
in-flight requests (#3568), which is a running run, not a status of its own, so
`RUN_STATUS` has no such key.

**`completed` is not a verdict** (#2130). A run that missed a budget, or whose
responses mostly errored, still ends `completed`, and the tick said it went well.
Both components take an optional `outcome` (`passed` | `failed` | `not-judged`,
from `run-outcome.ts`) that refines **only a `completed` run** through
`runStatusDisplay`: `failed` is a ringed exclamation in the error family,
`not-judged` a ringed question mark in the neutral family, each a different shape
from the tick and from `Failed`'s cross; `passed` keeps the tick. The word stays
"Completed" - the verdict is the banner's. A `failed` status needs no refinement:
`rowOutcome` is `failed` for every failed row (#3643), and `runStatusDisplay`
keeps `Failed`'s cross. The dashboard header takes the
outcome *string* as a prop, not the judgement object: it is memo'd on `Object.is`
and a fresh `{outcome, reason}` per render would defeat it (#1714). The history run tab
(`HistoryDetail.tsx`) passes a load run's verdict from the report it already
loads (`reportOutcome`), or a finished collection run's (`collectionReportOutcome`,
#3543), else `rowOutcome`, so the tab, the dashboard header and
the sidebar row draw one run in one colour (#2872); design runs pass none and
keep the tick. A collection run's sidebar row refines its own glyph from its
step counts and its budget verdict (#3458, #3539, `rowOutcome`), and Welcome's recent-runs row and the context
bar's last-run row paint the same verdict as the word's colour: "Completed" in
the error token, with ", verdict failed" in the accessible name, so a run with
failed steps or a missed budget is not green there (#3496, #3539). A run whose
status is already `Failed` gets no verdict word in any of these names or in the
palette's subtitle (`verdictBesideStatus`, #3643): the status says it. The palette's run rows (`useRunItems`)
have no colour to paint, so their subtitle carries the verdict as a word after
the status - "Collection run · Completed · verdict failed · 2m ago" - from the
same `rowOutcome` ("Collection run · Failed · 2m ago" for a failed one); a run with no verdict, such as a clean collection run (met
budgets included), keeps the status alone. A collection run's detail tab agrees with its row (#3543): `HistoryDetail` reads a finished scenario run's report and judges it with `collectionReportOutcome`, which shares one core (`judgeCollection`) with `rowOutcome`, so a failed or errored step or a missed budget draws the same failed pill on both. It falls back to `rowOutcome(run)` while the report has not arrived or cannot say, and the same fallback serves a load run whose report is loading or failed.

## Run Outcome Banner (`components/shared/RunOutcomeBanner.tsx`)

The line a finished load run opens on: **Passed**, **Failed** or **Not judged**,
then why ("2 of 4 budgets missed: p95, throughput", "All 3 budgets met, but
15.1% errors", "No budgets set. 0.0% errors"). It is a `Callout` - `blocking` for
failed, `info` with the success tick for passed, plain neutral `info` for not
judged - and the live dashboard (between the notice slot and the tab bar) and
`LoadTestDetail` (first in the scrolling body, above the request bar) draw the same component.

The verdict is `run-outcome.ts`, once, and the header glyph and the history row
read it too, so the three cannot disagree. `judgeRun` takes the status, the
report's `thresholdValidation` (which names the missed budgets) *or* a list
row's `verdict` (which does not), the error rate, and the run's failed checks
(#3537) in four inputs, `failedChecksOf` over its assertion block:
`assertionsFailed` (`exact.failed`, every response), `sampledAssertionsFailed`
(`sampled.failed`, the replay), `elementsErrored` (`errored`) and
`teardownsFailed` (`teardownFailed`), plus `drainCutCancelled` (#3538, below). The block is the report's top-level
`assertions` (`reportAssertionsOf`) or the row's `resultSummary.assertions`
(`rowAssertionsOf`), the same for a single-request and a scenario load run. An
engine before the block is read as it was: a scenario report's
`scenario.assertions` as exact, its replay unread; a single-request report's
summed `elements` failures as exact and `testValidation.testsFailed` as sampled
(#3458; the two never overlap, because a script that ran inline is tallied in its
element row and skipped by the replay); a row's flat `assertionsFailed` as exact:

- **failed** - the run's status is `failed`, or a declared budget was missed. A
  budget the run could not measure (`evaluated: false`) is counted by the engine
  as failed, so it lands here and is named like any other.
- **passed** - every budget met, no request errored **and** no check failed.
- **not-judged** - no budgets were set, or the budgets were met but requests
  errored (a latency ceiling can be met by a run of instant 500s) or a check
  failed, or the run was stopped. Never green: absence of a failure is not a
  pass. A failed check is not **failed**, which is reserved for a line the run
  declared and missed (a run that set `maxAssertionFailureRatePct` and broke it
  is already **failed**); the reason names every failed check, after the error
  rate, in the run-report export's words and order (`failedCheckPhrases`):
  "No budgets set. 0.0% errors, 4,580 assertions failed", "The budget was met,
  but 4,580 assertions failed" ("1 assertion failed" in the singular); a
  sampled-replay failure reads "4 assertions failed in the sampled replay", a
  run with both "150 assertions failed, 4 more in the sampled replay"; then "3
  elements errored" and "1 teardown script failed".
  `engine/tests/fixtures/run-verdict-conformance.json` holds the state and these
  phrases to the export's verdict, replayed by `run-outcome.test.ts`. The
  success rate stays HTTP-based.

  A run whose drain a Stop cut with requests still outstanding (#3538: the
  report's `summary.drainCut.cancelled`, the row's `resultSummary.drainCut`, read
  by `drainCutCancelledOf` as a positive integer only) is **completed** with
  budgets its answered requests met, but a cancelled request is in no total,
  rate or latency, and the ones the drain was still waiting on are the run's
  slowest. It is **not-judged**, and the reason is the sentence alone, "15
  requests were still unanswered when the drain was stopped" ("1 request was"),
  with no errors or failed checks appended. It sits after the **failed** line
  (a missed budget or a failed status still reads failed) and before every
  met-budget and no-budget reason; a Stop before the drain is still "Stopped
  before it finished". The history row's result line ends with "15 requests
  unanswered", because its glyph alone would read not judged with no cause on the
  row.
- **`null`** - still pending or running, or no report: the banner renders
  nothing, because "Not judged" over a report that has not arrived is a claim
  about a run nobody has looked at.

`errorRate` is a percent (0-100) by the one error definition in
`docs/ux-writing.md`. The budgets' short names (`p95`, `throughput`) live in
`threshold-metrics.ts` beside the long labels `ThresholdVerdict` draws, so the
two cannot drift; a metric with no entry keeps its raw key.

## Stop Run Button (`components/shared/StopRunButton.tsx`)

"Stop the run that is happening right now", in the one treatment, for the
places a run can be cancelled: the load dashboard header, the collection-run
tab and the in-progress pane of a load run's History tab. A primitive rather than markup each view repeats, because the treatment is
not a `Button` variant - a destructive *outline* over `ghost`, which no variant
paints, plus the in-flight swap to a spinner and "Stopping…". The label is
`destructive-text`, never the bare `destructive` fill. The idle word is `Stop`,
or the `label` the caller passes: **Stop waiting** while a load run only drains
its in-flight requests (#3568), from the dashboard header and from the History
tab's in-progress pane, which reads the phase off the run's own query rather than
polling for it. The swap reserves the width of that label as well as "Stopping…".

The caller owns the request and the failure path: every call site calls
`apiService.stopRun(runId)` and, on failure, raises an **error toast with a Try
again action** rather than a Callout - the run is still generating work, so the
retry is the reason for saying anything. The two History tabs (collection run,
load run in progress) share that through `hooks/useStopRun.ts`, which also
refreshes the run's detail, report and lists; the dashboard header goes through
`useEngine().stopLoadTest`.

## Sample Retention Note (`components/shared/SampleRetentionNote.tsx`)

One sentence, wherever a sampled set is displayed: how many records the run's
bounded stores displaced, and what is on screen. On the `responses` surface
that is drawn uniformly from the whole run rather than its opening - except
when the run's response-sample byte budget was spent, where it says instead
that what is on screen is drawn from the part of the run whose bodies fit. On
the `traces` surface (`report.results`) it says requests with an error are kept
ahead of successful ones and the set is not a uniform sample, because the
report route picks its rows failures first (#2210). Several
surfaces show such a set - the dashboard's Sampled Requests card, the history
Samples tab, and the shared `TestValidationSummary` (itself rendered in both
the dashboard and the history Overview) - so the wording lives here once
instead of being written out per surface and drifting.

Renders nothing when the run displaced nothing, and nothing when the run
reported no counts at all (an older summary): "nothing was dropped" and "we
cannot tell" are both worse as prose than as absence. Built on `Callout`
(`severity="info"`) rather than a hand-rolled muted row.

## Error Summary (`components/shared/ErrorSummary.tsx`)

A run's error card: **Total errors** with its rate (`formatErrorPercent`, two
digits), the **HTTP errors** / **No response** split, then **By error type**
(transport errors, through `errorTypeLabel` so `ssl_error` reads "SSL error")
and **By status code** (`HTTP 500`, or "No response (status 0)"). The history
Overview renders it, and the dashboard shows the same Overview for a finished
run (#2220). It was shared because two hand-built copies had drifted: the
dashboard's own report printed raw type keys and no status-code list, so a run
whose errors were all HTTP 500 showed an empty list under a non-zero total. `ERROR_TYPE_LABELS` has one definition, there.

Props are `errors` (`RunReport["errors"]`), `errorRate` (a percent), and the
`httpErrors` / `noResponse` split, which the caller reads (`DashboardDerived`, or
`errorBreakdown` on the report summary). Renders nothing for zero errors.
`onSelectStatus` and `onSelectErrorType` are optional: given, each By status
code row (or By error type row) is a `listRow` `Button` that reports its code
(or its raw type key, not the label); absent, those rows are plain text.
`hasSamples(target)` (`{ kind: "status", code }` or `{ kind: "errorType", key }`)
lets the caller refuse a row: it is drawn disabled and reads "No sample of this
was kept". The history Overview passes the handlers (#2213), to open the
Samples tab at an example of the row.

The optional `sampling` prop (`report.sampling`) feeds one note under By error
type (#2400): "N errors beyond the first M are not broken down by type", with
the sentence that the counts cover only the stored errors and the totals above
are exact. M is `errors.withDetails`, the stored-record count, N is
`sampling.errorsDropped`. It is a `Callout` (`severity="info"`) written in
`ErrorSummary` rather than a `SampleRetentionNote` budget: errors past the
store's cap are refused, not displaced, and the sentence is about a breakdown,
not a sampled list. It draws only when `errorsDropped > 0` **and** the type
counts sum to less than the no-response count. A run stored since the engine
counts every error by type has `errors.types` adding up to the no-response
total whatever `errorsDropped` says, so the note would be false there; older
runs and design-mode runs build the types from the stored records and fall
short. An absent `sampling` is silent (absent is "cannot tell", the rule
`SampleRetentionNote` states above).
