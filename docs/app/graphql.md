---
description: >-
  Sending GraphQL requests in Vayu - the query and variables editor, schema-aware behaviour, and how the body reaches the engine.
---

# GraphQL

Vayu's GraphQL body mode is a two-pane editor - a **Query** pane and a
**Variables** pane - plus a **schema explorer** that browses the endpoint's own
documentation beside them.

Pick **GraphQL** in the Body tab's mode picker. Vayu appends
`Content-Type: application/json` to the Headers tab and says so with an Undo,
because GraphQL goes on the wire as a JSON envelope
(`{"query": …, "variables": …}`) rather than as a bare document.

## The schema

The moment a GraphQL body is on screen with a URL in the bar, Vayu introspects
the endpoint. The request it sends is **your** request, composed by the engine
first: `{{variables}}` resolved, and the Auth panel's configuration applied -
including `inherit` walked up the collection chain, and OAuth 2.0. Two
environments pointing the same URL at different credentials are two different
schemas, and Vayu keeps them apart.

The badge in the Query pane's header says which state it is in:

| Badge | Meaning |
|---|---|
| **Schema** (spinner) | Introspecting. |
| **Schema** (tick) | Loaded. Completion, validation and hover are live. |
| **Schema stale** | A refresh failed over a schema that had loaded. The editors still use the older one; the tooltip says how old it is and what went wrong. |
| **No schema** | Nothing loaded. The editor still checks syntax. The tooltip names the reason - rejected credentials and an endpoint with introspection switched off are different problems with different fixes. |

Introspection happens on the body tab's own lifecycle and when you press
**Refresh**, and never leaves a run, a trace or a History entry behind. A
header you typed by hand is not part of the schema's identity, so after editing
an `Authorization` row directly, press Refresh.

## The schema explorer

Press the panel icon in the Query pane's header - or the **Browse schema**
control - to dock the explorer beside the editor.

- **Browse** Query, Mutation, Subscription and Types. Fields show their
  arguments and result type; descriptions sit beside them; a deprecated field or
  enum value is struck through, with the reason in its tooltip.
- **Search** filters across every field and type in the schema at once. Press
  `/` from anywhere in the tree to jump to the search box.
- **Insert** a row by clicking it, or by pressing Enter with it focused.

The tree is a full keyboard surface: arrows move, Right opens a row, Left closes
it or steps out, Home and End jump to the ends, and typing letters jumps to the
row that starts with them.

### What insertion writes

Inserting always leaves a document that parses. Where a field lands depends on
where your cursor is:

- **Inside a selection set that can hold the field** - it is added there, as a
  sibling of what is already selected.
- **Inside a selection set that cannot** - Vayu walks outwards to the nearest
  one that can.
- **Nowhere compatible** - it becomes a new named operation appended to the
  document.

Required arguments become `$variables`, and they are **declared** on the
operation that gained them. If that operation was the shorthand `{ … }` form,
which cannot carry variables at all, Vayu promotes it to `query ( … )` in the
same edit. Object-typed fields arrive with their scalar fields selected and the
cursor inside the braces; deprecated fields are browsable but are never selected
for you.

Selecting a **type** inserts a fragment definition on it instead.

**Subscriptions are shown and cannot be inserted.** Vayu sends one HTTP request
and reads one response, so a subscription has no transport here. Hiding the
branch would be the friendlier answer and the less honest one.

### The Variables pane is never overwritten

Argument placeholders are merged into the Variables pane only when its text is
already strict JSON, and only into keys it does not have - a value you typed is
never replaced.

If the pane holds something `JSON.parse` rejects - most often a working
`{"id": {{userId}}}` template - Vayu writes nothing into it and badges the
header instead (*"1 variable needs a value"*), naming what it could not add.
Your draft is not a thing to make room in.

## The Variables pane

The pane validates against a JSON Schema derived from the operation's
`$variable` definitions and the introspected schema, so values are checked and
completed against what the operation actually expects.

Its header badges what the text will do when the request is sent:

- **Templated** - the text holds `{{variable}}` tokens. It is not JSON at rest
  and is JSON on the wire, because the engine resolves the body before sending.
  It **is** sent.
- **Not sent** - the text is broken for some other reason, so the request goes
  out with no variables at all. To the editor both look like the same red
  squiggle; on the wire they could not be more different.

## Several operations in one document

A document defining more than one named operation gets an **operation picker**
in the Query pane's header. The spec forbids an anonymous operation beside a
named one, and a server given no `operationName` for such a document answers
with an error rather than a guess - so the picker appears exactly when the
choice becomes real. Whatever else the envelope carries (`extensions`, an
`operationName` an importer preserved) rides along through every edit.

## The context bar

The bar's **GraphQL** section carries the glanceable half: whether a schema is
loaded, how old it is, the endpoint, a Refresh, and an outline of the operations
the request defines. Browsing belongs beside the cursor that inserts, which is
why the tree lives in the editor pane and not here.

The outline reads the saved request, so it follows the editor as autosave
catches up rather than keystroke by keystroke.
