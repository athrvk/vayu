---
description: >-
  Shared components of the Vayu desktop app that draw a run's results: threshold verdict, capacity, contract coverage, schema validation and scenario steps.
---

# Shared: Run Results

## Threshold Verdict (`components/shared/ThresholdVerdict.tsx`)

The run's verdict against the pass/fail budgets it declared
(`RunReport.thresholdValidation`): one row per budget - the limit, what the run
measured, and whether it met it - under a Passed/Failed header. The history
detail's Overview shows it, which is also the dashboard's view of a finished
run (#2220).

It is the **aggregate** counterpart to the Test validation (or Sampled replay) card beside it: a
`pm.test` script sees one response at a time and structurally cannot assert a
p99 or an error rate, so a run where every assertion passed can still have
missed the budget it was run to check.

Renders nothing when the run declared no budgets - which is every run recorded
before they existed - following the same absent-vs-zero rule as
`SampleRetentionNote` and `CapturedDataWarning`: "not judged" is a different
claim from "judged and passed nothing", and only absence can make the first.
The comparator follows the metric (`≥` for the throughput floor, `≤` for the
ceilings), and a metric key this build has no label for renders under its raw
name rather than vanishing from a verdict whose counts still include it.

A single check can itself carry no measurement (issue #1484): a latency
ceiling checked against zero completed requests reports `evaluated: false`,
which the card shows as "no samples" in place of a number rather than the
`0` a run of nothing but errors would otherwise default to and trivially
pass. Such a check counts toward `failed`, and the summary line grows a
"N not measurable" clause. A report from a pre-#1484 engine carries no
`evaluated` key at all and renders exactly as before - absence reads as
measured, the value that engine effectively assumed everywhere.

The assertion-failure budget (`maxAssertionFailureRatePct`) is judged on the
**worse of two populations** (#2892): the exact inline tally and the sampled
`pm.test` replay. When an evaluated check carries a non-empty
`assertionsSampled`, its row grows a muted line naming them: "Judged on the
worse of 2,270 assertions on every response (0 failed) and 24 assertions on
responses sampled at 1 in 100 (12 failed)." If the exact population is empty it
reads "Judged on 24 assertions on responses sampled at 1 in 100 (12 failed)."
The scope names the sampling period, not a share: a long run's reservoir cap
(`max_response_samples`) can leave the replayed set sparser than 1 in N. The line is absent when the
sampled population is empty or missing (a collection run, a run with no test
script, a report stored before the split) and on an unmeasurable check, so those
rows read as they always did.

Each check has a "Copy for agent" icon button (`thresholdReference`, #2047) naming the budget by the engine's
key - `latencyP99Ms`, or `custom.<name>.<stat>` for a custom budget, whose raw key is also the row's label - and
the run, from the optional `runId` prop (both hosts pass `report.metadata.runId`). The limit and the measurement
are never in the line, and without `runId` the buttons are absent.

A run that was **stopped** is judged on what it measured before the stop, and
the card says so (#2194): the optional `stopped` prop adds a line under the
summary, "Run stopped after 3s of a planned 20s. Judged on what was measured up
to that point." The counts and the Passed/Failed badge are the engine's and do
not change. Both hosts pass `stoppedRunOf(report)` (`stopped-run.ts`), which is
`undefined` unless `metadata.status` is `stopped`; it reads the planned span
from `metadata.configuration.duration` (`durationSeconds`) and the elapsed one
from `summary.totalDurationSeconds`, falling back to the start and end stamps.

A check judged against a value the user did not set for this run is tagged
**carried over** (#2195): the optional `carriedBudgets` prop is the list of
`thresholds` keys the run was started with as carried, both hosts pass
`report.metadata.configuration.carriedBudgets`, and a row whose `check.metric`
is in it gets an outline `Badge`. The summary counts the *checks* that are
carried, not the list's length (a key the engine did not judge cannot inflate
it), and the clause sits between the counts and "not measurable": "2 of 3
budgets met (1 carried over), 1 not measurable." The wording is "carried over"
without "from an earlier run" because the p99 the Settings threshold seeds comes from Settings,
not from a run. Absent or empty, the card renders exactly as before.
A run with no declared duration (iterations, ramp, scenarios) drops the "of a
planned" clause, as does one that reached its plan, and a report with no usable
elapsed time says only "Run stopped early."

## Capacity Summary (`components/shared/CapacitySummary.tsx`)

What a `mode: "capacity"` run's adaptive search found (`RunReport.capacity`):
the virtual users the target held inside its latency budget and error limit,
where the search stopped, and the per-level table both were read off. Shown in
the history detail's Overview, beside `ThresholdVerdict`.

Why the search stopped is worded once, in `components/shared/capacityStop.ts`. `STOP_REASONS` holds the badge's label and whether the stop is a
finding about the target (`degrading`, `saturated`) or only a bound the caller set (`none`); the dashboard's Saturation card reads the same table. The detail
line under the headline is computed from the report by `stopDetail(capacity, stepDuration)`, not stored: a `plateau` quotes the p99 rise ("p99 stayed inside the
budget but rose from 52ms to 103ms", the saturation level's p99 against the last level tried) and says nothing of latency when the report has no
`saturation*` figures, no levels or no rise; `slo_exceeded` and `errors_exceeded` say "two consecutive measurements of the level" and, when the run's
`metadata.configuration.stepDuration` is passed in, "(each 5s long)". A level is measured, never a "window". The export view (#2819) mirrors this list, so
a change to the wording is made in `stopDetail` and reaches both.

The History row of a capacity run says the same thing in a clause
(`capacitySubtitle`, #2930), from the `resultSummary.capacity` block the runs
list carries: `degrading` stops with a knee read "held 41 · gave out at 51" (or
"gave out at 51" when no level held), `plateau` reads "plateaued" with no
level (the last level tried overshoots the plateau point), and the other stops read "held at least N". The row cannot
see `saturation*`, so it names no plateau point.

The headline is a **sentence**, not a stat grid, because the mode exists to
answer one question in words - "what can my service take" - and four numbers
side by side make the reader assemble that answer themselves. The table below
is the evidence, for a reader who wants to see the shape of the curve rather
than trust the summary of it.

The headline **follows why the search stopped** (`stopReason`), because the same
`maxHealthy*` figures mean different things under each reason, and "Sustained N"
claims a limit that only some stops found (same absent-vs-zero discipline as
`ThresholdVerdict`, one level deeper):

- **`slo_exceeded`, `errors_exceeded`** - "Sustained N virtual users at R
  req/s, with a p99 of P against a B budget." The target was watched giving
  out, so the held level is a measured capacity. The knee sentence beside it is
  a **bracket**, not a point: "The limit lies between 41 and 51 virtual users:
  it held 41 and gave out at 51, where p99 reached 230ms." The evidence clause
  quotes the reading that broke: p99 for `slo_exceeded`, the share of requests
  that failed for `errors_exceeded` ("where 94.0% of requests failed"). A
  figure the engine did not send is left out rather than printed as `0ms`.
  When no level held there is nothing to bracket with, and the knee reads "It
  gave out at N virtual users".
- **`plateau`** - "Throughput stopped growing at K virtual users (R req/s, p99
  P). More only queued.", read from `saturation*`, the lowest healthy level
  within the plateau gain of the best throughput. `maxHealthy*` is the last
  level tried on a plateau and overshoots that point, so it is never printed,
  and the word "Sustained" does not appear. A plateau stored before the engine
  reported `saturation*` falls back to "Throughput stopped growing. More only
  queued." and names no level.
- **`cap_reached`, `deadline`, `stopped`** - "At least N virtual users held the
  budget (R req/s, p99 P). The search did not find a limit." A floor, not a
  capacity: the search ran out of ceiling, time or patience. `deadline` and
  `stopped` add "The next level was still being measured." because no report
  field names the level that was open, and the card does not guess one.
- **No level held the budget** - the first level already breached. The search
  found no sustainable capacity, which is *not* the claim "this service
  sustains zero".
- **No level stayed under the error limit** - the same finding when
  `errors_exceeded` ended the search at its first level, worded for the limit
  rather than the latency budget.
- **Judged nothing at all** - the run ended before its first level closed
  (`stepDuration` longer than `duration`, or a hand stop seconds in). The
  engine still reports the section, because "the search measured nothing" is
  the finding that says to lengthen the run or shorten the step - but the card
  must say that rather than claim a measurement at a number of virtual users it
  never reached. It is checked first, ahead of every stop reason.

A level the search re-measured after one bad measurement appears **twice** in the
table, at the same number of virtual users; that repeat is the audit trail doing its job,
so the rows are keyed by index rather than by level. The second and later rows
of a number of virtual users carry a muted "re-measured" beside it, so a repeat
reads as the search checking itself rather than a duplicated row; the first
occurrence and a level measured once are unlabelled. A `stopReason` this build
has no words for renders under its raw key, as `ThresholdVerdict` does with an
unknown metric.

The levels table gains an **Errors** column (`levels[].errorPct`, percent) when
at least one level carries it; a level over `maxErrorPct` is tinted
`text-warning-text`, as a p99 over budget is. A run stored by an engine that
did not judge errors has none of `errorPct`, `kneeErrorPct` or `maxErrorPct`:
it keeps three columns, tints nothing and says nothing about errors, because an
absent share is not the claim "every level was clean". The `errors_exceeded`
detail names the limit from `maxErrorPct` when present and reads generically
when not.

A **Samples** column follows (`levels[].samples`, a count through
`formatNumber`) when at least one level carries it: the completions the level's
p99 was read from. A level of refused connections records no latency, so its
p99 is 0 because nothing was measured, and `0` in this column is what tells
that apart from a service that answered instantly. A level without the field,
on a run stored before the engine reported it, gets an empty cell and never a
`0`, and a run with none of them keeps the table without the column. The
rightmost column shown sits flush and every other one keeps the `pr-3` gutter.

Every latency in the card (headline, knee, budget, table) is `formatLatency`, so
a level at 1234 ms reads `1.23s` like the rest of the app; the same holds for
`TransactionsSummary`. No module declares a `formatMs` or `formatSeconds` of its own
(`lib/no-local-format-ms.test.ts`), and no component calls `toFixed` on a latency, rate
or percentage: `lib/no-hand-built-numbers.test.ts` fails on a `.toFixed(` outside its
short allowlist (the MCP run-compare text and the `Nx baseline` multiplier). A fixed or
trimmed number of decimals is `formatFixed` / `formatTrimmed`, so the decimal mark follows
the user's locale (`lib/format-number.locale.test.ts`). A size in bytes is `formatBytes`
there too, the only byte-size formatter (1024-based `KB` / `MB` / `GB`, so 3 GiB reads
`3.0 GB`); a byte rate is `formatByteRateParts`, decimal.

## Contract Coverage (`components/shared/ContractCoverage.tsx`)

Which operations of a collection's bound OpenAPI contract a run exercised, and
which of their declared responses it saw (`RunReport.coverage`, issue #629).
Shown in the history detail's Overview beside `ThresholdVerdict`, and above the
step list in `ScenarioRunView`; the Spec tab carries a one-line version of the
same numbers for the collection's last run (`SpecCoverageLine`).

The other half of "did this run prove anything". `ThresholdVerdict` beside it
says whether the run met its budgets; this says whether it touched the contract
at all, which a run where every assertion passed can still have failed to do.

**Rows are rendered in the order the engine sends them** - uncovered first,
document order within each group. Re-sorting here would be a second opinion
about which operations are the finding, and the two could disagree.

Same absent-vs-zero discipline as `ThresholdVerdict`: an absent `coverage`
renders **nothing**, because "not measured against a contract" is a different
claim from "covered none of it", and it is why a run of an unbound collection
looks exactly as it did before coverage existed.

The uncovered chip is **warning-toned, not destructive**. An operation nobody
called is a gap in the run, not a failure of the system under test, and painting
it destructive would put it in the same vocabulary as a failed budget. The same
goes for an operation whose every send failed to connect: the engine counts it as
covered, so the chip turns warning-toned and the summary says how many operations
got no response. The card
also states that its numbers are counted on every send rather than drawn from the
stored sample - it sits among figures that *are* sampled, and a reader has no
other way to tell them apart.

## Sampled Schema Validation (`components/shared/SampledSchemaValidation.tsx`)

Whether the responses a run checked matched the schemas its bound contract
declares (`RunReport.schemaValidation`, issues #682 and #681). Shown directly
under `ContractCoverage`, which it answers the second half of: coverage says what
the run exercised, this says whether what came back honoured it.

**Both run modes render this one block, and its numbers do not mean the same
thing in each.** A load run defers validation to run end over the bounded
reservoir it stored, because it refills concurrency on every completion; a
collection run sends one request at a time and checks every step. So the payload
carries `exact` and the card's scope sentence follows it - "over every response
this run produced" against "over the responses it kept, coverage beside this is
exact". An absent `exact` renders as sampled, because that is what a report
written before the field was, and overclaiming exactness is the worse error.

It renders in every surface that carries a run report: the history detail's
Overview, and a scenario run's own view above the step list. A rollup present in
one and not the other reads as a missing block rather than a scoping decision.

Same absent-vs-zero discipline as `ContractCoverage`: an absent block, or one
that walked no responses, renders **nothing**. A run whose responses were never
checked did not pass a contract.

Reasons for a response that could not be checked come from
`uncheckedReasonText`, the wording the response viewer already shows for a single
response - one copy, so an aggregate row and a user's own response cannot come to
describe the same code differently. The chip is red only for a real schema
failure; a run that checked nothing stays neutral rather than borrowing the
vocabulary of a failed budget.

The file keeps the name it was given for the load-mode block it was written for.

## Test Validation Summary (`components/shared/TestValidationSummary.tsx`)

Whether a load run's own `pm.test` assertions passed (`RunReport.testValidation`,
issue #726): responses tested, assertions passed and failed, the assertion success
rate, and - for the surfaces that have nowhere else to put them - the named failures.

**The labels name the unit** (issue #2144): the engine's `samplesTested` counts
*responses* and `testsPassed` / `testsFailed` count *assertions*, which are different
quantities (a script with three `pm.test` calls over 100 responses makes 300), so the
cells read "Responses tested", "Assertions passed", "Assertions failed" and "Assertion
success rate". The wire keys are unchanged. Every count goes through `formatNumber`.

**The denominator is one of two optional props** (#2824). `totalRequests` is the
single-request run's: one line, "Tested N of M requests. The rest had no response or
were not kept." - or "Tested all M requests." when nothing was left out. The gap is
deliberately not worded as "displaced": a request that errored before a response has
nothing to test, so `M - N` is not `sampling.responseSamplesDropped`. It is omitted
when the prop is undefined or 0, never "of 0". A scenario load run passes `replayScope`
instead (`replayScopeOf` in `run-assertions.ts`: the sum of `deferred` over each step's
`script.*` elements, and how many steps had any) and the line reads "Replayed 23 of the
2,270 responses that carried a test script (1 step)." - or "Replayed all ..." - because
most requests of a sequence carry no script, so they are not "not kept". With the
Assertions card beside it the line adds "Assertions that ran inline are counted under
Assertions." `replayScope` wins when both are passed; `OverviewTab` withholds
`totalRequests` for a scenario report, so one with no deferred script (or stored before
`deferred`) states no denominator. The line states no uniformity; `SampleRetentionNote`
beneath it stays the one place that does, because only it reads
`responseSampleBudgetSpent` and so never claims a uniform sample for a run whose byte
budget was spent.

It is the **assertion** counterpart of `SampledSchemaValidation` above it: that
one judges a response against the contract the run was planned with, this one
judges it against the scripts the run carries. `ThresholdVerdict` is the third
reading of the same run and the aggregate of both, since a script sees one
response at a time and cannot assert a p99.

The history detail's Overview renders it, and the dashboard shows that same
Overview for a finished run (#2220). The dashboard is mounted **only while a run is being watched**,
so were it the only place to show the Overview, a run reopened from History would show thresholds, status codes and schema verdicts and never say whether its
assertions had run at all: a run that failed 13 of 100 sampled test executions
would read exactly like one that asserted nothing, precisely where someone audits
results.

**The named failures are the History half only.** The engine records them on a
*synthetic* result row - `run_manager.cpp` appends one `Result` whose
`trace_data` is `{failures[], failureCounts[], failuresDistinct, totalFailed,
totalPassed}` (#3127), with `statusCode 0` and
the error "Script validation failures" - which rides in `report.results` beside
the real samples. The dashboard lists each failure inline beside that row, so it
passes the aggregate alone. History cannot: its Samples tab would draw the row as
a status-0 card with no request behind it, so `main/test-validation.ts` lifts the
failures out for the Overview to name and filters the row out of the samples
list. `trace.failures` is what identifies the row - no captured request carries
it, and the status-0 code alone would also match a real connection failure.

**Each distinct failure is listed once, with how often it failed (#3127).** A script that
fails the same way on every sampled response is one entry, not one per sample:
`failures` holds each distinct message (at most 10, first seen first), `failureCounts` is
parallel to it, and `totalFailed` / `totalPassed` count every occurrence. A count above 1
reads `x3` beside its message (`OccurrenceCount.tsx`, the one spelling of that cue;
`extractTestFailures` hands the component `counts`, which default to 1 each, so a row stored
before the engine deduplicated renders as it did).
The "Failed tests (N)" heading is `totalFailed`, occurrences, so it can exceed the number of
lines under it. When `failuresDistinct` exceeds the list the card says "Showing N of M
distinct."; a row without `failuresDistinct` keeps the older "Showing N of M." against
`totalFailed`, since each of its entries stood for one occurrence. The Samples tab never
draws the row, so `SampleTraceDetails`'s own "Failed tests" list does not receive these
counts.

**The replay's console lines close the card (#3127).** The replay runs every sampled
response's scripts and the engine keeps what they logged, whatever the verdict, as one
bounded distinct sample: `testValidation.console` (`{level, text, count?}`, the first 10
distinct lines, each cut at 500 bytes, `count` present only on a line logged more than once)
and `consoleDropped` (occurrences a full list turned away). `ReplayConsole` draws them under
"Console from the post-run replay over N sampled responses", N being `samplesTested`, through
`ElementMessages`, so the lines take the same level tones, a repeated line the same `x3` as a
failure above it, and the dropped cue reads the same, "N more console line occurrences not
shown", as under an inline script row. Both keys are absent when nothing was logged and on
a report from before the field, which renders no block. They sit inside `testValidation`,
so a replay that logged and asserted nothing else is still a card of zeros with its lines
under it. A scenario run's `testValidation` has none: its lines are per step, on the Steps
tab (`scenario.steps[].tests.console`). The run export stays counts-only.

Absent-vs-zero, as everywhere in this family: a run that asserted nothing has no
`testValidation` at all and renders **nothing**. A shorter failure list than
the count it lists says "Showing N of M" rather than reading as the whole set.

## Scenario step cells (`components/shared/ScenarioStepCells.tsx`, `SequenceBadge.tsx`)

What a scenario load run's step table is drawn from, shared so a step reads the same
while the run is live and after it (#2823): `StepLabelCell` (position, an optional
method badge, name, an optional engine label such as `tools/call search`, #3829),
`ExecutedCell` (with the "(n short)" marker only when handed an `expectedPerStep`),
`ErrorsCell` (red at non-zero, the HTTP-error / no-response split on hover when both
halves are known) and `ScenarioFacts` (virtual users, iterations started,
completed, and abandoned while non-zero). `SequenceBadge` is the neutral outline
"SEQUENCE" chip that stands where a method sits; History's request bar and the live
`LiveSequencePanel` both wear it. History's `ScenarioStepsTab` supplies the finished
report's rows; the live panel supplies a gate frame's. They import `pluralize` from
`modules/dashboard/utils/format`, the direction every file in `components/shared`
already takes.
