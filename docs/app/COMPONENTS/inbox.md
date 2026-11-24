---
description: >-
  The webhook inbox module of the Vayu desktop app: the UI over the engine-hosted listener that records the requests sent to it.
---

# Webhook Inbox (`modules/inbox/`)

The receiving half of the app (issue #480): an engine-hosted listener that records the requests
sent to it, so building a webhook consumer needs no cloud tunnel. Engine contract:
`docs/engine/api-reference/inbox.md`.

- `index.tsx` (`InboxView`, screen `"inbox"`) - start/stop/clear/delete, the URL with a copy
  control and a text **Copy for agent** button (`inboxReference`, #2047), the running/live badge, the `Notify` toggle (`NotifyOnCaptureToggle`, whose two gates
  are `capture-notifier.ts` below), the inbox switcher, the capture list and the detail pane. Clear
  (Eraser) empties the capture list; Delete (bin) ends the inbox itself, so the two adjacent
  destructive controls do not share an icon. The first fetch of the capture list shows a
  `ListSkeleton` (the count dashes and Clear waits) rather than "No captures yet.", which an
  in-flight query would otherwise be indistinguishable from (#1928). The switcher is a
  `Select` in the header, shown only when more than one inbox exists (with one, it could pick only
  what is already on screen) and ordered by port - the engine lists in map order, which is not
  stable across polls, and a switcher whose entries move under the pointer is worse than none. An
  inbox record carries no creation stamp and does not gain one - #555 answered that, and the
  Services drawer orders by port for the same reason. Every mutation this tab owns reports its
  failure as a toast (`reportFailure`), which is the one discipline the whole inbox lifecycle
  follows; Stop and Clear pass an `onError` too (#555). The header's copy control answers
  to the same discipline through the shared `useCopy` (see [Services](services.md#services-modulesservices)) -
  it is not a mutation, but it is the other thing here that can fail, and it reports success
  only once the write has landed (#565). The URL button is an icon button, so a landed copy swaps its glyph to a check
  and raises no toast (`useCopy({ feedback: "icon" })`, #2315); the "Copy for agent" text button beside
  it keeps its own plain `useCopy()` and toasts.
- `InboxStartOptions.tsx` - the secondary start path (issue #2367): an **Inbox options** icon button
  beside every Start (the tab's empty state and its stopped-inbox **Start new**, and the Services
  drawer's **New inbox**) opening a dialog with the **Allowed origins** box. The one-click start
  stays one click and sends `{}`; the dialog is the only way a list reaches the engine. It owns its
  own start mutation, since the three places that offer it react to a start differently (`onStarted`),
  and shows an engine refusal as a `Callout` in the form. The header of `InboxView` states the
  policy the engine echoes (`Origins: any` or the list) for the default too.
- `CannedResponseControls.tsx` - all four fields the engine serves: reply status and delay inline,
  body and headers behind a disclosure that opens on its own when either is set. It showed status and
  delay only, so a reply body or header set configured by an MCP tool or a bare curl was invisible
  and uneditable here (issue #556). Its own component so every field can be a draft (typing `50` on
  the way to `500` must not push a 50 at the next caller) and so re-seeding them from the engine is a
  remount - `InboxView` keys it on `cannedResponseKey`, which covers all four - rather than a
  `setState` inside an effect. Apply sends the whole response, not a diff: `PUT /inbox/:id` is a
  merge-patch, so an omitted `headers` is how a header the user deleted comes back. On a **stopped**
  inbox every control is disabled and says why - the route still merge-patches a stopped record, so
  a live-looking panel there is an edit accepted for a reply nothing will ever send. Apply reports
  through the save store like every other explicit save (issue #1450): it dims once the drafts match
  what the engine last served, and a press moves the Dock through its Saving/Saved or error states
  instead of a bare success-free toast; the reply is also a registered `useDraftSaveContext`, so a
  quit mid-apply or Ctrl/Cmd+S reaches it. The hint under the controls is a full-width line, never a
  sibling in the controls' own flex row, per `docs/design-system.md`'s hint-stacking rule. The reply
  headers are
  [`KeyValueEditor`](shared-key-value-editor.md#shared-keyvalue-editor-componentssharedkeyvalueeditor) rows, with no `variables` scope
  passed - a canned reply is echoed verbatim, so there is nothing to resolve. The primitive
  is mountable outside `RequestBuilderProvider` (#564), and the table's trailing blank row stands
  in for an "Add header" button. Header names complete
  from the same `STANDARD_HEADERS` list as the request builder's Headers tab (#1449) - the mount
  had reused the primitive without its header-specific suggestion prop.
- `CaptureRaw.tsx` - the detail pane's Raw view (issue #3109). A capture whose `bodyEncoding` is
  `base64` is not printed: the view shows a "[N of binary data, not shown as text.]" line from
  `bodyBytes` (naming the kept prefix when the body is truncated), beside **Download body**, which
  writes the exact stored bytes typed and named by the Content-Type (a failed save is a toast, a
  cancelled one is silent, #3246), and **Copy as base64**. The
  bytes come from `captureBinaryBytes` (`utils.ts`), which reuses `decodeResponseBody` and never
  throws, so a body that does not decode leaves Copy and drops Download. A text body prints as it
  always did. There is no hex view: the Download is the way to inspect the bytes.
- `capture-notifier.ts` - the OS notification a capture raises while Vayu is in the background
  (issue #1388), and the two gates it passes first: the global opt-in, read by `services/notify.ts`
  for every kind, and this inbox's own `Notify` toggle in the header, read here and off by default.
  Both, because a webhook source sets the rate and a busy inbox must not be made loud by the setting
  the user turned on for run results. One window of captures is one notification naming how many
  arrived, through `createThrottledBatcher` with its leading edge off - a leading edge would post
  once for the first capture and once for the rest, which is two notifications for one burst. The
  window is trailing for that reason and not a setting: it is a property of what a notification is
  for, not of how fast this user's source is. A click opens the inbox tab the capture landed on
  (`target: { view: "inbox", inboxId }`), which is why the tab retargets rather than opening a
  second one. The toggle is stored per inbox in `inbox-notify-store`, not on the engine's record:
  the engine's inbox is in-memory state that does not outlive its process and does not act on the
  flag.
- `CaptureDetail.tsx` - one capture, rendered through `UnifiedResponseViewer` and `buildRawRequest`.
  Its header row carries a **Copy for agent** icon button (`captureReference`, #2047).
  A capture is an exchange with no response, which the viewer reads as request-only: the main
  pane is a **Body** tab holding the capture's body, sized to the card (#3492); a request you
  received should read like one you sent. A base64 body reaches the pane as its decoded bytes
  (the "Binary data" pane, or the image), never as base64 text, and bytes that do not decode
  fall back to the Raw view's placeholder line (shown as text whatever type the capture
  declared, so its content-type is left off that request), and an empty one reads "No body".
  The list's `CaptureRow` shows a long path through `truncateUrl`, so the tail that tells
  captures apart survives, with the full path in a `Tooltip` on the row that opens on hover
  and on focus; a path that is not cut has no tooltip.
- `useInboxLive.ts` - the view's reference to the stream, not the stream itself. It retains the
  addressed inbox in `services/inbox-watch-service.ts` while the tab is mounted, renders the
  `watching` / `stopped` that service reports, and offers its Resume. Releasing the reference does
  **not** close the socket unless nothing else wants it: the tab is mounted only while it is the
  active one, and a stream that went away with it took the `Notify` toggle's whole purpose with it
  (issue #1400).
- `services/inbox-watch-service.ts` (outside this module, beside `load-test-service.ts` and for the
  same reason) - the sockets. One `EventSource` per watched inbox, opened for the union of the
  inboxes a mounted view has retained and the running inboxes whose `Notify` toggle is on, capped at
  `MAX_INBOX_WATCH_STREAMS` (8) with the inbox on screen always given a slot. Each stream owns its
  `CaptureNotifier` and merges arriving captures into the same query cache `useInboxCapturesQuery`
  fills, not a second list beside it - two lists would need reconciling on every clear, and whichever
  the detail pane read would decide which was true. The reconnect is the service's own, not the
  browser's: `EventSource` treats a non-200 as fatal, and a reconnect landing inside the engine's
  dead-socket window meets a `409`, so a single drop would end the stream for the life of the tab.
  It retries with a jittered backoff, resumes from the last capture id it saw (`?lastEventId=`, since
  no API sets a header on a fresh connection), and once the retries are spent reports `stopped` so
  the surface can say so and offer a Resume rather than leave the badge reading `Running`. A stream
  also ends because somebody *stopped* the inbox - from the drawer, an MCP tool or curl - and that
  close is indistinguishable from a drop, so before spending a retry it refetches the inbox list and
  reads the record: gone or `running: false` means no reconnect, and the surface reflects the stop
  inside the close instead of on the next `SERVICES_POLL_INTERVAL_MS` poll. A refetch that failed
  leaves the last good list, which still says running - a blip must still retry. **What running out
  of retries costs depends on who is holding the stream** (issue #1403): a stream a view has retained
  waits for the Resume that view offers, and one held only by the standing want - which no surface
  renders, so no surface can offer anything - is handed one fresh budget
  `INBOX_LIVE_BACKGROUND_RESUME_MS` (60s) later, from a timer the service arms as it gives up, and
  again a minute after that if the new ladder is spent too. The bound is untouched: each resume buys
  one ladder, so a background stream costs at most six attempts a minute against an engine that keeps
  refusing, where a burst spends six in about fifteen seconds. The timer is the service's own rather
  than the watcher's list read, because that read stops happening in exactly the case this is for -
  `refetchIntervalInBackground` is unset (`lib/query-client.ts`), so the inbox poll pauses in a hidden
  window - and a minute is also the bucket Chromium aligns a long-hidden window's timers to, so a
  shorter cadence would not fire sooner there. The wanted set the resume runs against is therefore
  the last one the engine gave: an inbox stopped elsewhere meanwhile costs one refused connection,
  after which the listener-is-gone check above ends the stream without spending the budget. **Above
  the cap there is no such recovery**: the ninth notify-enabled inbox is left with no stream at all
  until a slot frees up, so it is not waiting for anything. Both cases - a stream that gave up, and
  an inbox the cap left out - are what `getSummary()` / `subscribeSummary()` report (issue #1412),
  the one accessor that answers for every inbox at once rather than for the one a view is showing.
  `stalled` there is held until a connection actually opens rather than cleared when the resume
  fires, so a stream that keeps failing reads as one standing state instead of blinking once a
  minute.
- `services/os-icon.ts` (also outside this module, for the same reason) - a capture arriving while
  the window is not in front is counted on the app's own icon too: a badge on the macOS Dock, a
  drawn count on the Windows taskbar overlay, nothing on Linux (issue #1364). This side only reports
  that a capture landed; whether it counts is main's, because only main tells a minimized window
  from one behind another application. The count clears when the Inbox is on screen, which
  `hooks/useOsIcon.ts` reports on that tab becoming active *and* on every window focus while it is -
  captures keep counting while the user is away from a window already showing the Inbox, so the
  second half is what stops a badge outliving the list it counts. Focus alone does not clear it.
- `hooks/useInboxWatchers.ts` (mounted once in `App.tsx`, beside `useHostSleepRecorder`) - the
  standing answer to which inboxes the service should hold, recomputed as the engine's list and the
  toggles change, plus the pruning of notify preferences whose inbox the engine no longer lists. It
  observes the inbox list only while at least one inbox may notify: that list polls every
  `SERVICES_POLL_INTERVAL_MS`, and a root observer nobody reads is what #1150 removed.
- `hooks/useRunWatchers.ts` (mounted once in `App.tsx`, beside
  `useMcpDataInvalidation`) - the app's answer to a run an MCP agent started (issue #1419). Main
  names the run and which service owns its stream on the `mcp:data-changed` event; this enters the
  same `startMonitoring` path the dashboard does, so the taskbar bar, the wake lock and the finished
  notification are the same for an agent's run as for the user's. For a load run it also reads the
  run's row and sets the dashboard's config and request from its snapshot (issue #1935). A `run`
  event that is not a start attaches nothing.
- `useInboxDeletion.ts` / `DeleteInboxDialog.tsx` - deleting an inbox (issue #553), shared with the
  Services drawer so the two surfaces cannot disagree about when the confirmation appears or what it
  says is at stake. An inbox holding captures confirms and names their count; one holding none is
  deleted outright. `capturesAtRisk` takes the higher of the record's polled `captureCount` and the
  capture total a surface already holds - the record lags a services poll behind the live stream, so
  trusting it alone would let the tab destroy a capture it is displaying.
- `utils.ts` - `captureUrl`, which rebuilds the absolute URL from the stored path and raw query, and
  `cannedResponseKey`, the remount key above.

**The capture list is paged, and says so.** The tab fetched one `INBOX_CAPTURES_PAGE_LIMIT` page and
read the engine's `hasMore` nowhere, so an inbox holding its full retained ring showed the newest 50
and was indistinguishable from one that had received 50 (issue #556). A `Load more` appends the next
page and a `Showing N of M` line makes the cut visible. The offset is the accumulated length rather
than a page counter, and that is exact rather than approximate: the stream prepends every capture
recorded since the last fetch, so what is on screen is always the newest N the engine holds and the
next unseen one sits at exactly N. `hasMore` is the page's answer **and** the accumulated one - a
refetch of the first page reports "this inbox holds more than one page", which says nothing about
whether the list has already loaded it.

**One cache entry, three writers.** The first fetch, the load-more pages and the live stream all
write `queryKeys.inbox.captures(id)`, so every write is a union by capture id (`mergeCaptures` in
`queries/inbox.ts`, with `mergeCapture` for the single streamed one). That is also why a fetch reads
the cache *after* it resolves and merges into it: replacing meant a capture the stream delivered
while the GET was in flight was overwritten when the GET landed, vanishing from a list that had
already shown it. The one writer that must not union is a **clear** - it empties the cache entry
before invalidating, so the refetch has nothing to merge the destroyed rows back onto.

A capture whose body the engine only kept a prefix of is marked in the row as well as in the detail
pane: scanning the list for the payload that broke something, a row printing bytes alone is a row
that does not say its body is a prefix.

**One tab, not one per inbox.** An inbox is engine-process state with no id worth restoring into a
tab, and the engine permits a single live stream per inbox (each holds a pool thread), so a surface
watching several at once would spend threads on lists nobody reads. The tab is a singleton and is
never dirty - both stated explicitly in `tabs-store`, since a *missing* answer reads the same as
"clean" and is what once made a dirty Settings tab LRU-evictable
(`components/layout/tab-type-coverage.test.ts` guards all three switches).

**One tab, but a retargetable one.** The tab's own `entityId` is the address of the inbox it shows,
and `openTab` on an already-open singleton with a different `entityId` moves that tab rather than
just focusing it (`tabs-store`). Both writers go through it - a drawer row and the header's
switcher - so there is exactly one record of which inbox is on screen. Before this the tab had no
address at all: it showed whichever inbox its own start mutation had last named, falling back to
the first the engine listed, so a row labelled "Open inbox on port B" opened a tab showing A
(issue #554). An address the engine no longer lists (a tab restored across an engine restart)
falls back to the lowest-numbered port.

**Entry points:** the **Services** drawer view, which lists every inbox and opens this tab (issue
#502), and the palette's `Inbox` entry. The welcome Launcher's tile is `Services`, not
`Inbox` - it teaches where the whole family of local services lives instead of opening one tab -
and the Dock's running-services indicator reveals the same view. Without the Services view the Launcher tile would be
the *only* way in, and a running inbox would be invisible once its tab was closed. The **OS** Dock or
taskbar icon - not the in-app Dock this paragraph otherwise means - is one more pointer back: its
unread count is what says a capture arrived at all when no Vayu window is in front (issue #1364).
