---
description: >-
  The mock server module of the Vayu desktop app: the detail surface for one running mock.
---

# Mock Server (`modules/mock-server/`)

The detail surface for one running mock (issue #481 phase 3). Rendered for the singleton
`mock-server` tab, on the same terms as [Webhook Inbox](inbox.md#webhook-inbox-modulesinbox): the Services
drawer's mock-servers row does not expand in place to a route table: that was enough while a route
table was the only thing there was to see, but a mock also keeps a live `GET /mock/:id/activity`
log, which needs a surface that can grow while it is watched.

- `index.tsx` (`MockServerView`, screen `"mock-server"`) - the mock's base URL with a copy control
  and a text **Copy for agent** button (`mockServerReference`, #2047), the collection it serves, a stop button, an **Open collection** link back to it, and (with more
  than one mock running) a `Select` switcher ordered by port, the same reasoning `InboxView`'s
  switcher follows: the engine lists mocks in map order, which is not stable across polls, and a
  switcher whose entries move under the pointer is worse than none. Below the header, two sections:
  **Routes**, the same start-time snapshot (`GET
  /mock/:id/routes`, carrying `mode`, `exampleName` and `hits` per route from Task 8's
  Examples-tab mode selection) - and **Activity**, the live feed of what the mock has actually
  served. Both poll at `TIMING.MOCK_ACTIVITY_POLL_INTERVAL_MS`: the route table's *shape* is a
  start-time snapshot, but each route's `hits` moves live as traffic arrives (drawn as a counted noun, "3 hits", "1 hit"), so it joined the fast
  interval alongside Activity rather than the mock list's slower one.
  A shadowed route (another request has its method and path, #3115) carries a `shadowed` badge and a
  line beneath it naming the request that answers instead, both in `text-status-warning-text`.
  Each section shows a `ListSkeleton` on its first fetch, and the Routes count a dash, rather than
  "Routes (0)" or "Nothing served yet" for a query still in flight (#1928). The header also states
  the mock's CORS policy on a line of its own, `Origins: any` or the origins it was started with
  (`describeOriginPolicy`, #2367); the Services drawer row marks only a restricted mock, as a count.
- **One tab, not one per mock**, and **the tab's own `entityId` is the address**, exactly as the
  inbox tab: a mock is engine-process state with no id worth restoring across a restart, and the
  address is read from the tab rather than mirrored into local state - the drawer row and this
  view's own switcher are the only two writers, so they cannot disagree about which mock is on
  screen. An address the engine no longer lists (a tab restored after a restart, or the addressed
  mock stopped elsewhere) falls back to the lowest-numbered port, the same fallback `InboxView`
  uses.
- **Entry point:** the **Services** drawer's mock-servers group, whose row opens this tab addressed
  at the mock it names rather than expanding in place (`ServicesPanel.tsx`'s `MockServerRow`, which
  carries its own **Open mock server** action) - see [Services](services.md#services-modulesservices).

**Data:** `queries/mock-server.ts`. The mock list is polled at `TIMING.SERVICES_POLL_INTERVAL_MS`,
for the same reason the inbox and issuer lists are: an MCP tool or a bare curl can start or stop a
mock this window did not touch. The route table and the activity log are polled at the faster
`TIMING.MOCK_ACTIVITY_POLL_INTERVAL_MS` instead, since traffic - and so `hits` - can change between
`SERVICES_POLL_INTERVAL_MS` ticks - see above.
