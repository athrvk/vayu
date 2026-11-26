---
description: >-
  The change feed: how a client learns that another client changed saved data.
---

# Change feed

## POST /changes/subscriptions

Issues the id one [`GET /changes`](#get-changes) stream opens with.

```json
{ "subscription": "k3Zq...43 base64url characters" }
```

The id is 32 random bytes from libsodium, **single-use**: the first `GET /changes` that presents it spends it, whether that stream is then refused for a full feed or served, and a second `GET` with it is a `403`.
A client asks for a new one before every connection, a reconnect included.
At most 64 issued ids wait unspent (`change_feed::MAX_PENDING_SUBSCRIPTIONS`); asking for more drops the oldest.
This is a `POST` so a web page cannot send it: a page's request carries an `Origin`, which [the gate](index.md#who-may-call-the-api) refuses, so a page can neither learn an id nor open a stream.

## GET /changes

`GET /changes?subscription=<id>`: Server-Sent Events, one `change` event per committed write of a collection, a request, an example, an environment, the globals or a trash entry, whoever made it: the app, the MCP server (in-app or stdio), `vayu-cli` or a script against this API (#3420).
A client that caches those rows subscribes once and refetches what an event names, instead of polling or trusting a cache forever.

```text
event: ready
id: 1789000000000000
data: {"lastEventId":1789000000000000}

event: change
id: 1789000000000001
data: {"kind":"request","id":"req_1","op":"update","collectionId":"col_1"}

event: change
id: 1789000000000002
data: {"kind":"example","id":"exa_1","op":"delete","requestId":"req_1"}
```

**`data` of a `change`:**

| Field | Meaning |
|---|---|
| `kind` | `collection`, `request`, `example`, `environment`, `globals`, or `clientCertificate`, the last only for what changes the trash (its delete, restore and purge; a certificate's create and update are not on the feed) |
| `id` | The row's id; `globals` for the globals singleton |
| `op` | `create`, `update`, `delete` (gone from every live read: moved to the trash, or an imported example kept as a tombstone), `restore` (back from the trash) or `purge` (destroyed for good: from the trash, by retention, or a spec sync's hard delete of a live request) |
| `collectionId` | The collection the row sits in: a request's collection, a sub-folder's parent. Absent for a root collection and every other kind |
| `requestId` | An example's request. Absent for every other kind |

**What one write publishes.**
One event per row the write committed, after its transaction commits, so a write that rolled back publishes nothing.
A bulk write (`POST /import/apply`, `POST /reorder`, `POST /specs/sync`, `POST /specs/bind`) publishes one per row it wrote, in write order and with consecutive ids; a row a sync names for deletion that is already gone publishes nothing.
**A cascade is one event on the row the caller named:** deleting, restoring or purging a collection publishes one `collection` event for it, and the sub-folders, requests and examples that went or came with it (a purge's re-parenting of a live sub-folder included) ride on it, so a client refetches the tree.
A save that makes an environment active publishes for that environment only; the ones it deactivated are read off the same list.
A trash restore or purge names the entry's own kind.
A delete that finds nothing live publishes nothing.

**Ids.**
`id:` increases by one per event.
The first id of a process is its start time in microseconds plus one, so an id kept from an earlier engine process is below every id this one issues, and its resume is a `reset` rather than a replay of the wrong process's events.
An id stays below 2^53, exact as a JavaScript number.

**Every stream opens with one `ready` or `reset`**, whose `id:` and `lastEventId` say where the stream stands: `ready` at the newest id on a fresh subscription, so an `EventSource` that drops before its first change still resumes from it; `ready` at the resume point on a resume the feed still covers, followed by every change after it; `reset` otherwise.
Subscribe before the first read of the data the feed describes, so no write falls between the two.

**Resume** with `Last-Event-ID` (what `EventSource` sends on its own retry) or `?lastEventId=<id>` (for a client reconnecting by hand); the header wins when both are given.
A value that is not a non-negative integer is a `400` with code `invalid_last_event_id`, the [inbox stream](inbox.md#get-inboxinboxidlive)'s rule.

**`reset`: refetch everything.**
The engine keeps the last 1024 events (`change_feed::MAX_RETAINED_EVENTS`).
A resume from an id older than that, or from one this process never issued, opens with `event: reset`, and a connected reader that falls a whole ring behind between two polls (an import larger than the ring) is sent one mid-stream.
The stream then continues from the reset's id.
Treat it as "every cached row may be stale".

**A stream needs a subscription.**
`subscription` is the id [`POST /changes/subscriptions`](#post-changessubscriptions) issued.
Without it the answer is a `400` with code `subscription_required`; an id that was never issued, was dropped or is already spent is a `403` with code `unknown_subscription`.
Neither holds a reader slot.
A scriptless `GET` is all a web page can send without an `Origin`, so a page can neither read the feed nor fill its slots to lock the app out.

**Several readers, a bounded number.**
There is no single-reader claim: every stream reads the same feed.
Each one parks a pool thread, so at most 8 are open at once (`change_feed::MAX_READERS`); another is a `503` with code `change_feed_full` and `Retry-After: 15`, the keep-alive interval within which a closed stream's slot is noticed and freed.
The id of a refused stream is spent: ask for another.

A stream writes `: keep-alive` after 15 quiet seconds and ends when the client goes or the engine stops.
It reads only; opening one changes nothing.
