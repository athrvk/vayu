---
description: >-
  The services module of the Vayu desktop app: the drawer view for the local services that keep listening after you switch tabs.
---

# Services (`modules/services/`)

One home for the app's **local services** - the things that keep listening after you switch tabs
(issue #502). Rendered as the `services` drawer view; the Dock's indicator and the welcome tile
both reveal it.

- `ServicesPanel.tsx` - the view. Three groups: **Webhook inboxes**, **OAuth issuers** and **Mock
  servers**, each with a one-sentence empty state saying what the service would give you - this
  drawer is also the features' discoverability. The first two carry their own start affordance in
  the group header; the third deliberately does not (see below). An inbox row opens the
  inbox *tab* (the drawer lists, the tab shows the captures) and carries copy, stop (running rows
  only) and **delete** (every row) in one hover-revealed `⋯` menu, `RowActionsMenu` like every other
  row in the app - these were the last rows painting their actions as always-visible icon buttons,
  which on a 32px row truncated the URL that is the row's own payload (issue #1690); the URLs those
  buttons carried in tooltips ride the items' `hint`, so they read without hovering; an issuer row expands in place to its discovery URL (the one an OAuth config's "Discover from the server URL" field takes), metadata, token and authorize URLs,
  a copy for the HS256 signing key, its configuration in one line, a live `failureMode` switch, and
  - in `slow` only - the delay that mode answers after, committed on blur rather than per keystroke.
  The inbox group's affordance is **New inbox** (Plus), matching **New issuer**: it always mints a
  new listener, and as a Play labelled "Start inbox" beside a stopped row it read as "restart that
  one", which nothing here does (issue #553). Beside it is **Inbox options**, the secondary start path
  that sets the inbox's allowed origins (#2367, `modules/inbox/InboxStartOptions.tsx`). **An inbox or
  mock row marks a restricted CORS policy** (`2 origins`, the list in its `title`) and says nothing for
  the default: the row is 32px and its payload is a URL, so "Any origin" on every row would only
  spend the URL's width repeating what an absent mark already says. The tabs state the policy either
  way.

  **An inbox row also says when its `Notify` toggle is not in effect** - a *Not notifying* chip
  (issue #1412), from `useInboxWatchSummary` over the watch service's `getSummary`. Two causes, one
  chip: a stream that gave up and has not opened since, and an inbox `MAX_INBOX_WATCH_STREAMS` left
  without a stream at all. They differ in what will fix them - the first is retrying on its own and
  needs nothing, the second will not change until an inbox stops or a toggle goes off - and that
  difference is this paragraph rather than a longer chip: the row is 32px, and the cause spelled out
  filled it and truncated the URL beside it to two characters. It is **this** surface rather than the
  inbox tab because the toggle exists to speak while the user is somewhere else: a note only the
  inbox tab renders is a note they have to go looking for. It appears for neither an inbox whose
  toggle is off (there is no promise to break) nor one that is stopped (it captures nothing).

  **Mock servers (#481 phase 2) have no start affordance here, and that is not an omission**: a
  mock needs a collection to serve, and this drawer has none selected. The collection header owns
  the start (`CollectionDetail/MockServerControl`); this group owns the list, so a mock started from
  any collection - or from an MCP tool, or curl - can be found and stopped where every other running
  listener is. A mock row leads with the **collection name** (two mocks of one collection differ
  only by port) and **opens the `mock-server` tab** (issue #481 phase 3, `modules/mock-server/`)
  rather than expanding in place - the same shape the inbox row already used, taken once a mock also
  kept a live activity log and not just a start-time route table. Stopping a mock removes it from
  the list, like an issuer and unlike an inbox, because a mock holds nothing that outlives its
  listener.

  **Every service row offers "Copy for agent"** (#2047) beside its URL copy: the inbox, issuer and mock
  server references (`lib/agent-reference.ts`), placed before the destructive Stop or Delete, with
  the line as the item's `hint`. The reference names the service by port and id and carries neither
  the URL nor the signing key.

  Row semantics, all from issue #555. An inbox row **leads with `Port NNNN`** and demotes the URL
  behind it: the port is the part that varies and the part a user names an inbox by, while three
  full URLs are three near-identical monospace strings differing in one digit. The URL is still on
  the row and also rides the copy control's tooltip, which says so when the inbox is **stopped** -
  a stopped inbox's URL copies perfectly well and then refuses connections, a long way from the
  cause. Every copy control here goes through the shared `useCopy` hook (`hooks/useCopy.ts`), which
  **awaits** `writeText` and toasts the failure: the promise rejects on a denied permission or an
  unfocused document, and a `void` call with an unconditional "copied" reports a refusal as a
  success while the rejection goes unhandled. It is a shared hook rather than a local one because
  the inbox tab's header offers the same URL and kept that exact defect after the drawer's fix
  (#555 item 6, then #565 item 1) - a hand-rolled copy does not receive the primitive's fixes. A row's
  `⋯` menu items toast; the icon buttons inside an expanded issuer (discovery, metadata, token and authorize URLs, signing
  key) each own a `useCopy({ feedback: "icon" })` and swap their glyph to a check instead (#2315). Rows are ordered **by port**, because the engine lists them in map order (not stable across
  polls) and the record carries no creation stamp; the inbox tab's switcher orders the same way.
  Creating one **toasts and flashes** the new row for `TIMING.ROW_FLASH_MS` - it lands wherever its
  ephemeral port sorts, not at the end. The activator's verb is `sr-only` text **prefixed to** the
  row's content, never an `aria-label`: a label *replaces* the content in the accessible name, so
  the URL, `Stopped`, and the reachable-beyond-this-machine badge were all inaudible and a stopped
  row read identically to a running one.

  **No user-editable inbox name** (#555's stated decision point, answered *no*). A name would be an
  engine field - `InboxInfo` carries none, so it would need storage, a `PUT /inbox/:id` key and a
  wire-shape change - to label something whose whole identity is already the port it holds. `Port
  NNNN` ships instead and needs nothing from the engine. Revisit only if inboxes ever outlive the
  engine process, where a port is no longer a stable name.
- `NewIssuerDialog.tsx` - the start form: token lifetime, failure mode (plus its delay), a JSON
  claims box and an optional resource scope. Everything but the scope is validated before it is sent, because the engine refuses a bad config
  with a `400` rather than falling back to a default, and a claims typo is otherwise invisible until
  a token comes back without the claim; the scope's grammar stays the engine's, whose `400` the
  dialog shows. Every refusal **names its bound in words**: a reddened field
  beside a greyed-out Start says something is wrong and never which field or why, and `aria-invalid`
  alone announces "invalid" with no correction. Mounted only while open, so the mount is the reset.
- `useRunningServices.ts` - `useRunningServices()` and the count derived from it, shared by the
  drawer, the Dock and the main process. One place because the three lists disagree on their own
  terms: a stopped inbox stays listed with `running: false`, while a stopped issuer or mock server
  is gone from the engine's list entirely - and because a **disconnected engine is running none of
  them**, which is the gate this hook holds so that no caller renders a green count off a stale
  cache (issue #555). The gate is `useEngineServing()`, which reads `selectKnownEngineStatus` so a
  crash the sidecar reported counts before the health poll confirms it (issue #3493); the drawer
  reads it too and draws its cached rows stopped (muted dot, "Stopped", no Stop action) while the
  engine is down, rather than green or the first-run empty states. The inbox and mock-server tabs
  read it the same way (issue #3506): the inbox's cached `running` flag counts only while the
  engine is serving, and a mock-server tab, whose listing is its running flag, shows a Stopped
  badge and no Stop button. The mock-server list was
  missing from the sum until issue #792, so a mock holding a port counted as nothing. The count is
  now the list's length rather than a second sum (issue #1363): the Dock saying 2 while the close
  dialog names 3 is a disagreement no test that reads one of them can see.
  `useRunningServicesPublisher()`, mounted once in `App.tsx`, pushes that list to the main process
  on every change. The definition of "running" itself is `runningServicesIn`
  (`lib/services-stopped-by-restart.ts`), which the engine-restart notice reads too (issue #3493).

**Closing Vayu stops everything in this drawer, and says so first** (issue #1363). These services
live in the engine and the engine goes down with the app, so a close - the X on Windows and Linux,
Quit anywhere - that would stop one asks first, naming each: the inbox by its port, the mock server
by the collection it serves. Cancel leaves them running. Closing the window on macOS asks nothing
because it stops nothing: the app keeps serving with no window until Quit. The same dialog names
the run the app shows live first, a load test by its method and URL (issue #3604):
`useLiveRunPublisher()`, mounted beside the services publisher, pushes it under the same
`useEngineServing()` gate.
- `failure-modes.ts` - the four `failureMode` labels, the engine's bounds, and the row's
  one-line summary. Shared so the badge, the live switch and the dialog cannot name a mode
  differently.

**No new tab type for an issuer.** Its whole management surface fits a row plus a dialog, and a
`TabType` costs three switch statements and the coverage guard. The inbox and, since #481 phase 3,
the mock server each keep a tab, because a capture list or a growing activity log needs the width -
see [Mock Server](mock-server.md#mock-server-modulesmock-server) below.

**Data:** `queries/inbox.ts` and `queries/mock-issuer.ts`, both polled at
`TIMING.SERVICES_POLL_INTERVAL_MS`. They are polled rather than driven by this app's own mutations
alone because the MCP tools and a bare curl reach the same engine routes - an indicator that only
knew what this window started would contradict its own promise.
