---
description: >-
  Shared components of the Vayu desktop app for element tallies, warnings and banners: extractor misses, unresolved tokens, recovery and update banners.
---

# Shared: Warnings and Banners

## Element Tally (`components/shared/ElementTally.tsx`)

One element's row - which element it is and the passed / failed / missing / error / skipped
counts, tallied across a load run (issue #2144 extracted it from two hand-rolled copies).
Both `RequestElementsSummary` (a single-request run's Elements card) and `ScenarioStepsTab`
(the per-step rows) render it, so a field added to the tally reaches both.

**The row names its element (#3051).** The element's own `name` leads, with the kind in
mono beside it as secondary text; a row with no `name` (every report stored before the
engine wrote one, and an element nobody labelled) prints the kind alone, as it always did.
A collection-level element adds `from "<collection>"` (`elementOriginLabel`); a request's
own says nothing, and the word "Folder" never appears (`docs/ux-writing.md`). The
sequential run's `ElementOutcomes` list uses the same helper. Both parents key a row with
`elementRowKey` (#3101): an id repeats across levels, so its origin joins it, and a row with
no origin (a report stored before rows carried one) keys by position.

**`missing` and `error` are buckets of their own (#3051).** The engine counts one bucket per
outcome word: an extractor that found nothing is "N missing" (warning text), an element that
could not run its check is "N error" (error text), and `failed` no longer includes either.
Both are hidden at 0 and absent from a report stored before #3051, whose `skipped` and
`failed` keep what they counted then. A `required` extractor's miss fails the step, so its
bucket reads "N missing (required)" in error text, with the reason on hover. The
`ExtractorMisses` row beneath a step counts the same misses across the step's extractors.

A row with `deferred > 0` - a `script.post` the load path left to the post-run replay -
reads "N requests deferred to a post-run replay over M sampled responses - results in Test
validation" instead of "0 passed", because its verdicts live in the Test validation card, not
in the row (`replayCard` names the card when it is retitled "Sampled replay" beside an
Assertions card, #2820). M is the replay's size (#3127), which `deferred` alone does not
say: the replay judged M responses, not N. The parents pass it as `replaySamples` -
`RequestElementsSummary` from `testValidation.samplesTested`, `ScenarioStepsTab` from the
step's own `tests.sampled` - and a row with none (a step whose replay got no response, a
report that does not carry the block) reads "replay of sampled responses" as it did. Passed,
failed and skipped still print beside it when non-zero. A `script.pre` that was not
inlined stays `skipped`: it has no replay. `deferred` is absent from a report stored
before the engine wrote it, and such a row keeps the older "N passed / N skipped"
reading; there is no fallback that guesses a script from its zeros.

**An inline script row says why it failed and what it logged (#3127)** (`ElementMessages.tsx`,
drawn under the tally line). A load run keeps no trace per request, so the engine keeps a
bounded sample on the row itself: `messages` (`{kind: "error" | "test", text}` - what the
script threw, and each failing `pm.test` as `name: message`) and `console` (`{level, text}`),
the first 10 distinct entries of each with every text cut at 500 bytes, each with `count`
when it was seen more than once (absent means once), and `messagesDropped` /
`consoleDropped` counting the occurrences a full list turned away. Message lines are error
text with their kind in the gutter; console lines take their `console.*` level's tone from
the table the Console tab shares (`console-level.ts`), `warn` and `error` in their status
colours and `log` / `info` plain. A `count` reads `x3` at the end of its line, through the
`OccurrenceCount` the Test validation card's failures use; an entry without one shows
nothing there. A dropped count reads "N more message occurrences not shown" / "N more
console line occurrences not shown" under its list, so ten lines never pass for the whole set;
it counts occurrences (the engine counts every repeat of a dropped entry), so one extra error
thrown on 480 iterations reads 480, not "480 more messages". All four keys
are absent when empty and on a row from before #3127, which renders no block at all. The
run export stays counts-only. The deferred replay's own console lines (`testValidation` and a
step's `tests`, which carry `console` / `consoleDropped` and no messages) are drawn by the
same component through `ReplayConsole` (`components/shared/ReplayConsole.tsx`: a heading
naming the replay and its sample size, then `ElementMessages`).

A `lifecycle.setup[]` / `teardown[]` row carries the same four keys (#3455), as a
`LifecycleElementOutcome` (`ElementOutcome` plus them; the step-level type is not widened).
`ScriptLifecycleSummary` draws them under the row through `ElementMessages`, so a setup that
refused the run shows its failing `pm.test` and console lines on the Overview and the
scenario run view, even with no results to list. The row's own `message` is the reason beside
its phase; an empty or blank one reads as absent and the row falls back to "Failed". A
sequential run's row also carries its script's `scriptRequests` (#3633), listed under it as
`ScriptRequestRow`s in call order: the `console` sample folds repeats, so no line indexes a
record and the two are not interleaved as the Console tab interleaves them.

## Extractor Misses (`components/shared/ExtractorMisses.tsx`)

A step's extractor misses (issue #3053): "N extractor misses" in warning text with an
alert icon, rendering nothing for an absent or zero count. A miss unsets the extractor's
variable, so the step can pass while a later one sends that `{{name}}` unresolved. The
collection run's `ScenarioStepCard` and the scenario load run's `ScenarioStepsTab` both
render it, so the two run kinds word the count alike. Text with no background, not a
`Badge`.

## Unresolved Tokens (`components/shared/UnresolvedTokens.tsx`)

A step's unresolved `{{variables}}` (issue #3269), in the same warning text and alert icon
as Extractor Misses, rendering nothing for an absent, zero or non-numeric count. It is the
consequence of a miss: the extractor unset its variable and a later step sent that name as
literal text, while the step itself can still pass. The engine reports two different counts
under the one `unresolvedTokens` field, so the caller passes `unit`:

| `unit` | Counts | Reads | Where |
|--------|--------|-------|-------|
| `"names"` | The distinct `{{names}}` the step sent unresolved; absent, never 0, when none | "N unresolved variables" | `ScenarioStepCard` (collection run, live and stored) |
| `"sends"` | The executions of the step that sent one; always present, so 0 is a real "none" | "N sends with unresolved variables" | `ScenarioStepsTab` (scenario load run) |

Singular and plural follow the count ("1 unresolved variable", "1 send with unresolved
variables"). Text with no background, not a `Badge`.

## Captured Data Warning (`components/shared/CapturedDataWarning.tsx`)

Wherever a run's captured response exchanges are on screen: the run stored those
responses **verbatim**, headers included, so anything credential-shaped the
server sent is stored with them, and it is deleted when the run is
(`maxRunsRetained` is its expiry: only load and collection runs reach this
warning, and those are the runs that cap counts, while design Sends sit under
`maxDesignRunsRetained`).

Capture deliberately does not redact - consistently with design-mode traces,
which already store request headers as sent, and because a redaction guess is
wrong in both directions and gives false confidence when it is wrong the
reassuring way. This notice plus the run's own persisted marker
(`sampling.responseBodiesCaptured`) is the mitigation for that decision, which
makes a silent version of it the same as not having made the decision.

Renders nothing when the run captured nothing, and nothing on a run recorded
before capture existed (the field is absent, not zero) - the same rule
`SampleRetentionNote` follows. Both surfaces that list captured samples render
it: the dashboard's Sampled Requests and the history Samples tab.

## Stored Exchange Warning (`components/shared/StoredExchangeWarning.tsx`)

The design-mode half of the pair above, over a collection run's step list
(issue #731). A scenario run writes one `results` row per step execution holding
the whole exchange - the composed request, the headers as sent, the raw request
line, both bodies - capped only by `maxTraceBodyBytes` and kept until the run is
pruned, so the same "stored verbatim, `maxRunsRetained` is its expiry" sentence
(a collection run is counted by that cap, not by the design-Send one) applies to material the run **sent** as well as material it received. The two
notices are a pair by design: change one and read the other, the drift lesson
`NonLoopbackBadge` was written for.

`dataBound` is why it is more than symmetry. The Data tab and
[Data-Driven Runs](../data-driven-runs.md#what-is-stored) promise the file is never
read by the engine and the contract stores no cells - both true, and neither one
a promise about the cells that reach a request, which bind-before-auth (#591)
puts inside the `Authorization` header. When any listed step carries a
`dataRowIndex` the notice says the run's rows are in these steps, so a reader is
not left reconciling two true-sounding claims. `ScenarioRunView` reads the flag
off the steps rather than the report, so a live run discloses it too. Its
optional `dataFileName` prop names the bound file in that sentence (issue
#2051), from the run's snapshot; a run recorded before the field keeps the
unnamed sentence.

Silent when the surface lists no steps - nothing on screen, nothing to disclose.

## Exchange Warnings (`components/shared/ExchangeWarnings.tsx`)

What the engine did to a design send that its response does not show (issue
#3307): one warning `Callout` per `{ code, message }` of `ResponseState.warnings`,
in the order the engine found them. The message is the engine's own sentence; the
title is looked up by code (`cookie_not_sent`, `cookie_limit_reached`,
`cookie_dropped_oversized`, `cookie_dropped_too_many`) and a code the app does
not know reads "Note on this send". It takes a `className` for the band it sits
in and renders nothing for an absent or empty list. Drawn by the response pane
(`ResponseViewer`, as a band above the tabs) and by `ScenarioStepCard`; the load
run's own `warnings` list is a different surface, `RunWarnings`. A streaming
send's `202` carries none, so its band appears at the end-of-stream swap, when
the provider replaces the live rows with the run's stored trace (issue #3315).

## Recovery Banner (`components/shared/RecoveryBanner.tsx`)

The one place the user is told the engine restored or replaced their database
(issue #922). A database the engine judges corrupt is **moved aside** (issue
#984) and either the `.bak` backup is restored over it or a new empty database
is created, so the daemon starts instead of crash-looping - and until this
banner the whole record of that was two lines in the engine log, with the app
coming up looking like a fresh install. Only `deleted_corrupt` (an engine older
than #984, or one whose rename failed) means the file is gone.

`HEADLINE` and `DETAIL` are `Record`s over the outcome union, so an outcome the
engine adds without copy here is a type error. Whenever the record carries a
`quarantinedPath`, the banner also names that file, says what undoes the
recovery - quit Vayu and copy it back over the database file, with its `-wal` and
`-shm` when it has them (issue #2420; the engine's account is
[architecture.md](../../engine/architecture.md#restoring)) - and gives
`sqlite3 <path> .recover` for a file that really is damaged. The engine judges a
file corrupt only on `SQLITE_CORRUPT` or `SQLITE_NOTADB`; a locked, full or
read-only database is refused at startup instead of quarantined, so no banner
describes one.

It reads `engine-store.recovery`, which `queries/health.ts` writes from the
optional `recovery` node on `GET /health`. Absent means a clean start, which is
also what a genuine first run gives, so the banner renders nothing in the
ordinary case; the engine never reports the node speculatively (see
[db-schema/startup-and-recovery.md](../../engine/db-schema/startup-and-recovery.md#the-recovery-marker)).

A banner rather than a toast, beside `UpdateBanner` and above it: the fact is
permanent, a user who misses it cannot get it back, and it names a path they may
want to copy. Dismissal is persisted by the record's `at` timestamp
(`stores/recovery-notice-store.ts`) rather than held in component state, because
the engine keeps reporting the record for as long as its marker file stands - a
relaunch against an already-running engine would otherwise re-announce a wipe
the user had already acknowledged. A later recovery carries a later `at` and so
is a different event.

## Update Banner (`components/shared/UpdateBanner.tsx`)

One line (`h-banner`) driven by `useAppUpdate`, which reads the main process's
download state (`update:state`, and `update:getState` on mount). On the silent
platforms (Windows, Linux AppImage) it walks `Vayu X is available.` (notify path only) -> `Downloading Vayu X… 42%`
-> `Verifying Vayu X…` -> `Vayu X is ready to install.` with **Restart &
install**. The Verifying line replaces the percentage once the download reaches
100%: the state reaches `verified` only after the installer's
build-provenance attestation checks out, which takes seconds, and a bar parked
at 100% reads as a hang.

When the attestation does not verify (issue #2372) the state is `refused`
instead, and the banner reads `Couldn't verify Vayu
X. <reason>` with **View release** in place of Restart; the whole line is also
the `title`, since `truncate` would clip the reason. No system notification is
posted for it - the `updateReady` kind says "ready". The failure lives in
`stores/update-verification-store.ts` rather than in the hook, because
Settings > Updates (`UpdatesCard`) shows the same sentence ahead of its last
check answer and mounts long after the event; the next download state that is
not `refused` clears it.

A download that fails (issue #3338) reads `Couldn't download Vayu X - <cause>`
with **Retry**, which asks for a new check. The retried download is shown from
its first state, as `Downloading Vayu X…` on an indeterminate bar, rather than
vanishing until the first progress tick; a first download, with no failure
before it, still waits for that tick.

## Non-Loopback Badge (`components/shared/NonLoopbackBadge.tsx`)

"Reachable on `<bind>`", wherever a local service bound past loopback is named. The engine already
refused to bind wide without an explicit `confirmNonLoopback`; this is the standing reminder that the
confirmation was given. One component rather than the same chip twice: the Services drawer and the
inbox tab both render it, and as two copies they had drifted to two different wordings for one fact
(issue #556). `variant="chip"` per the Badge rule - any other variant keeps its own `hover:bg-*`,
which `cn()` does not replace, so the warning fill would turn the accent colour under the pointer.
